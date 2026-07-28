'use client';

import { Square } from 'lucide-react';

import { TypingDots } from '@/components/ui/TypingDots';

// The in-flight row under the message list: typing indicator, a phase label,
// and a Stop control. The label is caller-supplied because each surface
// describes its own phases (summoning context / researching / scanning…).
export function BusyRow({ label, onStop }: { label: string; onStop: () => void }) {
  return (
    <div className="flex items-center gap-3 pl-12 text-xs text-fg/50">
      <TypingDots />
      <span className="tracking-wide">{label}</span>
      <button
        type="button"
        onClick={onStop}
        className="ml-2 inline-flex items-center gap-1 rounded-md border border-overlay/10 bg-overlay/5 px-2 py-0.5 text-[0.7rem] text-fg/70 transition hover:bg-overlay/10 hover:text-fg"
      >
        <Square className="h-2.5 w-2.5 fill-current" />
        Stop
      </button>
    </div>
  );
}
