'use client';

import { useRef, useState } from 'react';
import { ChevronDown, Thermometer } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useClickOutside } from '@/lib/use-click-outside';
import { TEMPERATURE_PRESETS, type TemperaturePresetId } from '@/lib/temperature';

type TemperatureSelectorProps = {
  selectedTemperature: TemperaturePresetId;
  onTemperatureChange: (presetId: TemperaturePresetId) => void;
};

export function TemperatureSelector({
  selectedTemperature,
  onTemperatureChange,
}: TemperatureSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(dropdownRef, isOpen, () => setIsOpen(false));

  const selected = TEMPERATURE_PRESETS.find((p) => p.id === selectedTemperature);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 h-10',
          'bg-overlay/[0.05] text-[0.85rem] text-fg/70 transition',
          'hover:bg-overlay/[0.08] hover:text-fg',
          'border border-overlay/10 whitespace-nowrap',
        )}
      >
        <Thermometer className="h-3.5 w-3.5" />
        {selected?.label}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {isOpen ? (
        <div className="absolute bottom-full left-0 mb-2 w-60 rounded-lg border border-overlay/10 bg-canvas-deep/95 py-1.5 shadow-lg backdrop-blur-md z-50">
          {TEMPERATURE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                onTemperatureChange(preset.id);
                setIsOpen(false);
              }}
              className={cn(
                'w-full px-3 py-2 text-left transition',
                selectedTemperature === preset.id
                  ? 'bg-sky-brand/20 text-sky-brand-soft'
                  : 'text-fg/70 hover:bg-overlay/[0.05] hover:text-fg',
              )}
            >
              <div className="flex items-baseline gap-1.5 font-medium text-[0.9rem]">
                {preset.label}
                <span className="font-mono text-[0.7rem] text-fg/40">
                  {preset.value.toFixed(1)}
                </span>
              </div>
              <div className="mt-0.5 text-[0.75rem] text-fg/50">{preset.hint}</div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
