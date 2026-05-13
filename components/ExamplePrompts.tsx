'use client';

import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';

type ExamplePromptsProps = {
  prompts: string[];
  onPick: (prompt: string) => void;
  busy: boolean;
  label?: string;
  layout?: 'grid' | 'stack';
};

export function ExamplePrompts({
  prompts,
  onPick,
  busy,
  label,
  layout = 'grid',
}: ExamplePromptsProps) {
  const isStack = layout === 'stack';

  const containerClassName = isStack
    ? 'space-y-2'
    : 'grid w-full max-w-2xl gap-2 sm:grid-cols-2';

  const buttonClassName = cn(
    'ark-surface group rounded-xl border border-overlay/10 px-4 py-3 text-left',
    'text-[0.88rem] leading-snug text-fg/75 transition',
    'hover:border-sky-brand/40 hover:bg-sky-brand/[0.06] hover:text-fg',
    'disabled:cursor-not-allowed disabled:opacity-40',
  );

  return (
    <>
      {label && (
        <div className="text-[0.75rem] uppercase tracking-[0.15em] text-fg/40 mt-8 mb-2">
          {label}
        </div>
      )}
      <div className={cn('mt-8', containerClassName)}>
        {prompts.map((prompt, i) => (
          <button
            key={i}
            type="button"
            disabled={busy}
            onClick={() => onPick(prompt)}
            className={buttonClassName}
          >
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-brand/70 transition group-hover:text-sky-brand" />
              <span>{prompt}</span>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
