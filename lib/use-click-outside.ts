'use client';

import { useEffect, useRef, type RefObject } from 'react';

// Calls `onOutside` when a mousedown lands outside `ref`. Inert while
// `active` is false, so dropdown menus only listen while open. The callback
// is kept in a ref (refreshed in its own effect) so passing an inline
// `() => setOpen(false)` doesn't re-subscribe the listener on every render —
// the subscription effect only re-runs when `active` (or `ref`) changes.
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
): void {
  const onOutsideRef = useRef(onOutside);
  useEffect(() => {
    onOutsideRef.current = onOutside;
  });

  useEffect(() => {
    if (!active) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutsideRef.current();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [ref, active]);
}
