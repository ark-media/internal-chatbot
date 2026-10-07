'use client';

import { useCallback, useRef, useState, type ChangeEvent } from 'react';
import type { FileUIPart } from 'ai';
import { upload } from '@vercel/blob/client';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  MULTIPART_UPLOAD_BYTES,
  SUPPORTED_IMAGE_TYPES,
  UPLOAD_PATH_PREFIX,
  formatBytes,
} from '@/lib/prep-limits';
import { useFlash } from '@/lib/use-flash';

export type AttachedFile = {
  id: string;
  file: File;
  // Set once this file is in Blob, so a retry after a partial failure only
  // re-sends the files that didn't make it.
  uploaded?: FileUIPart;
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
  const abortRef = useRef<AbortController | null>(null);

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
        if (f.type.startsWith('image/') && !SUPPORTED_IMAGE_TYPES.has(f.type)) {
          rejected.push(`"${f.name}" is ${f.type}; attach images as JPEG, PNG, GIF or WebP`);
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
  // null if an upload failed or was cancelled (a failure is shown in the tray;
  // the files stay attached, and a retry skips the ones already uploaded).
  const uploadFiles = useCallback(async (): Promise<FileUIPart[] | null> => {
    if (files.length === 0) return [];
    const total = files.reduce((n, f) => n + f.file.size, 0) || 1;
    const loaded = new Map<string, number>(
      files.filter((f) => f.uploaded).map((f) => [f.id, f.file.size]),
    );
    const controller = new AbortController();
    abortRef.current = controller;
    setUploadError(null);
    setUploadProgress(0);
    try {
      return await Promise.all(
        files.map(async ({ id, file, uploaded }) => {
          if (uploaded) return uploaded;
          const blob = await upload(`${UPLOAD_PATH_PREFIX}${file.name}`, file, {
            access: 'private',
            handleUploadUrl: '/api/uploads',
            contentType: file.type || undefined,
            multipart: file.size > MULTIPART_UPLOAD_BYTES,
            abortSignal: controller.signal,
            onUploadProgress: (e) => {
              loaded.set(id, e.loaded);
              const sum = [...loaded.values()].reduce((n, v) => n + v, 0);
              setUploadProgress(Math.min(100, Math.round((sum / total) * 100)));
            },
          });
          const part: FileUIPart = {
            type: 'file',
            mediaType: file.type || blob.contentType,
            filename: file.name,
            url: blob.url,
          };
          setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, uploaded: part } : f)));
          return part;
        }),
      );
    } catch (err) {
      // One failure cancels the rest instead of letting them run on unseen.
      const cancelled = controller.signal.aborted;
      controller.abort();
      if (!cancelled) {
        const message = err instanceof Error ? err.message : String(err);
        setUploadError(`upload failed (${message})`);
      }
      return null;
    } finally {
      abortRef.current = null;
      setUploadProgress(null);
    }
  }, [files]);

  // Stops an in-flight upload; the pending send then doesn't happen.
  const cancelUpload = useCallback(() => abortRef.current?.abort(), []);

  return {
    files,
    uploadError,
    attachSuccess,
    uploadProgress,
    uploading: uploadProgress !== null,
    onPickFiles,
    removeFile,
    clearFiles,
    uploadFiles,
    cancelUpload,
  };
}
