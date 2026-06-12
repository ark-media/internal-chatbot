'use client';

import { useRef, useState } from 'react';
import { ChevronDown, Mic } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useClickOutside } from '@/lib/use-click-outside';
import { PREP_SHOWS, type PrepShowId } from '@/lib/prep-shows';

type ShowSelectorProps = {
  selectedShow: PrepShowId;
  onShowChange: (showId: PrepShowId) => void;
};

export function ShowSelector({ selectedShow, onShowChange }: ShowSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(dropdownRef, isOpen, () => setIsOpen(false));

  const selected = PREP_SHOWS.find((s) => s.id === selectedShow);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Select show"
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 h-10',
          'bg-overlay/[0.05] text-[0.85rem] text-fg/70 transition',
          'hover:bg-overlay/[0.08] hover:text-fg',
          'border border-overlay/10 whitespace-nowrap',
        )}
      >
        <Mic className="h-3.5 w-3.5" />
        {selected?.label}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {isOpen ? (
        <div className="absolute bottom-full left-0 mb-2 w-72 rounded-lg border border-overlay/10 bg-canvas-deep/95 py-1.5 shadow-lg backdrop-blur-md z-50">
          {PREP_SHOWS.map((show) => (
            <button
              key={show.id}
              type="button"
              onClick={() => {
                onShowChange(show.id);
                setIsOpen(false);
              }}
              className={cn(
                'w-full px-3 py-2 text-left transition',
                selectedShow === show.id
                  ? 'bg-sky-brand/20 text-sky-brand-soft'
                  : 'text-fg/70 hover:bg-overlay/[0.05] hover:text-fg',
              )}
            >
              <div className="font-medium text-[0.9rem]">{show.label}</div>
              <div className="mt-0.5 text-[0.75rem] text-fg/50">{show.blurb}</div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
