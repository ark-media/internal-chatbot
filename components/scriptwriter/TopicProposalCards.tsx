'use client';

import { ExternalLink, TriangleAlert } from 'lucide-react';

import type { TopicCardData } from '@/components/scriptwriter-types';
import { cn } from '@/lib/cn';

function credibilityTone(score: number): string {
  if (score >= 70) return 'bg-emerald-500/15 text-emerald-200';
  if (score >= 45) return 'bg-amber-500/15 text-amber-200';
  return 'bg-red-500/15 text-red-200';
}

// Source URLs come from the untrusted sourcing pipeline. Only render an anchor
// when the scheme is http(s); anything else (javascript:, data:, …) is dropped
// to avoid script execution on click.
function safeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const STAGE_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  understanding: 'Confirming understanding',
  confirmed: 'Ready to draft',
  drafting: 'Drafting',
  revising: 'Draft in review',
  approved: 'Approved',
};

export function TopicProposalCards({
  topics,
  onPick,
  busy,
  hasBackups,
}: {
  topics: TopicCardData[];
  onPick: (text: string) => void;
  busy: boolean;
  // Whether the run has any backup stories to swap in. When false, the swap
  // action is hidden — there's nothing to swap to (e.g. a URL-sourced run).
  hasBackups: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {topics.map((t) => (
        <div
          key={t.index}
          className="rounded-xl border border-overlay/10 bg-overlay/[0.03] px-4 py-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded bg-sky-brand/15 px-1.5 py-0.5 font-mono text-[0.7rem] font-bold text-sky-brand-soft">
                  {t.slot} BLOCK
                </span>
                <span className="text-[0.68rem] uppercase tracking-[0.18em] text-fg/40">
                  {t.register === 'human-interest' ? 'human interest' : 'hard news'}
                  {' · '}
                  {STAGE_LABELS[t.stage] ?? t.stage}
                </span>
              </div>
              <div className="mt-1.5 font-display text-[0.98rem] font-bold leading-snug text-fg">
                {t.headline}
              </div>
            </div>
          </div>

          <p className="mt-2 text-[0.84rem] leading-relaxed text-fg/70">{t.angle}</p>
          <p className="mt-1.5 text-[0.78rem] leading-relaxed text-fg/50">
            <span className="font-medium text-fg/60">Why today:</span> {t.rationale}
          </p>

          <ul className="mt-3 flex flex-col gap-1.5">
            {t.sources.map((s) => {
              const safeUrl = safeHttpUrl(s.url);
              return (
              <li key={s.url} className="flex items-center gap-2 text-[0.76rem]">
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.68rem]',
                    credibilityTone(s.credibility),
                  )}
                  title={s.credibilityNote}
                >
                  {s.credibility}
                </span>
                {safeUrl ? (
                  <a
                    href={safeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 text-fg/70 transition hover:text-fg"
                  >
                    <span className="shrink-0 font-medium text-fg/80">{s.source}</span>
                    <span className="truncate">— {s.title}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 text-fg/35" />
                  </a>
                ) : (
                  <span className="inline-flex min-w-0 items-center gap-1 text-fg/70">
                    <span className="shrink-0 font-medium text-fg/80">{s.source}</span>
                    <span className="truncate">— {s.title}</span>
                  </span>
                )}
                {s.isFlagged ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-amber-300/80"
                    title="Published outside the acceptable date window"
                  >
                    <TriangleAlert className="h-3 w-3" />
                  </span>
                ) : null}
              </li>
              );
            })}
          </ul>

          {t.stage === 'proposed' ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onPick(`Let's work the ${t.slot} block story ("${t.headline}") — walk me through your understanding first.`)
                }
                className="rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.74rem] text-fg/70 transition hover:border-overlay/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                Work this story
              </button>
              {hasBackups ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(`Swap the ${t.slot} block story for one of the backups.`)}
                  className="rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.74rem] text-fg/70 transition hover:border-overlay/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Swap for a backup
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
