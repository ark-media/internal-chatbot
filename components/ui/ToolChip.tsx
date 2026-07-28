'use client';

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

// A small labelled chip marking one tool call in the message stream. `pulsing`
// animates the icon while the call is still in flight.
export function ToolChip({
  icon: Icon,
  label,
  pulsing,
}: {
  icon: LucideIcon;
  label: string;
  pulsing?: boolean;
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border border-overlay/10 bg-overlay/[0.03]',
        'px-2.5 py-1 text-[0.72rem] text-fg/65',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 text-sky-brand', pulsing && 'ark-pulse-dot')} />
      <span>{label}</span>
    </div>
  );
}
