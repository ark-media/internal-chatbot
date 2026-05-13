import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type KindBadgeTone = 'emerald' | 'amber' | 'sky' | 'rose';

type Props = {
  tone: KindBadgeTone;
  children: ReactNode;
  className?: string;
};

const TONE_CLASSES: Record<KindBadgeTone, string> = {
  emerald: 'border-emerald-300/30 bg-emerald-400/10 text-emerald-200',
  amber: 'border-amber-300/30 bg-amber-400/10 text-amber-200',
  sky: 'border-sky-brand/30 bg-sky-brand/10 text-sky-brand-soft',
  rose: 'border-rose-300/30 bg-rose-400/10 text-rose-200',
};

export function KindBadge({ tone, children, className }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5',
        'font-mono text-[0.65rem] font-semibold uppercase tracking-wider',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
