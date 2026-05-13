'use client';

import { useCallback, useEffect, useRef } from 'react';
import { CheckCircle2, Copy, Square, X } from 'lucide-react';

import { MessageText } from '@/components/MessageText';
import type { Source } from '@/components/chat-types';
import { cn } from '@/lib/cn';
import { useFlash } from '@/lib/use-flash';

type SummaryStatus = 'idle' | 'streaming' | 'done' | 'error';

type Props = {
  open: boolean;
  chatId: string;
  text: string;
  status: SummaryStatus;
  errorMessage: string | null;
  sources: Map<string, Source>;
  onOpenSource: (source: Source, quote?: string) => void;
  onClose: () => void;
  onStart: () => void;
  onChunk: (chunk: string) => void;
  onFinish: () => void;
  onError: (message: string) => void;
  onStop: () => void;
};

export function SummaryModal({
  open,
  chatId,
  text,
  status,
  errorMessage,
  sources,
  onOpenSource,
  onClose,
  onStart,
  onChunk,
  onFinish,
  onError,
  onStop,
}: Props) {
  const [copied, flashCopied] = useFlash(false);
  const abortRef = useRef<AbortController | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Stash callbacks and status in refs so the fetch effect can depend on
  // [open, chatId] only — without this, including the callbacks in deps would
  // restart the stream on every parent re-render. Refs are exempt from the
  // exhaustive-deps lint, so no eslint-disable is needed.
  const cbsRef = useRef({ onStart, onChunk, onFinish, onError, onStop });
  useEffect(() => {
    cbsRef.current = { onStart, onChunk, onFinish, onError, onStop };
  }, [onStart, onChunk, onFinish, onError, onStop]);

  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Kick off the streaming fetch when the modal opens with no cached content.
  // The parent owns the text state so it survives modal close/reopen, but the
  // fetch lifecycle belongs here — only this component knows when it's
  // mounted and visible.
  useEffect(() => {
    if (!open) return;
    if (statusRef.current !== 'idle') return;

    const controller = new AbortController();
    abortRef.current = controller;
    let streamActive = true;
    cbsRef.current.onStart();

    (async () => {
      try {
        const res = await fetch(`/api/chats/${chatId}/summary`, {
          method: 'POST',
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          cbsRef.current.onError(
            body.trim() || `Request failed with status ${res.status}`,
          );
          streamActive = false;
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          cbsRef.current.onError('No response body');
          streamActive = false;
          return;
        }
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) cbsRef.current.onChunk(chunk);
        }
        cbsRef.current.onFinish();
        streamActive = false;
      } catch (err) {
        if (controller.signal.aborted) return;
        cbsRef.current.onError(err instanceof Error ? err.message : String(err));
        streamActive = false;
      }
    })();

    return () => {
      controller.abort();
      abortRef.current = null;
      // Closing or unmounting mid-stream: the aborted fetch silently returns
      // without firing any callback, so without this the parent would be
      // stuck on status='streaming' forever and reopening would short-circuit
      // before starting a new fetch.
      if (streamActive) cbsRef.current.onStop();
    };
  }, [open, chatId]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    onStop();
  }, [onStop]);

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(true, 2000);
    } catch {
      // Clipboard can fail in iframes or non-HTTPS contexts; the failure is
      // visible (no "Copied!" flash) so no toast needed.
    }
  }, [text, flashCopied]);

  // Close on Escape, but only when not actively streaming — pressing Escape
  // mid-stream should stop the stream first, second press closes. This avoids
  // accidentally losing a half-streamed summary to a stray keypress.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (status === 'streaming') {
        handleStop();
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, status, handleStop, onClose]);

  // Focus management: remember what was focused before the modal opened, move
  // focus into the dialog on open, restore focus on close. No full Tab-trap —
  // an internal tool doesn't justify the complexity, but the basic handoff
  // makes the dialog navigable from the keyboard.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    closeButtonRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Conversation summary"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
      />

      <div
        className={cn(
          'ark-surface-raised ark-fade-up relative flex max-h-[85vh] w-full max-w-3xl flex-col',
          'rounded-2xl border border-overlay/10 shadow-[0_24px_80px_-20px_rgba(3,12,40,0.7)]',
        )}
      >
        <header className="flex items-center justify-between border-b border-overlay/[0.06] px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium tracking-wide text-fg/90">
              Summary of this conversation
            </h2>
            {status === 'streaming' ? (
              <span className="text-[0.7rem] uppercase tracking-[0.18em] text-sky-brand/80">
                Streaming…
              </span>
            ) : null}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-fg/50 transition hover:bg-overlay/10 hover:text-fg/80"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-[120px] flex-1 overflow-y-auto px-5 py-4">
          {status === 'error' ? (
            <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
              {errorMessage ?? 'Failed to generate summary.'}
            </div>
          ) : text ? (
            <MessageText text={text} sources={sources} onOpen={onOpenSource} />
          ) : status === 'streaming' ? (
            <div className="flex items-center gap-2 text-sm text-fg/50">
              <TypingDots />
              <span>Synthesising…</span>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-overlay/[0.06] px-5 py-3">
          {status === 'streaming' ? (
            <button
              type="button"
              onClick={handleStop}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border border-overlay/10 bg-overlay/5',
                'px-3 py-1.5 text-[0.78rem] text-fg/70 transition hover:bg-overlay/10 hover:text-fg',
              )}
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleCopy}
            disabled={!text || status === 'error'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[0.78rem] font-medium transition',
              copied
                ? 'bg-emerald-400/20 text-emerald-200'
                : 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-emerald-500/20',
            )}
          >
            {copied ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy markdown
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-overlay/10 bg-overlay/5',
              'px-3 py-1.5 text-[0.78rem] text-fg/70 transition hover:bg-overlay/10 hover:text-fg',
            )}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-sky-brand ark-pulse-dot"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}
