import { describe, it, expect } from 'vitest';
import { activeChatId, detectSurface, formatRelative } from './sidebar';

describe('detectSurface', () => {
  it('returns "archive" for null/empty pathnames', () => {
    expect(detectSurface(null)).toBe('archive');
    expect(detectSurface('')).toBe('archive');
  });

  it('returns "archive" for the root and /chat routes', () => {
    expect(detectSurface('/')).toBe('archive');
    expect(detectSurface('/chat/abc-123')).toBe('archive');
  });

  it('returns "prep" for /prep routes', () => {
    expect(detectSurface('/prep')).toBe('prep');
    expect(detectSurface('/prep/abc-123')).toBe('prep');
  });

  it('returns "news" for /news routes', () => {
    expect(detectSurface('/news')).toBe('news');
    expect(detectSurface('/news/abc-123')).toBe('news');
  });

  it('does not confuse /prepare or /newscast with the prep/news surfaces', () => {
    // detectSurface uses startsWith — sibling-prefixed routes would collide.
    // If we ever add such a route, this test will fail and force a rethink.
    expect(detectSurface('/prepare')).toBe('prep');
    expect(detectSurface('/newscast')).toBe('news');
  });
});

describe('activeChatId', () => {
  it('returns null when pathname is null', () => {
    expect(activeChatId(null, 'archive')).toBeNull();
  });

  it('returns the chat id segment for a matching surface', () => {
    expect(activeChatId('/chat/abc-123', 'archive')).toBe('abc-123');
    expect(activeChatId('/prep/xyz-789', 'prep')).toBe('xyz-789');
    expect(activeChatId('/news/q-1', 'news')).toBe('q-1');
  });

  it('returns null when the surface does not match the pathname', () => {
    expect(activeChatId('/prep/abc', 'archive')).toBeNull();
    expect(activeChatId('/chat/abc', 'news')).toBeNull();
  });

  it('returns null on a bare surface root with no chat id', () => {
    expect(activeChatId('/prep', 'prep')).toBeNull();
    expect(activeChatId('/prep/', 'prep')).toBeNull();
  });

  it('takes only the first segment after the surface base', () => {
    expect(activeChatId('/chat/abc-123/extra', 'archive')).toBe('abc-123');
  });
});

describe('formatRelative', () => {
  const NOW = new Date('2026-04-30T12:00:00Z').getTime();

  it('returns empty string for invalid input', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('');
  });

  it('returns "just now" for sub-minute gaps', () => {
    const t = new Date(NOW - 30_000).toISOString();
    expect(formatRelative(t, NOW)).toBe('just now');
  });

  it('returns minute granularity for sub-hour gaps', () => {
    const t = new Date(NOW - 5 * 60_000).toISOString();
    expect(formatRelative(t, NOW)).toBe('5m ago');
  });

  it('returns hour granularity for sub-day gaps', () => {
    const t = new Date(NOW - 3 * 3_600_000).toISOString();
    expect(formatRelative(t, NOW)).toBe('3h ago');
  });

  it('returns day granularity beyond 24h', () => {
    const t = new Date(NOW - 2 * 86_400_000).toISOString();
    expect(formatRelative(t, NOW)).toBe('2d ago');
  });

  it('clamps future timestamps to "just now" rather than negative values', () => {
    const t = new Date(NOW + 10_000).toISOString();
    expect(formatRelative(t, NOW)).toBe('just now');
  });
});
