// @vitest-environment jsdom
// Drives a hook with React state transitions; needs a DOM.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDriveSave } from './use-drive-save';

const jsonResponse = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as Response;

beforeEach(() => {
  vi.restoreAllMocks();
});

function setup(endpoint = '/api/prep/upload') {
  return renderHook(() => useDriveSave(endpoint));
}

describe('useDriveSave', () => {
  it('starts idle', () => {
    const { result } = setup();
    expect(result.current.driveLoading).toBe(false);
    expect(result.current.driveLink).toBeNull();
    expect(result.current.driveError).toBeNull();
  });

  it('posts JSON to the endpoint and exposes the returned link', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ driveUrl: 'https://drive/x' }));
    const { result } = setup('/api/news/upload');

    await act(async () => {
      await result.current.save({ scriptText: 'hi' });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/news/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: 'hi' }),
    });
    expect(result.current.driveLink).toBe('https://drive/x');
    expect(result.current.driveError).toBeNull();
    expect(result.current.driveLoading).toBe(false);
  });

  // prep reads matchedShow/fallback off the same response.
  it('resolves to the full parsed body on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ driveUrl: 'https://drive/x', matchedShow: 'Ark', fallback: false }),
    );
    const { result } = setup();

    let data: unknown;
    await act(async () => {
      data = await result.current.save({});
    });

    expect(data).toMatchObject({ matchedShow: 'Ark', fallback: false });
  });

  it('surfaces the server error message on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'no folder' }, false),
    );
    const { result } = setup();

    let data: unknown;
    await act(async () => {
      data = await result.current.save({});
    });

    expect(data).toBeNull();
    expect(result.current.driveError).toBe('no folder');
    expect(result.current.driveLink).toBeNull();
  });

  it('falls back to a generic message when the error body has none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, false));
    const { result } = setup();

    await act(async () => {
      await result.current.save({});
    });

    expect(result.current.driveError).toBe('Upload failed');
  });

  it('reports a thrown network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { result } = setup();

    await act(async () => {
      await result.current.save({});
    });

    expect(result.current.driveError).toBe('Failed to upload: offline');
    expect(result.current.driveLoading).toBe(false);
  });

  // The button is disabled while loading, but a second call can still be
  // issued before React re-renders — hence the ref guard rather than state.
  it('ignores a second save issued while one is in flight', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ driveUrl: 'https://drive/x' }));
    const { result } = setup();

    let second: unknown;
    await act(async () => {
      const first = result.current.save({ n: 1 });
      second = await result.current.save({ n: 2 });
      await first;
    });

    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resetDrive clears a previous link and error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ driveUrl: 'https://drive/x' }),
    );
    const { result } = setup();
    await act(async () => {
      await result.current.save({});
    });

    act(() => result.current.resetDrive());

    expect(result.current.driveLink).toBeNull();
    expect(result.current.driveError).toBeNull();
  });
});
