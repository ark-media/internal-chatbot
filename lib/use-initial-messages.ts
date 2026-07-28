'use client';

import { useEffect, useState } from 'react';

// Loads a chat's persisted turns before `useChat` is created.
//
// Returns `null` while loading — the caller must render nothing until then,
// because `useChat` snapshots `messages` on first render and a later arrival
// would be ignored.
//
// A failed or non-ok fetch resolves to `[]` rather than staying null, so a
// missing chat opens as an empty one instead of hanging on a blank screen.
export function useInitialMessages<M>(chatId: string | undefined): M[] | null {
  const [initialMessages, setInitialMessages] = useState<M[] | null>(null);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    fetch(`/api/chats/${chatId}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages?: M[] }) => {
        if (!cancelled) setInitialMessages(d.messages ?? []);
      })
      .catch(() => {
        if (!cancelled) setInitialMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  return initialMessages;
}
