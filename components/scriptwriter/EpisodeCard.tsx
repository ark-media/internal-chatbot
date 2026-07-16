'use client';

import { useCallback, useState } from 'react';
import { CheckCircle2, Copy, GraduationCap, Loader2 } from 'lucide-react';

import type { EpisodePartData } from '@/components/scriptwriter-types';
import { cn } from '@/lib/cn';
import { useFlash } from '@/lib/use-flash';

export function EpisodeCard({
  episode,
  chatId,
  canUndo,
  onPick,
  busy,
}: {
  episode: EpisodePartData;
  chatId: string;
  canUndo: boolean;
  onPick: (text: string) => void;
  busy: boolean;
}) {
  const [copied, flashCopied] = useFlash(false);
  const [learnState, setLearnState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const inFlight = episode.status !== 'ready';

  const copyEpisode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(episode.text);
      flashCopied(true, 2000);
    } catch {
      // no-op
    }
  }, [episode.text, flashCopied]);

  const saveLearn = useCallback(async () => {
    if (learnState === 'saving') return;
    setLearnState('saving');
    try {
      const res = await fetch('/api/news/orchestrator/save-learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      setLearnState(res.ok ? 'saved' : 'error');
    } catch {
      setLearnState('error');
    }
  }, [chatId, learnState]);

  return (
    <div className="rounded-xl border border-sky-brand/25 bg-sky-brand/[0.04] px-4 py-3.5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sky-brand/20 px-1.5 py-0.5 font-mono text-[0.7rem] font-bold text-sky-brand-soft">
            EPISODE
          </span>
          <span className="text-[0.68rem] uppercase tracking-[0.18em] text-fg/40">
            {inFlight ? 'Assembling…' : 'Assembled'}
          </span>
          {inFlight ? <Loader2 className="h-3 w-3 animate-spin text-sky-brand" /> : null}
          {episode.usedFallback ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.66rem] text-amber-200"
              title="The assembly model failed the verbatim check, so a mechanical stitch was used — transitions are plain."
            >
              mechanical stitch
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={copyEpisode}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.72rem] text-fg/55 transition hover:bg-overlay/10 hover:text-fg"
        >
          {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="whitespace-pre-wrap break-words font-sans text-[0.88rem] leading-[1.75] text-fg/90">
        {episode.text}
      </pre>

      {episode.status === 'ready' ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy || learnState === 'saving' || learnState === 'saved'}
            onClick={saveLearn}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.74rem] transition disabled:cursor-not-allowed',
              learnState === 'saved'
                ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                : 'border-overlay/20 bg-overlay/[0.03] text-fg/70 hover:border-overlay/40 hover:text-fg',
            )}
            title="Distill this run's revisions into the persistent style profile"
          >
            {learnState === 'saving' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <GraduationCap className="h-3 w-3" />
            )}
            {learnState === 'saved' ? 'Learned' : learnState === 'error' ? 'Retry Save & Learn' : 'Save & Learn'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick('Revise the episode: ')}
            className="rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.74rem] text-fg/70 transition hover:border-overlay/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            Request changes…
          </button>
          {canUndo ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick('Undo that last episode change.')}
              className="rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.74rem] text-fg/70 transition hover:border-overlay/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Undo last change
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
