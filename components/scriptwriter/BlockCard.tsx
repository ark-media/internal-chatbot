'use client';

import { useCallback } from 'react';
import { CheckCircle2, Copy, Loader2 } from 'lucide-react';

import type { BlockPartData } from '@/components/scriptwriter-types';
import { cn } from '@/lib/cn';
import { useFlash } from '@/lib/use-flash';

const STATUS_LABELS: Record<BlockPartData['status'], string> = {
  streaming: 'Writing…',
  review: 'Editorial review…',
  ready: 'Draft ready',
};

export function BlockCard({
  block,
  approved,
  onPick,
  busy,
}: {
  block: BlockPartData;
  // Whether this block has since been approved (from the fetched run state).
  approved: boolean;
  onPick: (text: string) => void;
  busy: boolean;
}) {
  const [copied, flashCopied] = useFlash(false);
  const inFlight = block.status !== 'ready';

  const copyBlock = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      flashCopied(true, 2000);
    } catch {
      // no-op; the text is on screen
    }
  }, [block.text, flashCopied]);

  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3.5',
        approved
          ? 'border-emerald-400/25 bg-emerald-500/[0.04]'
          : 'border-overlay/10 bg-overlay/[0.03]',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sky-brand/15 px-1.5 py-0.5 font-mono text-[0.7rem] font-bold text-sky-brand-soft">
            {block.slot} BLOCK
          </span>
          <span className="text-[0.68rem] uppercase tracking-[0.18em] text-fg/40">
            v{block.version}
            {' · '}
            {approved ? 'Approved' : STATUS_LABELS[block.status]}
          </span>
          {inFlight ? <Loader2 className="h-3 w-3 animate-spin text-sky-brand" /> : null}
          {approved ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : null}
        </div>
        <button
          type="button"
          onClick={copyBlock}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.72rem] text-fg/55 transition hover:bg-overlay/10 hover:text-fg"
        >
          {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="whitespace-pre-wrap break-words font-sans text-[0.88rem] leading-[1.75] text-fg/90">
        {block.text}
      </pre>

      {block.editorNotes && block.editorNotes.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-400/[0.06] px-3 py-2">
          <div className="mb-1 text-[0.68rem] font-medium uppercase tracking-[0.18em] text-amber-200/80">
            Editor notes
          </div>
          <ul className="flex flex-col gap-1 text-[0.78rem] leading-relaxed text-amber-100/85">
            {block.editorNotes.map((n, i) => (
              <li key={i}>• {n}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {block.status === 'ready' && !approved ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(`Approve the ${block.slot} block.`)}
            className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-[0.74rem] text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(`Revise the ${block.slot} block: `)}
            className="rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.74rem] text-fg/70 transition hover:border-overlay/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            Request changes…
          </button>
        </div>
      ) : null}
    </div>
  );
}
