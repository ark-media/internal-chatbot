import { describe, expect, it } from 'vitest';

import { briefFromPlannedTopics, parsePlannedTopics } from './planned-topics';

describe('parsePlannedTopics', () => {
  it('keeps well-formed topics in on-air order, whatever order they arrive in', () => {
    expect(
      parsePlannedTopics([
        { slot: 'C', brief: 'Mel Brooks turns 100' },
        { slot: 'A', brief: 'Hormuz tolls' },
      ]),
    ).toEqual([
      { slot: 'A', brief: 'Hormuz tolls' },
      { slot: 'C', brief: 'Mel Brooks turns 100' },
    ]);
  });

  it('drops blank and whitespace-only fields so unfilled blocks are skipped', () => {
    expect(
      parsePlannedTopics([
        { slot: 'A', brief: 'Hormuz tolls' },
        { slot: 'B', brief: '   ' },
        { slot: 'C', brief: '' },
      ]),
    ).toEqual([{ slot: 'A', brief: 'Hormuz tolls' }]);
  });

  it('trims briefs and accepts a lowercase slot', () => {
    expect(parsePlannedTopics([{ slot: 'b', brief: '  a story  ' }])).toEqual([
      { slot: 'B', brief: 'a story' },
    ]);
  });

  it('ignores malformed entries and unknown slots rather than throwing', () => {
    expect(
      parsePlannedTopics([
        null,
        'nope',
        { slot: 'D', brief: 'off the rundown' },
        { slot: 'A', brief: 42 },
        { slot: 'A', brief: 'real one' },
      ]),
    ).toEqual([{ slot: 'A', brief: 'real one' }]);
  });

  it('takes the first entry for a duplicated slot', () => {
    expect(
      parsePlannedTopics([
        { slot: 'A', brief: 'first' },
        { slot: 'A', brief: 'second' },
      ]),
    ).toEqual([{ slot: 'A', brief: 'first' }]);
  });

  it('returns [] for a non-array payload, falling the run back to the brief path', () => {
    expect(parsePlannedTopics(undefined)).toEqual([]);
    expect(parsePlannedTopics({})).toEqual([]);
  });
});

describe('briefFromPlannedTopics', () => {
  it('renders a readable brief carrying every named topic', () => {
    const brief = briefFromPlannedTopics([
      { slot: 'A', brief: 'Hormuz tolls' },
      { slot: 'C', brief: 'Mel Brooks turns 100' },
    ]);
    expect(brief).toContain('A — Hormuz tolls');
    expect(brief).toContain('C — Mel Brooks turns 100');
    expect(brief).not.toContain('B —');
  });
});
