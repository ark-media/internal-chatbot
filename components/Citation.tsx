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
      <sup
        className="mx-0.5 text-[0.65em] text-ink-300/60"
        title={`missing source ${kind}:${id}`}
      >
        [{label}]
      </sup>
    );
  }

  const title =
    source.kind === 'turn'
      ? `${source.speaker ?? 'Speaker'} · ${source.show} · ${source.title}${source.date ? ' · ' + source.date : ''}`
      : `${source.show} · ${source.title}${source.date ? ' · ' + source.date : ''}`;

  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      title={title}
      className={cn(
        'group mx-0.5 inline-flex items-baseline rounded-md px-[0.4em] py-[0.05em]',
        'font-mono text-[0.7em] font-semibold leading-none',
        'border transition duration-150',
        'hover:-translate-y-px hover:shadow-[0_4px_14px_-4px_rgba(62,181,249,0.45)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3eb5f9]/60',
        source.kind === 'turn'
          ? 'border-emerald-300/30 bg-emerald-400/10 text-emerald-200 hover:border-emerald-300/60 hover:bg-emerald-400/20'
          : 'border-[#3eb5f9]/30 bg-[#3eb5f9]/10 text-[#79cdfc] hover:border-[#3eb5f9]/60 hover:bg-[#3eb5f9]/20',
      )}
    >
      {label}
    </button>
  );
}
