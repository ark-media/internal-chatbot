'use client';

import type { Source } from './chat-types';
import { cn } from '@/lib/cn';

type Props = {
  kind: 'id' | 'turn';
  id: number;
  source: Source | undefined;
  onOpen: (source: Source) => void;
};

export function Citation({ kind, id, source, onOpen }: Props) {
  const label = kind === 'turn' ? `t${id}` : String(id);

  if (!source) {
    return (
      <span
        className={cn(
          'mx-0.5 inline-flex items-center rounded-md border border-white/5 bg-white/[0.04]',
          'px-1.5 py-[0.1em] font-mono text-[0.72em] font-medium leading-tight',
          'text-white/35',
        )}
        title={`missing source ${kind}:${id}`}
      >
        {label}
      </span>
    );
  }

  const title =
    source.kind === 'turn'
      ? `${source.speaker ?? 'Speaker'} · ${source.show} · ${source.title}${source.date ? ' · ' + source.date : ''}`
      : `${source.show} · ${source.title}${source.date ? ' · ' + source.date : ''}`;

  const turnStyles = cn(
    'border-emerald-300/40 bg-emerald-400/[0.12] text-emerald-200',
    'hover:border-emerald-300/70 hover:bg-emerald-400/25 hover:text-white',
    'hover:shadow-[0_4px_14px_-4px_rgba(52,211,153,0.55)]',
    'focus-visible:ring-emerald-300/60',
  );

  const chunkStyles = cn(
    'border-[#3eb5f9]/40 bg-[#3eb5f9]/[0.12] text-[#79cdfc]',
    'hover:border-[#3eb5f9]/70 hover:bg-[#3eb5f9]/25 hover:text-white',
    'hover:shadow-[0_4px_14px_-4px_rgba(62,181,249,0.6)]',
    'focus-visible:ring-[#3eb5f9]/60',
  );

  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      title={title}
      aria-label={`Open source ${label}: ${title}`}
      className={cn(
        'group mx-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded-md border',
        'px-[0.45em] py-[0.1em] align-baseline',
        'font-mono text-[0.78em] font-semibold leading-tight tracking-tight',
        'transition-all duration-150 ease-out',
        'hover:-translate-y-[1px]',
        'focus:outline-none focus-visible:ring-2',
        source.kind === 'turn' ? turnStyles : chunkStyles,
      )}
    >
      <span>{label}</span>
    </button>
  );
}
