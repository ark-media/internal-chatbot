'use client';

import type { Source } from './chat-types';
import { cn } from '@/lib/cn';
import { citationChipLabel } from '@/lib/citation-label';

type Props = {
  kind: 'id' | 'turn';
  id: number;
  source: Source | undefined;
  // Verbatim substring the model attached to this citation, used by the
  // panel/transcript view to pinpoint the exact passage. Only set when the
  // model emitted [id:N "..."] / [turn:N "..."] for a single-ref citation.
  quote?: string;
  onOpen: (source: Source, quote?: string) => void;
  // Shared "today" so every chip in a render computes the same year-boundary,
  // and so a New Year boundary mid-session can't make sibling chips disagree.
  today?: Date;
};

export function Citation({ kind, id, source, quote, onOpen, today }: Props) {
  if (!source) {
    console.warn(`Citation missing source: ${kind}:${id}`);
    return (
      <span
        className={cn(
          'mx-0.5 inline-flex items-center rounded-md border border-red-500/30 bg-red-400/[0.08]',
          'px-1.5 py-[0.1em] font-mono text-[0.72em] font-medium leading-tight',
          'text-red-400/70',
        )}
        title={`missing source ${kind}:${id}`}
      >
        {kind === 'turn' ? `t${id}` : id}⚠
      </span>
    );
  }

  const label = citationChipLabel(source, today);

  const title =
    source.kind === 'turn'
      ? `${source.speaker ?? 'Speaker'} · ${source.show} · ${source.title}${source.date ? ' · ' + source.date : ''}`
      : `${source.show} · ${source.title}${source.date ? ' · ' + source.date : ''}`;

  const turnStyles = cn(
    'border-emerald-300/40 bg-emerald-400/[0.12] text-emerald-200',
    'hover:border-emerald-300/70 hover:bg-emerald-400/25 hover:text-fg',
    'hover:shadow-[0_4px_14px_-4px_rgba(52,211,153,0.55)]',
    'focus-visible:ring-emerald-300/60',
  );

  const chunkStyles = cn(
    'border-sky-brand/40 bg-sky-brand/[0.12] text-sky-brand-soft',
    'hover:border-sky-brand/70 hover:bg-sky-brand/25 hover:text-fg',
    'hover:shadow-[0_4px_14px_-4px_rgba(62,181,249,0.6)]',
    'focus-visible:ring-sky-brand/60',
  );

  return (
    <button
      type="button"
      onClick={() => onOpen(source, quote)}
      title={title}
      aria-label={`Open source ${label}: ${title}`}
      className={cn(
        'group mx-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded-md border',
        'px-1.5 py-0.5 align-baseline',
        'text-[0.78em] font-semibold leading-tight tracking-tight whitespace-nowrap',
        'transition-all duration-150 ease-out',
        'hover:-translate-y-[2px] hover:shadow-md',
        'focus:outline-none focus-visible:ring-2',
        source.kind === 'turn' ? turnStyles : chunkStyles,
      )}
    >
      <span>{label}</span>
    </button>
  );
}
