'use client';

import { ChangeEvent, FormEvent, ReactNode, useEffect, useRef } from 'react';
import { ArrowUp, Loader2, Paperclip } from 'lucide-react';
import { ModelSelector } from '@/components/ModelSelector';
import { TemperatureSelector } from '@/components/TemperatureSelector';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import type { TemperaturePresetId } from '@/lib/temperature';

type FileAttachConfig = {
  accept: string;
  multiple?: boolean;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  ariaLabel: string;
  tooltip: string;
};

type ChatComposerProps = {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  // Temperature is opt-in per surface: pass both to show the selector, omit
  // both to hide it. The main chat omits them (fixed temperature for RAG
  // reliability); news and prep pass them.
  selectedTemperature?: TemperaturePresetId;
  onTemperatureChange?: (presetId: TemperaturePresetId) => void;
  busy: boolean;
  canSubmit: boolean;
  footerHint: ReactNode;
  attachments?: ReactNode;
  fileAttach?: FileAttachConfig;
};

export function ChatComposer({
  input,
  onInputChange,
  onSubmit,
  placeholder,
  selectedModel,
  onModelChange,
  selectedTemperature,
  onTemperatureChange,
  busy,
  canSubmit,
  footerHint,
  attachments,
  fileAttach,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Synchronous guard: prevents a second submission firing before React has
  // re-rendered with busy=true (e.g. two rapid Enter presses, or Enter+click).
  const submittingRef = useRef(false);

  // Auto-grow up to 200px so multi-line drafting feels natural on every
  // surface. Replaces the older fixed-40px + overflow-hidden behavior that
  // news and prep used to have; the cap + scroll keep tall pastes contained.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const trySubmit = () => {
    if (busy || !canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    // try/finally ensures the microtask is scheduled even if onSubmit throws
    // synchronously; otherwise the ref would stay true and wedge the composer.
    try {
      onSubmit();
    } finally {
      // Clear on the next microtask. Two rapid keypresses always fall in
      // separate event-loop tasks, and microtasks drain before the next task,
      // so the ref only blocks re-entry within the *current* task. The next
      // user input is then gated by the busy prop — assuming the parent has
      // re-rendered with busy=true by then; concurrent React typically has,
      // but there's no hard guarantee. If the parent never flips busy at all
      // (sync no-op, error before fetch, etc.) we recover instead of wedging.
      queueMicrotask(() => {
        submittingRef.current = false;
      });
    }
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    trySubmit();
  };

  return (
    <form
      onSubmit={handleFormSubmit}
      className="relative z-10 border-t border-overlay/[0.06] bg-gradient-to-b from-transparent to-canvas-deep/60 px-5 py-4 backdrop-blur-md"
    >
      <div className="mx-auto max-w-7xl">
        {attachments}
        {/* items-end keeps the model selector + send button pinned to the
            textarea baseline as it auto-grows, instead of drifting upward. */}
        <div
          className={cn(
            'ark-surface-raised group flex items-end gap-2 rounded-2xl border px-3 py-2.5 backdrop-blur',
            'border-overlay/10 shadow-[0_12px_40px_-16px_rgba(3,62,200,0.45)]',
            'transition focus-within:border-sky-brand/60',
            'focus-within:shadow-[0_12px_40px_-14px_rgba(62,181,249,0.55)]',
          )}
        >
          {fileAttach && (
            <input
              ref={fileInputRef}
              type="file"
              multiple={fileAttach.multiple}
              accept={fileAttach.accept}
              onChange={fileAttach.onPick}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
          )}

          <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} />

          {selectedTemperature !== undefined && onTemperatureChange ? (
            <TemperatureSelector
              selectedTemperature={selectedTemperature}
              onTemperatureChange={onTemperatureChange}
            />
          ) : null}

          <div className="flex min-w-0 flex-1 items-center">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  trySubmit();
                }
              }}
              rows={1}
              placeholder={placeholder}
              disabled={busy}
              className={cn(
                'min-h-[40px] max-h-[200px] w-full resize-none bg-transparent px-3 py-1.5',
                'text-[0.95rem] leading-relaxed text-fg placeholder:text-fg/35',
                'outline-none disabled:opacity-60 overflow-y-auto',
              )}
            />
          </div>

          {fileAttach && (
            <IconButton
              size="md"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-label={fileAttach.ariaLabel}
              title={fileAttach.tooltip}
            >
              <Paperclip className="h-4 w-4" />
            </IconButton>
          )}

          <button
            type="submit"
            aria-label="Send"
            disabled={busy || !canSubmit}
            className={cn(
              'group/btn relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
              'text-ink-950 transition',
              'bg-sky-brand hover:bg-sky-brand-soft',
              'shadow-[0_6px_20px_-6px_rgba(62,181,249,0.7)]',
              'disabled:cursor-not-allowed disabled:bg-overlay/10 disabled:text-fg/30 disabled:shadow-none',
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            )}
          </button>
        </div>
        <div className="mt-2 px-1 text-[0.68rem] uppercase tracking-[0.2em] text-fg/30">
          {footerHint}
        </div>
      </div>
    </form>
  );
}
