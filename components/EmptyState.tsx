'use client';

import { ArkLogo } from '@/components/ArkLogo';
import { ExamplePrompts } from '@/components/ExamplePrompts';

type EmptyStateProps = {
  title: string;
  highlight: string;
  description: React.ReactNode;
  prompts: string[];
  onPick: (prompt: string) => void;
  busy: boolean;
  footerNote?: React.ReactNode;
  promptLayout?: 'grid' | 'stack';
  promptLabel?: string;
};

export function EmptyState({
  title,
  highlight,
  description,
  prompts,
  onPick,
  busy,
  footerNote,
  promptLayout = 'grid',
  promptLabel,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center text-center min-h-full justify-center ark-fade-up">
      <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-2xl border border-overlay/10 bg-gradient-to-br from-ink-800 to-ink-950 shadow-[0_20px_60px_-20px_rgba(62,181,249,0.35)]">
        <ArkLogo className="h-14" bg="transparent" fg="#3eb5f9" markOnly />
      </div>

      <h1
        className="font-display text-3xl font-black tracking-tight text-fg sm:text-4xl"
        style={{ letterSpacing: '-0.02em' }}
      >
        {title}{' '}
        <span className="bg-gradient-to-r from-sky-brand via-sky-brand-soft to-fg bg-clip-text text-transparent">
          {highlight}
        </span>
        {!title.endsWith('.') && !highlight.endsWith('.') ? '.' : null}
      </h1>

      <p className="mt-3 max-w-md text-[0.95rem] leading-relaxed text-fg/55">
        {description}
      </p>

      <ExamplePrompts
        prompts={prompts}
        onPick={onPick}
        busy={busy}
        layout={promptLayout}
        label={promptLabel}
      />

      {footerNote ? (
        <p className="mt-6 max-w-md text-[0.78rem] leading-relaxed text-fg/40">
          {footerNote}
        </p>
      ) : null}
    </div>
  );
}
