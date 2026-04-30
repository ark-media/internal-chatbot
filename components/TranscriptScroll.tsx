'use client';

import { useEffect } from 'react';

// Smoothly scrolls the cited turn into view after the page mounts. The
// transcript is rendered server-side, so we handle anchor scrolling here
// to (a) bypass the browser's default behavior of scrolling before our
// scroll-container layout is settled, and (b) keep the highlight + scroll
// driven by the same `?turn=` / `?chunk=` query that the server reads.
export function TranscriptScroll({ targetTurnId }: { targetTurnId: number }) {
  useEffect(() => {
    const el = document.getElementById(`turn-${targetTurnId}`);
    if (!el) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const id = requestAnimationFrame(() => {
      el.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
      // Land keyboard focus on the highlighted turn without re-triggering the
      // browser's own scroll, so screen-reader / keyboard users start at the
      // citation rather than the page top.
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [targetTurnId]);
  return null;
}
