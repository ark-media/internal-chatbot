'use client';

import { CheckCircle2, FileText, X } from 'lucide-react';
import { formatBytes } from '@/lib/prep-limits';
import type { AttachedFile } from '@/lib/use-file-attachments';

// The composer's attachment tray: an optional "attached" confirmation, one
// removable chip per pending file, and the rejection notice.
//
// `showSuccess` is opt-in rather than always-on — news confirms attachment
// with a banner, prep deliberately does not.
export function FileAttachments({
  files,
  uploadError,
  onRemove,
  showSuccess = false,
  attachSuccess = false,
}: {
  files: AttachedFile[];
  uploadError: string | null;
  onRemove: (id: string) => void;
  showSuccess?: boolean;
  attachSuccess?: boolean;
}) {
  return (
    <>
      {showSuccess && attachSuccess ? (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-200 animate-in fade-in duration-200">
          <CheckCircle2 className="h-4 w-4" />
          <span>{files.length} file{files.length !== 1 ? 's' : ''} attached</span>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <div
              key={f.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-overlay/10 bg-overlay/[0.04] px-2 py-1 text-[0.72rem] text-fg/75"
            >
              <FileText className="h-3 w-3 text-sky-brand" />
              <span className="max-w-[240px] truncate">{f.file.name}</span>
              <span className="text-fg/35">{formatBytes(f.file.size)}</span>
              <button
                type="button"
                onClick={() => onRemove(f.id)}
                className="ml-0.5 rounded p-0.5 text-fg/45 transition hover:bg-overlay/10 hover:text-fg"
                aria-label={`Remove ${f.file.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {uploadError ? (
        <div
          role="alert"
          className="mb-2 rounded-lg border border-amber-300/30 bg-amber-400/[0.08] px-3 py-2 text-[0.78rem] text-amber-100"
        >
          Some files were not attached — {uploadError}.
        </div>
      ) : null}
    </>
  );
}
