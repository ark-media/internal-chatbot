import { describe, expect, it } from 'vitest';

import {
  applyExclusions,
  applyNovelty,
  dropDuplicates,
  applySignificance,
  collapseCorroboration,
  significanceSchema,
  routeTiers,
  runBreakingScan,
  noveltySchema,
  exclusionSchema,
  filterByCutoff,
  resolveCutoff,
  discoverScriptFollowups,
  type BreakingCandidate,
  type ScanProgress,
} from './breaking-scan';

// A small candidate factory for gate tests.
function cand(over: Partial<BreakingCandidate> = {}): BreakingCandidate {
  return {
    title: 'Some headline',
    url: 'https://reuters.com/story',
    source: 'Reuters',
    publicationDate: '2026-06-30',
    ...over,
  };
}

describe('resolveCutoff', () => {
  const now = '2026-06-30T22:00:00.000Z'; // 6pm ET

  it('defaults to the provided now when lockedAt is absent', () => {
    expect(resolveCutoff({ now })).toBe(now);
  });

  it('returns the override as an ISO timestamp for a valid lockedAt', () => {
    const lockedAt = '2026-06-30T20:15:00.000Z'; // 4:15pm ET, ~2h before now
    expect(resolveCutoff({ lockedAt, now })).toBe(new Date(lockedAt).toISOString());
  });

  it('rejects a lockedAt in the future', () => {
    const lockedAt = '2026-06-30T23:00:00.000Z'; // an hour after now
    expect(() => resolveCutoff({ lockedAt, now })).toThrow(/future/i);
  });

  it('rejects a lockedAt more than 12h before now', () => {
    const lockedAt = '2026-06-30T08:00:00.000Z'; // 14h before now
    expect(() => resolveCutoff({ lockedAt, now })).toThrow(/12 hours/i);
  });
});

describe('filterByCutoff', () => {
  const cutoff = '2026-06-30T20:15:00.000Z'; // cutoff day = 2026-06-30

  it('drops candidates published strictly before the cutoff day', () => {
    const kept = filterByCutoff(
      [{ url: 'https://reuters.com/old', publicationDate: '2026-06-29' }],
      cutoff,
    );
    expect(kept).toHaveLength(0);
  });

  it('keeps candidates published on or after the cutoff day', () => {
    const kept = filterByCutoff(
      [
        { url: 'https://reuters.com/same', publicationDate: '2026-06-30' },
        { url: 'https://reuters.com/after', publicationDate: '2026-07-01' },
      ],
      cutoff,
    );
    expect(kept.map((c) => c.url)).toEqual([
      'https://reuters.com/same',
      'https://reuters.com/after',
    ]);
    expect(kept.every((c) => !c.dateUncertain)).toBe(true);
  });

  it('retains undated candidates and flags them dateUncertain', () => {
    const kept = filterByCutoff(
      [
        { url: 'https://reuters.com/undated', publicationDate: null },
        { url: 'https://reuters.com/garbage', publicationDate: 'not a date' },
      ],
      cutoff,
    );
    expect(kept).toHaveLength(2);
    expect(kept.every((c) => c.dateUncertain === true)).toBe(true);
  });

  it('drops a same-day story whose precise timestamp predates the lock', () => {
    // cutoff is 2026-06-30T20:15Z; a story timestamped earlier the same day is
    // provably pre-lock and must not survive as "same day".
    const kept = filterByCutoff(
      [{ url: 'https://reuters.com/morning', publicationDate: 'Tue, 30 Jun 2026 09:14:00 GMT' }],
      cutoff,
    );
    expect(kept).toHaveLength(0);
  });

  it('keeps a same-day story whose precise timestamp is after the lock', () => {
    const kept = filterByCutoff(
      [{ url: 'https://reuters.com/evening', publicationDate: 'Tue, 30 Jun 2026 21:00:00 GMT' }],
      cutoff,
    );
    expect(kept.map((c) => c.url)).toEqual(['https://reuters.com/evening']);
    expect(kept[0].dateUncertain).toBeUndefined();
  });
});

describe('Gate 0: exclusion classifier', () => {
  it('accepts a well-formed classifier output object', () => {
    const sample = {
      verdicts: [
        { index: 0, excluded: true, exclusionReason: 'op-ed' },
        { index: 1, excluded: false },
        { index: 2, excluded: true, exclusionReason: 'routine market move' },
      ],
    };
    expect(() => exclusionSchema.parse(sample)).not.toThrow();
  });

  it('rejects a malformed classifier output object', () => {
    expect(() => exclusionSchema.parse({ verdicts: [{ index: 0 }] })).toThrow();
    expect(() => exclusionSchema.parse({ verdicts: [{ index: -1, excluded: true }] })).toThrow();
  });

  it('applyExclusions tags candidates by index and defaults unrated to kept', () => {
    const candidates = [cand({ title: 'Op-ed' }), cand({ title: 'Real story' }), cand({ title: 'Unrated' })];
    const tagged = applyExclusions(candidates, {
      verdicts: [
        { index: 0, excluded: true, exclusionReason: 'op-ed' },
        { index: 1, excluded: false },
      ],
    });
    expect(tagged[0].excluded).toBe(true);
    expect(tagged[0].exclusionReason).toBe('op-ed');
    expect(tagged[1].excluded).toBe(false);
    expect(tagged[2].excluded).toBe(false); // unrated → kept
  });
});

describe('Gate 2: novelty diff', () => {
  it('accepts a well-formed novelty output object', () => {
    const sample = {
      verdicts: [
        { index: 0, novelty: 'NEW' as const },
        { index: 1, novelty: 'UPDATE' as const, updatesBlock: 'A' },
        { index: 2, novelty: 'DUPLICATE' as const },
      ],
    };
    expect(() => noveltySchema.parse(sample)).not.toThrow();
  });

  it('rejects an out-of-enum novelty label', () => {
    expect(() => noveltySchema.parse({ verdicts: [{ index: 0, novelty: 'STALE' }] })).toThrow();
  });

  it('applyNovelty tags candidates and carries updatesBlock for UPDATE', () => {
    const candidates = [cand({ title: 'New event' }), cand({ title: 'Ceasefire collapsed' })];
    const tagged = applyNovelty(candidates, {
      verdicts: [
        { index: 0, novelty: 'NEW' },
        { index: 1, novelty: 'UPDATE', updatesBlock: 'A' },
      ],
    });
    expect(tagged[0].novelty).toBe('NEW');
    expect(tagged[1].novelty).toBe('UPDATE');
    expect(tagged[1].updatesBlock).toBe('A');
  });

  it('dropDuplicates removes DUPLICATE candidates from the pipeline', () => {
    const candidates = [cand({ title: 'Keep new' }), cand({ title: 'Already covered' })];
    const tagged = applyNovelty(candidates, {
      verdicts: [
        { index: 0, novelty: 'NEW' },
        { index: 1, novelty: 'DUPLICATE' },
      ],
    });
    const survivors = dropDuplicates(tagged);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].title).toBe('Keep new');
  });
});

describe('Gate 3: significance + corroboration', () => {
  it('accepts a well-formed significance output object', () => {
    const sample = {
      verdicts: [
        {
          index: 0,
          independentSources: 2,
          primarySource: 'Reuters',
          confidence: 'confirmed' as const,
          significance: 'high' as const,
          onBeat: true,
        },
      ],
    };
    expect(() => significanceSchema.parse(sample)).not.toThrow();
  });

  it('keeps a 2-independent-outlet story at independentSources >= 2', () => {
    const graded = applySignificance([cand()], {
      verdicts: [
        { index: 0, independentSources: 2, primarySource: 'Reuters', confidence: 'confirmed', significance: 'high', onBeat: true },
      ],
    });
    const collapsed = collapseCorroboration(graded);
    expect(collapsed[0].corroboration?.independentSources).toBeGreaterThanOrEqual(2);
  });

  it('collapses 4 candidates tracing to one journalist to independentSources: 1', () => {
    const candidates = [cand({ url: 'https://a.com/1' }), cand({ url: 'https://b.com/2' }), cand({ url: 'https://c.com/3' }), cand({ url: 'https://d.com/4' })];
    const graded = applySignificance(candidates, {
      verdicts: candidates.map((_, i) => ({
        index: i,
        independentSources: 4,
        primarySource: 'Barak Ravid',
        confidence: 'confirmed' as const,
        significance: 'medium' as const,
        onBeat: true,
      })),
    });
    const collapsed = collapseCorroboration(graded);
    expect(collapsed.every((c) => c.corroboration?.independentSources === 1)).toBe(true);
  });

  it('marks a single curated-X-handle story provisional even if graded confirmed', () => {
    const xCand = cand({ source: 'Barak Ravid', sourceHandle: '@BarakRavid', url: 'https://x.com/BarakRavid/status/1' });
    const graded = applySignificance([xCand], {
      verdicts: [
        { index: 0, independentSources: 1, primarySource: '@BarakRavid', confidence: 'confirmed', significance: 'high', onBeat: true },
      ],
    });
    expect(graded[0].confidence).toBe('provisional');
  });
});

describe('T-008: tier routing', () => {
  const CUTOFF = '2026-06-30T20:15:00.000Z';

  // A fully-graded candidate, override per-test.
  function graded(over: Partial<BreakingCandidate>): BreakingCandidate {
    return cand({
      novelty: 'NEW',
      onBeat: true,
      confidence: 'confirmed',
      significance: 'high',
      globalShock: false,
      corroboration: { independentSources: 2, primarySource: 'Reuters' },
      ...over,
    });
  }

  it('off-beat NEW cannot reach Swap', () => {
    const { suggestions } = routeTiers([graded({ onBeat: false, novelty: 'NEW' })], CUTOFF);
    expect(suggestions).toHaveLength(0);
  });

  it('a medium/low-significance NEW on-beat story does not clear the Swap bar', () => {
    const medium = routeTiers([graded({ novelty: 'NEW', significance: 'medium' })], CUTOFF);
    expect(medium.suggestions).toHaveLength(0);
    const low = routeTiers([graded({ novelty: 'NEW', significance: 'low' })], CUTOFF);
    expect(low.suggestions).toHaveLength(0);
  });

  it('a high-significance NEW on-beat story reaches Swap', () => {
    const { suggestions } = routeTiers([graded({ novelty: 'NEW', significance: 'high' })], CUTOFF);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].tier).toBe('Swap');
  });

  it('off-beat global-shock + confirmed reaches Can\'t-ignore', () => {
    const { suggestions } = routeTiers(
      [graded({ onBeat: false, globalShock: true, confidence: 'confirmed' })],
      CUTOFF,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].tier).toBe("Can't-ignore");
  });

  it('off-beat global-shock + provisional does NOT reach Can\'t-ignore', () => {
    const { suggestions } = routeTiers(
      [graded({ onBeat: false, globalShock: true, confidence: 'provisional' })],
      CUTOFF,
    );
    expect(suggestions).toHaveLength(0);
  });

  it('orders tiers and caps at 5 with suppressedCount reporting the remainder', () => {
    const many: BreakingCandidate[] = [
      graded({ title: 'Swap 1', novelty: 'NEW' }),
      graded({ title: 'Swap 2', novelty: 'NEW' }),
      graded({ title: 'Swap 3', novelty: 'NEW' }),
      graded({ title: 'Update 1', novelty: 'UPDATE', updatesBlock: 'B' }),
      graded({ title: 'Update 2', novelty: 'UPDATE', updatesBlock: 'A' }),
      graded({ title: 'Shock', onBeat: false, globalShock: true, confidence: 'confirmed' }),
      graded({ title: 'Swap 4', novelty: 'NEW' }),
    ];
    const { suggestions, suppressedCount } = routeTiers(many, CUTOFF);
    expect(suggestions).toHaveLength(5);
    expect(suppressedCount).toBe(2);
    // Can't-ignore first, then Updates, then Swaps.
    expect(suggestions[0].tier).toBe("Can't-ignore");
    expect(suggestions[1].tier).toBe('Update');
    expect(suggestions[2].tier).toBe('Update');
    expect(suggestions[3].tier).toBe('Swap');
  });

  it('flags a provisional Swap as unconfirmed and names the weakest block', () => {
    const { suggestions } = routeTiers(
      [graded({ novelty: 'NEW', confidence: 'provisional', sourceHandle: '@BarakRavid' })],
      CUTOFF,
    );
    expect(suggestions[0].tier).toBe('Swap');
    expect(suggestions[0].flaggedUnconfirmed).toBe(true);
    expect(suggestions[0].block).toBe('C');
  });

  it('names the updated block for an Update', () => {
    const { suggestions } = routeTiers([graded({ novelty: 'UPDATE', updatesBlock: 'A' })], CUTOFF);
    expect(suggestions[0].tier).toBe('Update');
    expect(suggestions[0].block).toBe('A');
  });

  it('returns an empty result when nothing qualifies, echoing the cutoff', () => {
    const { suggestions, suppressedCount, cutoff } = routeTiers([], CUTOFF);
    expect(suggestions).toEqual([]);
    expect(suppressedCount).toBe(0);
    expect(cutoff).toBe(CUTOFF);
  });
});

describe('discoverScriptFollowups', () => {
  const coverage = { blocks: [{ label: 'A', text: 'A Gaza ceasefire is holding.' }], sources: [] };
  const CUTOFF = '2026-06-30T20:15:00.000Z';

  it('searches each query and merges approved, deduped, post-cutoff candidates', async () => {
    const out = await discoverScriptFollowups(
      { coverage, cutoff: CUTOFF },
      {
        extractQueries: async () => [
          { block: 'A', query: 'Gaza ceasefire' },
          { block: 'B', query: 'Khamenei funeral' },
        ],
        search: async (q) =>
          q === 'Gaza ceasefire'
            ? [
                { title: 'Ceasefire collapses', url: 'https://reuters.com/ceasefire', source: 'Reuters', publicationDate: '2026-07-01' },
                { title: 'dup url', url: 'https://reuters.com/ceasefire', source: 'Reuters', publicationDate: '2026-07-01' },
                { title: 'old story', url: 'https://reuters.com/old', source: 'Reuters', publicationDate: '2026-06-01' },
                { title: 'off-list', url: 'https://example.com/x', source: 'example', publicationDate: '2026-07-01' },
              ]
            : [{ title: 'Funeral latest', url: 'https://jpost.com/funeral', source: 'JPost', publicationDate: '2026-07-01' }],
      },
    );
    // Dedup collapses the repeated URL, the pre-cutoff story and the off-list
    // domain are dropped, leaving one survivor per query.
    expect(out.map((c) => c.url).sort()).toEqual([
      'https://jpost.com/funeral',
      'https://reuters.com/ceasefire',
    ]);
  });

  it('returns [] when the script has no blocks (no queries to run)', async () => {
    const out = await discoverScriptFollowups(
      { coverage: { blocks: [], sources: [] }, cutoff: CUTOFF },
      { extractQueries: async () => [], search: async () => [] },
    );
    expect(out).toEqual([]);
  });

  it('survives a failing per-query search', async () => {
    const out = await discoverScriptFollowups(
      { coverage, cutoff: CUTOFF },
      {
        extractQueries: async () => [
          { block: 'A', query: 'boom' },
          { block: 'B', query: 'ok' },
        ],
        search: async (q) => {
          if (q === 'boom') throw new Error('search 500');
          return [{ title: 'ok', url: 'https://reuters.com/ok', source: 'Reuters', publicationDate: '2026-07-01' }];
        },
      },
    );
    expect(out.map((c) => c.url)).toEqual(['https://reuters.com/ok']);
  });
});

describe('T-009: runBreakingScan pipeline', () => {
  const SCRIPT = `[A BLOCK]
HOST:
A ceasefire is holding in Gaza.

[C BLOCK]
A lighter close.

---

SOURCES:

1. Reuters — https://reuters.com/ceasefire — June 30 2026`;

  it('runs discovery → gates → routing with stubs, dropping excluded and DUPLICATE items', async () => {
    const discovered: BreakingCandidate[] = [
      cand({ title: 'Op-ed we exclude', url: 'https://reuters.com/oped' }),
      cand({ title: 'Already covered', url: 'https://reuters.com/dup' }),
      cand({ title: 'Fresh on-beat NEW story', url: 'https://reuters.com/new' }),
    ];

    const result = await runBreakingScan(
      { script: SCRIPT, today: '2026-06-30', now: '2026-06-30T22:00:00.000Z' },
      {
        discover: async () => discovered,
        classifyExclusions: async (cs) =>
          cs.map((c) => ({ ...c, excluded: c.title.startsWith('Op-ed') })),
        classifyNovelty: async (cs) =>
          cs.map((c) => ({
            ...c,
            novelty: c.title.startsWith('Already') ? ('DUPLICATE' as const) : ('NEW' as const),
          })),
        gradeSignificance: async (cs) =>
          cs.map((c) => ({
            ...c,
            onBeat: true,
            confidence: 'confirmed' as const,
            significance: 'high' as const,
            globalShock: false,
            corroboration: { independentSources: 2, primarySource: 'Reuters' },
          })),
      },
    );

    // Only the fresh NEW story survives; excluded + DUPLICATE never appear.
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].headline).toBe('Fresh on-beat NEW story');
    expect(result.suggestions[0].tier).toBe('Swap');
    expect(result.suggestions.some((s) => s.headline.includes('Op-ed'))).toBe(false);
    expect(result.suggestions.some((s) => s.headline.includes('Already'))).toBe(false);
    // The result echoes the resolved cutoff and reports suppression.
    expect(result.cutoff).toBe('2026-06-30T22:00:00.000Z');
    expect(result.suppressedCount).toBe(0);
  });

  it('honors an explicit lockedAt as the cutoff', async () => {
    const result = await runBreakingScan(
      {
        script: SCRIPT,
        lockedAt: '2026-06-30T20:15:00.000Z',
        today: '2026-06-30',
        now: '2026-06-30T22:00:00.000Z',
      },
      {
        discover: async () => [],
        classifyExclusions: async (cs) => cs,
        classifyNovelty: async (cs) => cs,
        gradeSignificance: async (cs) => cs,
      },
    );
    expect(result.cutoff).toBe('2026-06-30T20:15:00.000Z');
    expect(result.suggestions).toEqual([]);
  });

  it('emits stage progress in pipeline order with survivor counts', async () => {
    const events: ScanProgress[] = [];
    await runBreakingScan(
      {
        script: SCRIPT,
        today: '2026-06-30',
        now: '2026-06-30T22:00:00.000Z',
        onProgress: (ev) => events.push(ev),
      },
      {
        discover: async () => [
          cand({ title: 'a', url: 'https://reuters.com/a' }),
          cand({ title: 'b', url: 'https://reuters.com/b' }),
        ],
        // Drop one at exclusion, keep the rest through to a single NEW suggestion.
        classifyExclusions: async (cs) =>
          cs.map((c, i) => ({ ...c, excluded: i === 0 })),
        classifyNovelty: async (cs) => cs.map((c) => ({ ...c, novelty: 'NEW' as const })),
        gradeSignificance: async (cs) =>
          cs.map((c) => ({
            ...c,
            onBeat: true,
            confidence: 'confirmed' as const,
            significance: 'high' as const,
            globalShock: false,
            corroboration: { independentSources: 2, primarySource: 'Reuters' },
          })),
      },
    );

    expect(events).toEqual([
      { stage: 'discovering' },
      { stage: 'discovered', count: 2 },
      { stage: 'exclusion', count: 1 },
      { stage: 'novelty', count: 1 },
      { stage: 'grading' },
      { stage: 'done', count: 1 },
    ]);
  });
});
