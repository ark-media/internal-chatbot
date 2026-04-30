'use client';

import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { cn } from '@/lib/cn';

type ChatErrorBannerProps = {
  error: Error | undefined;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
};

export function ChatErrorBanner({
  error,
  onRetry,
  onDismiss,
  className,
}: ChatErrorBannerProps) {
  if (!error) return null;

  const { status, message } = formatErrorMessage(error);

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3',
        'text-sm text-red-100',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-red-100">
          {status ? `Error ${status}` : 'Something went wrong.'}
        </div>
        <div className="mt-0.5 break-words text-[0.82rem] text-red-200/90">
          {message}
        </div>
        {(onRetry || onDismiss) && (
          <div className="mt-2 flex gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border border-red-300/30 bg-red-400/10',
                  'px-2 py-1 text-[0.75rem] font-medium text-red-100',
                  'transition hover:border-red-300/60 hover:bg-red-400/20',
                )}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5',
                  'px-2 py-1 text-[0.75rem] font-medium text-white/70',
                  'transition hover:bg-white/10 hover:text-white',
                )}
              >
                <X className="h-3 w-3" />
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export type FormattedError = {
  status: number | null;
  message: string;
};

// Parses the `[<status> <statusText>] <body>` shape that `chatFetch` produces,
// then cleans up the body text for display. Exported for testing.
export function formatErrorMessage(error: Error): FormattedError {
  const raw = error.message?.trim() ?? '';

  if (!raw) {
    return { status: null, message: 'The chat request failed. Please try again.' };
  }

  const prefixMatch = raw.match(/^\[(\d{3})(?:\s+([^\]]*))?\]\s*(.*)$/s);
  const status = prefixMatch ? Number(prefixMatch[1]) : null;
  const statusText = prefixMatch?.[2]?.trim() ?? '';
  const body = (prefixMatch ? prefixMatch[3] : raw).trim();

  return { status, message: cleanBody(body, statusText) };
}

function cleanBody(body: string, statusText: string): string {
  if (!body) {
    return statusText || 'The chat request failed. Please try again.';
  }

  if (/<!doctype html|<html/i.test(body)) {
    return statusText || 'The server returned an unexpected response.';
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const message =
        (typeof parsed.error === 'string' && parsed.error) ||
        (typeof parsed.message === 'string' && parsed.message) ||
        (typeof parsed.detail === 'string' && parsed.detail);
      if (message) return message;
    }
  } catch {
    // Not JSON — fall through.
  }

  return body;
}
