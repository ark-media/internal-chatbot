import { describe, expect, it } from 'vitest';

import type { Candidate } from '../orchestrator/types';
import type { StorySource } from './types';
import { attachDistilled, discoveryDays, mapSelection, mergeRoundRobin } from './sourcing';

function cand(url: string, date: string | null = '2026-07-14'): Candidate {
  return { title: `title ${url}`, url, source: 'example.com', publicationDate: date };
}

describe('mergeRoundRobin', () => {
  it('interleaves lists so every beat gets a fair share, deduped by URL', () => {
    const merged = mergeRoundRobin(
      [
        [cand('a1'), cand('a2'), cand('a3')],
        [cand('b1'), cand('a1'), cand('b2')], // a1 duplicated across lists
      ],
      10,
    );
    expect(merged.map((c) => c.url)).toEqual(['a1', 'b1', 'a2', 'a3', 'b2']);
  });

  it('sorts each list newest-first before interleaving', () => {
    const merged = mergeRoundRobin(
      [[cand('old', '2026-07-10'), cand('new', '2026-07-15')]],
      10,
    );
    expect(merged.map((c) => c.url)).toEqual(['new', 'old']);
  });

  it('respects the cap', () => {
    const merged = mergeRoundRobin([[cand('a'), cand('b'), cand('c')]], 2);
    expect(merged).toHaveLength(2);
  });
});

describe('discoveryDays', () => {
  it('is 2 on regular days and 3 on Mondays (weekend catch-up)', () => {
    expect(discoveryDays('2026-07-15')).toBe(2); // Wednesday
    expect(discoveryDays('2026-07-13')).toBe(3); // Monday
  });
});

describe('mapSelection', () => {
  const candidates = [cand('u0'), cand('u1'), cand('u2'), cand('u3')];
  const src = (i: number) => ({ candidateIndex: i, credibility: 70, credibilityNote: 'ok' });
  const storyIn = (headline: string, sources: number[]) => ({
    headline,
    angle: 'angle',
    rationale: 'rationale',
    blockSlot: 'A' as const,
    register: 'hard-news' as const,
    sources: sources.map(src),
  });

  it('assigns block slots in scope order regardless of what the model proposed', () => {
    const { stories } = mapSelection(
      {
        stories: [storyIn('one', [0]), storyIn('two', [1]), storyIn('three', [2])],
        backups: [],
      },
      candidates,
      { type: 'episode' },
    );
    expect(stories.map((s) => s.blockSlot)).toEqual(['A', 'B', 'C']);
  });

  it('a scoped run takes only its requested slot', () => {
    const { stories } = mapSelection(
      { stories: [storyIn('one', [0]), storyIn('extra', [1])], backups: [] },
      candidates,
      { type: 'single', slot: 'C' },
    );
    expect(stories).toHaveLength(1);
    expect(stories[0].blockSlot).toBe('C');
  });

  it('drops stories whose candidate references are all invalid, promoting the next', () => {
    const { stories } = mapSelection(
      { stories: [storyIn('ghost', [99]), storyIn('real', [1])], backups: [] },
      candidates,
      { type: 'single', slot: 'A' },
    );
    expect(stories).toHaveLength(1);
    expect(stories[0].headline).toBe('real');
  });

  it('maps backups and skips invalid ones', () => {
    const { backups } = mapSelection(
      {
        stories: [storyIn('main', [0])],
        backups: [
          { headline: 'b1', angle: 'a', rationale: 'r', register: 'human-interest', sources: [src(2)] },
          { headline: 'ghost', angle: 'a', rationale: 'r', register: 'hard-news', sources: [src(99)] },
        ],
      },
      candidates,
      { type: 'single', slot: 'A' },
    );
    expect(backups).toHaveLength(1);
    expect(backups[0].headline).toBe('b1');
    expect(backups[0].sources[0].url).toBe('u2');
  });
});

describe('attachDistilled', () => {
  const src = (url: string, content: string): StorySource => ({
    url,
    title: `t-${url}`,
    source: 's',
    publicationDate: null,
    credibility: 80,
    credibilityNote: 'n',
    content,
  });

  it('maps summaries/quotes back by content-bearing position, skipping empty sources', () => {
    // b has no extracted content, so it drops out of the distill list: c must
    // take filtered index 1, NOT its raw index 2.
    const extracted = [src('a', 'AAA'), src('b', ''), src('c', 'CCC')];
    const distilled = new Map([
      [0, { summary: 'SUM_A', quotes: ['QA'] }],
      [1, { summary: 'SUM_C', quotes: ['QC'] }],
    ]);

    const out = attachDistilled(extracted, distilled);

    expect(out[0].summary).toBe('SUM_A');
    expect(out[0].keyQuotes).toEqual(['QA']);
    expect(out[1].summary).toBeUndefined(); // b skipped
    expect(out[2].summary).toBe('SUM_C'); // c aligned to filtered index 1
    expect(out[2].keyQuotes).toEqual(['QC']);
  });

  it('does not mutate the input sources', () => {
    const extracted = [src('a', 'AAA')];
    attachDistilled(extracted, new Map([[0, { summary: 'X' }]]));
    expect(extracted[0].summary).toBeUndefined();
  });
});
