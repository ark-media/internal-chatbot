'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { chatFetch } from '@/lib/chat-fetch';

// Structural shape of a UIMessage, so this hook works with the Chat/Prep/News
// message unions without importing any of them.
type EditableMessage = {
  id: string;
  parts?: ReadonlyArray<{ type: string; text?: string }>;
};

// "Edit an earlier user message and resend from there", shared by the chat,
// prep and news pages.
//
// The server needs to know which message is being replaced so it can truncate
// the stored turn history; that travels as `editingMessageId` in the request
// body, injected by `editingFetch` rather than by each caller.
export function useMessageEditing({
  setInput,
  scrollRef,
}: {
  setInput: (text: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const cancelEditing = useCallback(() => {
    setEditingMessageId(null);
    setInput('');
  }, [setInput]);

  // Leaves the composer untouched — submit already cleared it, and the user may
  // have typed the next question while the answer streamed.
  const finishEditing = useCallback(() => setEditingMessageId(null), []);

  // Attached only while an edit is active, so Escape keeps its ordinary meaning
  // (closing panels and modals) the rest of the time.
  useEffect(() => {
    if (!editingMessageId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEditing();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingMessageId, cancelEditing]);

  const startEditing = useCallback(
    (message: EditableMessage) => {
      const textContent = message.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n\n');
      if (textContent) {
        setInput(textContent);
        setEditingMessageId(message.id);
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: 'smooth',
        });
      }
    },
    [setInput, scrollRef],
  );

  const editingFetch = useCallback<typeof fetch>(
    async (input, init) => {
      try {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (editingMessageId) {
          body.editingMessageId = editingMessageId;
        }
        return chatFetch(input, { ...init, body: JSON.stringify(body) });
      } catch (e) {
        console.error('Failed to parse request body for edit:', e);
        return chatFetch(input, init);
      }
    },
    [editingMessageId],
  );

  return {
    editingMessageId,
    startEditing,
    cancelEditing,
    finishEditing,
    editingFetch,
  };
}
