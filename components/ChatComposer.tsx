'use client';

import { ChangeEvent, FormEvent, ReactNode, useEffect, useRef } from 'react';
import { ArrowUp, Loader2, Paperclip } from 'lucide-react';
import { ModelSelector } from '@/components/ModelSelector';
import { cn } from '@/lib/cn';

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
  busy,
  canSubmit,
  footerHint,
  attachments,
  fileAttach,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    if (busy || !canSubmit) return;
    onSubmit();
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    trySubmit();
  };

  return (
    <form
      onSubmit={handleFormSubmit}
      className="relative z-10 border-t border-white/[0.06] bg-gradient-to-b from-transparent to-[#070b22]/60 px-6 py-4 backdrop-blur-md"
    >
      <div className="mx-auto max-w-3xl">
        {attachments}
        {/* items-end keeps the model selector + send button pinned to the
            textarea baseline as it auto-grows, instead of drifting upward. */}
        <div
          className={cn(
            'group flex items-end gap-2 rounded-2xl border bg-white/[0.04] px-3 py-2.5 backdrop-blur',
            'border-white/10 shadow-[0_12px_40px_-16px_rgba(3,62,200,0.45)]',
            'transition focus-within:border-[#3eb5f9]/60',
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
                'text-[0.95rem] leading-relaxed text-white placeholder:text-white/35',
                'outline-none disabled:opacity-60 overflow-y-auto',
              )}
            />
          </div>

          {fileAttach && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className={cn(
                'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                'text-white/60 transition hover:bg-white/[0.06] hover:text-white',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
              aria-label={fileAttach.ariaLabel}
              title={fileAttach.tooltip}
            >
              <Paperclip className="h-4 w-4" />
            </button>
          )}

          <button
            type="submit"
            aria-label="Send"
            disabled={busy || !canSubmit}
            className={cn(
              'group/btn relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
              'text-[#070b22] transition',
              'bg-[#3eb5f9] hover:bg-[#79cdfc]',
              'shadow-[0_6px_20px_-6px_rgba(62,181,249,0.7)]',
              'disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30 disabled:shadow-none',
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            )}
          </button>
        </div>
        <div className="mt-2 px-1 text-[0.68rem] uppercase tracking-[0.2em] text-white/30">
          {footerHint}
        </div>
      </div>
    </form>
  );
}
