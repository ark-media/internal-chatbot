import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateObject } from 'ai';

vi.mock('ai', () => ({ generateObject: vi.fn() }));

// Import AFTER the mock is registered.
import { clusterCandidates } from './cluster';
import type { Candidate } from './types';

const mockGen = vi.mocked(generateObject);

function cand(title: string): Candidate {
  return {
    title,
    url: `https://www.timesofisrael.com/${encodeURIComponent(title)}`,
    source: 'Times of Israel',
    publicationDate: '2026-05-14',
  };
}

// Resolve the next generateObject call with a themes payload.
function resolveThemes(themes: { theme: string; candidateIndices: number[] }[]) {
  mockGen.mockResolvedValue({ object: { themes } } as never);
}

describe('clusterCandidates', () => {
  beforeEach(() => {
    mockGen.mockReset();
  });

  it('tags each candidate and reorders so themes are contiguous in model order', async () => {
    const input = [cand('A'), cand('B'), cand('C'), cand('D')];
    resolveThemes([
      { theme: 'Iran', candidateIndices: [2, 0] },
      { theme: 'US politics', candidateIndices: [3, 1] },
    ]);

    const out = await clusterCandidates(input);

    // Iran group first (A, C in original order), then US politics (B, D).
    expect(out.map((c) => c.title)).toEqual(['A', 'C', 'B', 'D']);
    expect(out.map((c) => c.theme)).toEqual(['Iran', 'Iran', 'US politics', 'US politics']);
    expect(out).toHaveLength(input.length);
  });

  it('buckets unassigned candidates under "Other", placed last', async () => {
    const input = [cand('A'), cand('B'), cand('C')];
    resolveThemes([{ theme: 'Iran', candidateIndices: [0] }]);

    const out = await clusterCandidates(input);

    expect(out.map((c) => c.title)).toEqual(['A', 'B', 'C']);
    expect(out.map((c) => c.theme)).toEqual(['Iran', 'Other', 'Other']);
  });

  it('ignores out-of-range and duplicate indices without dropping candidates', async () => {
    const input = [cand('A'), cand('B')];
    resolveThemes([
      { theme: 'Iran', candidateIndices: [0, 5, 0] }, // 5 is out of range, second 0 is a dup
      { theme: 'US politics', candidateIndices: [1] },
    ]);

    const out = await clusterCandidates(input);

    expect(out).toHaveLength(2);
    expect(out.find((c) => c.title === 'A')?.theme).toBe('Iran');
    expect(out.find((c) => c.title === 'B')?.theme).toBe('US politics');
  });

  it('folds a model-named "Other" theme in with the stragglers', async () => {
    const input = [cand('A'), cand('B'), cand('C')];
    resolveThemes([
      { theme: 'Iran', candidateIndices: [0] },
      { theme: 'Other', candidateIndices: [1] }, // B explicitly "Other"; C unassigned
    ]);

    const out = await clusterCandidates(input);

    expect(out.map((c) => c.theme)).toEqual(['Iran', 'Other', 'Other']);
    expect(out.map((c) => c.title)).toEqual(['A', 'B', 'C']);
  });

  it('short-circuits a single-candidate list without calling the model', async () => {
    const input = [cand('A')];
    const out = await clusterCandidates(input);
    expect(out).toEqual(input);
    expect(mockGen).not.toHaveBeenCalled();
  });
});
