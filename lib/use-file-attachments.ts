'use client';

import { useCallback, useState, type ChangeEvent } from 'react';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
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
// `attachSuccess` is flashed on every accepted pick; a surface that doesn't
// render a confirmation banner (prep) simply ignores it.
export function useFileAttachments() {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attachSuccess, flashAttachSuccess] = useFlash(false);

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

  // A DataTransfer is the only way to hand `sendMessage` a real FileList.
  const asFileList = useCallback(() => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f.file);
    return dt.files.length > 0 ? dt.files : undefined;
  }, [files]);

  return {
    files,
    uploadError,
    attachSuccess,
    onPickFiles,
    removeFile,
    clearFiles,
    asFileList,
  };
}
