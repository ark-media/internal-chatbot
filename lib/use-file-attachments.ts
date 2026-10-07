'use client';

import { useCallback, useState, type ChangeEvent } from 'react';
import type { FileUIPart } from 'ai';
import { upload } from '@vercel/blob/client';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  UPLOAD_PATH_PREFIX,
  formatBytes,
} from '@/lib/prep-limits';
import { useFlash } from '@/lib/use-flash';

export type AttachedFile = {
  id: string;
  file: File;
};

// Composer file-picking shared by the prep and news pages: per-file and
// aggregate size limits, a count cap, and the human-readable rejection text
// the composer shows under the input.
//
// Picked files stay local until send. `uploadFiles` then pushes them straight
// to Vercel Blob (the chat request would otherwise hit Vercel's 4.5 MB body
// limit) and returns file parts carrying the private blob URLs, which the
// prep/news routes fetch and resolve server-side (lib/upload-parts.ts).
//
// `attachSuccess` is flashed on every accepted pick; a surface that doesn't
// render a confirmation banner (prep) simply ignores it.
export function useFileAttachments() {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attachSuccess, flashAttachSuccess] = useFlash(false);
  // Percentage across all files while an upload is in flight; null otherwise.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const onPickFiles = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      // Snapshot FileList into an array before clearing the input — FileList is
      // a live collection tied to the input element, so reading it after
      // setting value='' yields zero entries and the PDF never makes it to state.
      const picked = e.target.files ? Array.from(e.target.files) : [];
      e.target.value = '';
      if (picked.length === 0) return;

      const accepted: AttachedFile[] = [];
      const rejected: string[] = [];
      let total = files.reduce((n, f) => n + f.file.size, 0);
      for (let i = 0; i < picked.length; i++) {
        const f = picked[i];
        if (!f) continue;
        if (files.length + accepted.length >= MAX_FILES) {
          rejected.push(`too many files (max ${MAX_FILES})`);
          break;
        }
        if (f.size > MAX_FILE_BYTES) {
          rejected.push(`"${f.name}" is ${formatBytes(f.size)}, exceeds ${formatBytes(MAX_FILE_BYTES)}`);
          continue;
        }
        if (f.type.startsWith('image/') && f.size > MAX_IMAGE_BYTES) {
          rejected.push(`image "${f.name}" is ${formatBytes(f.size)}, exceeds ${formatBytes(MAX_IMAGE_BYTES)}`);
          continue;
        }
        if (total + f.size > MAX_TOTAL_BYTES) {
          rejected.push(`"${f.name}" would exceed ${formatBytes(MAX_TOTAL_BYTES)} total`);
          continue;
        }
        total += f.size;
        accepted.push({
          id: `${f.name}-${f.size}-${f.lastModified}-${Date.now()}-${i}`,
          file: f,
        });
      }
      if (accepted.length > 0) {
        setFiles((prev) => [...prev, ...accepted]);
        flashAttachSuccess(true, 2500);
      }
      setUploadError(rejected.length > 0 ? rejected.join('; ') : null);
    },
    [files, flashAttachSuccess],
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setUploadError(null);
  }, []);

  const clearFiles = useCallback(() => setFiles([]), []);

  // Uploads every pending file and returns the parts for `sendMessage`, or
  // null if any upload failed (the error is shown in the tray and the files
  // stay attached so the user can retry). Returns undefined with no files.
  const uploadFiles = useCallback(async (): Promise<FileUIPart[] | null | undefined> => {
    if (files.length === 0) return undefined;
    const total = files.reduce((n, f) => n + f.file.size, 0) || 1;
    const loaded = new Map<string, number>();
    setUploadError(null);
    setUploadProgress(0);
    try {
      return await Promise.all(
        files.map(async ({ id, file }) => {
          const blob = await upload(`${UPLOAD_PATH_PREFIX}${file.name}`, file, {
            access: 'private',
            handleUploadUrl: '/api/uploads',
            contentType: file.type || undefined,
            multipart: file.size > 8 * 1024 * 1024,
            onUploadProgress: (e) => {
              loaded.set(id, e.loaded);
              const sum = [...loaded.values()].reduce((n, v) => n + v, 0);
              setUploadProgress(Math.min(100, Math.round((sum / total) * 100)));
            },
          });
          return {
            type: 'file' as const,
            mediaType: file.type || blob.contentType,
            filename: file.name,
            url: blob.url,
          };
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUploadError(`upload failed (${message})`);
      return null;
    } finally {
      setUploadProgress(null);
    }
  }, [files]);

  return {
    files,
    uploadError,
    attachSuccess,
    uploadProgress,
    onPickFiles,
    removeFile,
    clearFiles,
    uploadFiles,
  };
}
