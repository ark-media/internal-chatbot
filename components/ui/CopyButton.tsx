'use client';

import { CheckCircle2, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';

// Post-turn "copy the answer" action. `copied` drives the transient confirmed
// state — drive it from useFlash so it reverts on its own.
//
// `label` varies by surface (chat copies an answer, prep/news a document), so
// it stays a prop rather than being generalised into one wording.
export function CopyButton({
  onClick,
  copied,
  label,
  disabled,
}: {
  onClick: () => void;
  copied: boolean;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
        'bg-emerald-500/20 text-emerald-200 transition hover:bg-emerald-500/30',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-500/20',
      )}
    >
      {copied ? (
        <>
          <CheckCircle2 className="h-4 w-4" />
          Copied!
        </>
      ) : (
        <>
          <Copy className="h-4 w-4" />
          {label}
        </>
      )}
    </button>
  );
}
