import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same thenable-queue mock as show-lookup.test.ts: each awaited sql`...`
// resolves to the next queued row set.
const queue: unknown[][] = [];

vi.mock('./db', () => ({
  sql: () => ({
    then: (resolve: (v: unknown) => void) => resolve(queue.shift() ?? []),
  }),
}));

import { recentEpisodesDigest } from './recent-episodes';

beforeEach(() => {
  queue.length = 0;
});

describe('recentEpisodesDigest', () => {
  it('lists air date + title with the continuity instruction', async () => {
    queue.push([
      { date: '2026-07-29', title: 'Iran, AIPAC, and the online antisemitism surge' },
      { date: '2026-07-28', title: 'Trump and Netanyahu meet as Iran tensions rise' },
    ]);

    const digest = await recentEpisodesDigest(3);
    expect(digest).toContain('== Recently Aired Ark News Daily Episodes ==');
    expect(digest).toContain('- 2026-07-29 — Iran, AIPAC, and the online antisemitism surge');
    expect(digest).toContain('- 2026-07-28 — Trump and Netanyahu meet as Iran tensions rise');
    // The instruction that makes the list useful: continuity, not repetition.
    expect(digest).toContain('do not pitch a story a recent episode already covered');
    expect(digest).toContain('searchCorpus');
  });

  it('returns empty for an unknown show id so the context section is omitted', async () => {
    expect(await recentEpisodesDigest(null)).toBe('');
  });

  it('returns empty when nothing has aired', async () => {
    queue.push([]);
    expect(await recentEpisodesDigest(3)).toBe('');
  });
});
