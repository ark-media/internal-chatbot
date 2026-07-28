'use client';

import { useCallback, useRef, useState } from 'react';

type UploadResponse = {
  driveUrl?: string;
  error?: string;
  [key: string]: unknown;
};

// The "save this turn to Google Drive" state machine shared by prep and news:
// re-entrancy guard, loading flag, and the link/error pair the button renders.
//
// Callers own their own payload and any response fields beyond `driveUrl`
// (prep reads matchedShow/fallback); `save` resolves to the parsed body on
// success and `null` on any failure, so a caller can key extra state off it
// without repeating the error handling.
export function useDriveSave(endpoint: string) {
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveLink, setDriveLink] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  // A ref, not state: this guards against a second call landing before React
  // has re-rendered the disabled button, which state cannot do synchronously.
  const inFlight = useRef(false);

  const save = useCallback(
    async (body: unknown): Promise<UploadResponse | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setDriveLoading(true);
      setDriveError(null);
      setDriveLink(null);

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data: UploadResponse = await res.json();
        if (!res.ok) {
          setDriveError(data.error || 'Upload failed');
          return null;
        }
        setDriveLink(data.driveUrl ?? null);
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDriveError(`Failed to upload: ${msg}`);
        return null;
      } finally {
        setDriveLoading(false);
        inFlight.current = false;
      }
    },
    [endpoint],
  );

  // Called when a new turn starts, so a stale link or error doesn't sit under
  // an answer it no longer belongs to.
  const resetDrive = useCallback(() => {
    setDriveLink(null);
    setDriveError(null);
  }, []);

  return { driveLoading, driveLink, driveError, save, resetDrive };
}
