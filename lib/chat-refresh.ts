'use client';

import { useEffect, useState } from 'react';

const listeners = new Set<() => void>();

export function notifyChatUpdated(): void {
  for (const fn of Array.from(listeners)) fn();
}

export function useChatUpdates(callback: () => void): void {
  useEffect(() => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }, [callback]);
}

const deletingChats = new Set<string>();
const deletingListeners = new Set<() => void>();

export function markChatDeleting(chatId: string): void {
  deletingChats.add(chatId);
  for (const fn of Array.from(deletingListeners)) fn();
}

export function clearChatDeleting(chatId: string): void {
  if (!deletingChats.delete(chatId)) return;
  for (const fn of Array.from(deletingListeners)) fn();
}

export function useIsChatDeleting(chatId: string | null | undefined): boolean {
  const [isDeleting, setIsDeleting] = useState(() =>
    chatId ? deletingChats.has(chatId) : false,
  );
  useEffect(() => {
    const update = () =>
      setIsDeleting(chatId ? deletingChats.has(chatId) : false);
    deletingListeners.add(update);
    update();
    return () => {
      deletingListeners.delete(update);
    };
  }, [chatId]);
  return isDeleting;
}
