'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';

import type { SourcingProgressData } from '@/components/scriptwriter-types';

const STEPS: Array<{ key: keyof SourcingProgressData; label: (v: number | true) => string }> = [
  { key: 'discovering', label: () => 'Searching the open web across the beat' },
  {
    key: 'discovered',
    label: (v) => (typeof v === 'number' ? `Found ${v} candidate articles` : 'Candidates found'),
  },
  { key: 'ranking', label: () => 'Ranking the most interesting stories' },
  {
    key: 'selected',
    label: (v) => (typeof v === 'number' ? `Selected ${v} ${v === 1 ? 'story' : 'stories'}` : 'Stories selected'),
  },
  {
    key: 'extracting',
    label: (v) => (typeof v === 'number' ? `Reading ${v} sources in full` : 'Reading sources'),
  },
  { key: 'distilling', label: () => 'Distilling summaries and verbatim quotes' },
  { key: 'ready', label: () => 'Stories ready' },
];

export function SourcingProgressCard({ progress }: { progress: SourcingProgressData }) {
  const done = progress.ready !== undefined;
  const lastReachedIdx = STEPS.reduce(
    (last, s, i) => (progress[s.key] !== undefined ? i : last),
    -1,
  );
  return (
    <div className="rounded-xl border border-overlay/10 bg-overlay/[0.03] px-4 py-3">
      <div className="mb-2 text-[0.7rem] font-medium uppercase tracking-[0.2em] text-fg/45">
        Sourcing today&apos;s stories
      </div>
      <ul className="flex flex-col gap-1.5 text-[0.82rem]">
        {STEPS.map((s, i) => {
          const value = progress[s.key];
          if (value === undefined) return null;
          const isCurrent = i === lastReachedIdx && !done;
          return (
            <li key={s.key} className="flex items-center gap-2 text-fg/75">
              {isCurrent ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-brand" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              )}
              <span>{s.label(value)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
