'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Transient state with auto-revert and proper cleanup. Replaces the
// pattern `setX(true); setTimeout(() => setX(false), ms)` which leaks
// the timer on unmount and stacks overlapping reverts on repeat clicks
// (the second click's timer fires while the user still expects the
// first revert to be visible).
export function useFlash<T>(
  idle: T,
): readonly [T, (active: T, ms: number) => void, () => void] {
  const [value, setValue] = useState<T>(idle);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flash = useCallback(
    (active: T, ms: number) => {
      cancel();
      setValue(active);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setValue(idle);
      }, ms);
    },
    [idle],
  );

  const reset = useCallback(() => {
    cancel();
    setValue(idle);
  }, [idle]);

  useEffect(() => cancel, []);

  return [value, flash, reset] as const;
}
