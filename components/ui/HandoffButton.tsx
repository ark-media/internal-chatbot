'use client';

import { ScrollText } from 'lucide-react';
import { cn } from '@/lib/cn';

// Opens the handoff-summary modal. `title` names what is being handed off
// ("this conversation" / "this prep" / "this script") and is the only thing
// that differs between surfaces.
export function HandoffButton({
  onClick,
  title,
}: {
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
        'border border-overlay/10 bg-overlay/5 text-fg/75 transition hover:bg-overlay/10 hover:text-fg',
      )}
      title={title}
    >
      <ScrollText className="h-4 w-4" />
      Hand off to new chat
    </button>
  );
}
