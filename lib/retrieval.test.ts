import { describe, it, expect, vi } from 'vitest';

// retrieval.ts imports './db' which throws at module load when DATABASE_URL
// isn't set. roundRobinMergeChunks is a pure function and never touches sql,
// but the module-level import still has to resolve. Mock it with a no-op tag.
vi.mock('./db', () => ({
  sql: () => Promise.resolve([]),
}));
vi.mock('./voyage-http', () => ({
  embedQuery: () => Promise.resolve([]),
  rerank: () => Promise.resolve([]),
}));

import { roundRobinMergeChunks, type RetrievedChunk } from './retrieval';

const c = (id: number): RetrievedChunk => ({
  chunkId: id,
  episodeId: `ep-${id}`,
  chunkIndex: 0,
  showId: 0,
  showName: '',
  title: '',
  date: null,
  section: null,
  driveUrl: null,
  text: '',
  startTurnId: 0,
  endTurnId: 0,
  score: 0,
});

describe('roundRobinMergeChunks', () => {
  it('interleaves rank-0 across subqueries before going to rank-1', () => {
    const result = roundRobinMergeChunks(
      [
        [c(1), c(2), c(3)],
        [c(4), c(5)],
        [c(6)],
      ],
      6,
    );
    expect(result.map((r) => r.chunkId)).toEqual([1, 4, 6, 2, 5, 3]);
  });

  it('dedupes chunks shared across subqueries', () => {
    const result = roundRobinMergeChunks(
      [
        [c(1), c(2)],
        [c(1), c(3)],
      ],
      4,
    );
    // Round 0: subq0 inserts 1; subq1's 1 is dedup-skipped.
    // Round 1: subq0 inserts 2; subq1 inserts 3.
    expect(result.map((r) => r.chunkId)).toEqual([1, 2, 3]);
  });

  it('respects the limit even when more chunks are available', () => {
    const result = roundRobinMergeChunks(
      [
        [c(1), c(2), c(3)],
        [c(4), c(5), c(6)],
      ],
      3,
    );
    expect(result.map((r) => r.chunkId)).toEqual([1, 4, 2]);
  });

  it('biases to the first subquery within a round', () => {
    // With three subqueries all returning unique chunks, round 0 emits
    // them in subquery order: 1, 10, 100.
    const result = roundRobinMergeChunks(
      [[c(1)], [c(10)], [c(100)]],
      3,
    );
    expect(result.map((r) => r.chunkId)).toEqual([1, 10, 100]);
  });

  it('handles empty input and uneven subquery lengths', () => {
    expect(roundRobinMergeChunks([], 5)).toEqual([]);
    expect(roundRobinMergeChunks([[]], 5)).toEqual([]);
    const result = roundRobinMergeChunks([[c(1), c(2), c(3)], []], 5);
    expect(result.map((r) => r.chunkId)).toEqual([1, 2, 3]);
  });

  it('returns an empty array when limit is 0', () => {
    const result = roundRobinMergeChunks([[c(1), c(2)]], 0);
    expect(result).toEqual([]);
  });
});
