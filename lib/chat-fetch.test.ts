import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatFetch } from './chat-fetch';

describe('chatFetch', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the response unchanged when status is 2xx', async () => {
    const ok = new Response('streaming body', { status: 200 });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok);

    const res = await chatFetch('/api/chat');
    expect(res).toBe(ok);
  });

  it('throws an error prefixed with status and statusText on a non-2xx response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );

    await expect(chatFetch('/api/chat')).rejects.toThrow('[404 Not Found] not found');
  });

  it('still throws with the status prefix when the body is empty', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('', { status: 502, statusText: 'Bad Gateway' }),
    );

    await expect(chatFetch('/api/chat')).rejects.toThrow('[502 Bad Gateway]');
  });

  it('propagates network errors from the underlying fetch', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );

    await expect(chatFetch('/api/chat')).rejects.toThrow('Failed to fetch');
  });
});
