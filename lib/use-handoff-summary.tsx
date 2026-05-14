import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SummaryModal } from '@/components/SummaryModal';
import type { Source } from '@/components/chat-types';

type SummaryStatus = 'idle' | 'streaming' | 'done' | 'error';

type Options = {
  chatId: string;
  // Live message count — used to detect a stale cached summary on next open
  // (conversation moved forward since the summary was generated).
  messagesLength: number;
  // Only meaningful for surfaces that emit [id:N] / [turn:N] citations
  // (archive). When omitted, handoff text renders without clickable badges.
  sources?: Map<string, Source>;
  onOpenSource?: (source: Source, quote?: string) => void;
};

// Centralizes the summary-modal lifecycle: fetch state, callbacks, stale-cache
// detection, and the modal mount. Returns `openSummary` (wire to a button's
// onClick) and `modal` (drop anywhere in the tree).
export function useHandoffSummary({
  chatId,
  messagesLength,
  sources,
  onOpenSource,
}: Options) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<SummaryStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Message count snapshot at the moment streaming started. Used to detect a
  // stale cached summary on the next open instead of resetting mid-stream
  // (which would scramble in-flight chunks into the now-empty buffer).
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);

  // Stable empty Map for surfaces that don't supply sources, so MessageText
  // gets a non-null reference without forcing each caller to construct one.
  const emptySources = useMemo(() => new Map<string, Source>(), []);

  // Read messagesLength inside onStart via a ref so the callback identity
  // stays stable — otherwise SummaryModal's fetch effect would restart on
  // every parent re-render that bumps the count.
  const messagesLengthRef = useRef(messagesLength);
  useEffect(() => {
    messagesLengthRef.current = messagesLength;
  }, [messagesLength]);

  const onStart = useCallback(() => {
    setText('');
    setErrorMessage(null);
    setStatus('streaming');
    setGeneratedAt(messagesLengthRef.current);
  }, []);

  const onChunk = useCallback((chunk: string) => {
    setText((prev) => prev + chunk);
  }, []);

  const onFinish = useCallback(() => {
    setStatus('done');
  }, []);

  const onError = useCallback((message: string) => {
    setStatus('error');
    setErrorMessage(message);
  }, []);

  const onStop = useCallback(() => {
    // User pressed Stop, or modal closed mid-stream: keep whatever text
    // streamed so far and mark as done so Copy still works on the partial.
    setStatus('done');
  }, []);

  const openSummary = useCallback(() => {
    // Decide if the cached summary is still usable. Stale (conversation
    // advanced), error from last attempt, or empty 'done' (user stopped
    // before any chunks arrived) all warrant a fresh fetch.
    const isStale = generatedAt !== null && generatedAt !== messagesLength;
    const isEmptyDone = status === 'done' && !text;
    if (isStale || isEmptyDone || status === 'error') {
      setText('');
      setErrorMessage(null);
      setStatus('idle');
      setGeneratedAt(null);
    }
    setOpen(true);
  }, [messagesLength, generatedAt, status, text]);

  const handleSourceOpen = useCallback(
    (source: Source, quote?: string) => {
      // Close the modal so the source panel underneath is visible. Text stays
      // cached so the user can reopen and keep reading after inspecting.
      setOpen(false);
      onOpenSource?.(source, quote);
    },
    [onOpenSource],
  );

  const modal = (
    <SummaryModal
      open={open}
      chatId={chatId}
      text={text}
      status={status}
      errorMessage={errorMessage}
      sources={sources ?? emptySources}
      onOpenSource={handleSourceOpen}
      onClose={() => setOpen(false)}
      onStart={onStart}
      onChunk={onChunk}
      onFinish={onFinish}
      onError={onError}
      onStop={onStop}
    />
  );

  return { openSummary, modal };
}
