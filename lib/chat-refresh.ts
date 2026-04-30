'use client';

import { useEffect } from 'react';

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
