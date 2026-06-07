import { describe, expect, it } from 'vitest';

import { assembleArc, extractedOrderArc } from './arrange';
import type { ExtractedStory } from './types';

const story = (id: string, over: Partial<ExtractedStory> = {}): ExtractedStory => ({
  id,
  headline: `Headline ${id}`,
  dryFacts: [],
  relevance: `why ${id} matters`,
  sources: [],
  ...over,
});

const trump = story('trump');
const mou = story('mou');
const gaza = story('gaza');
const stories = [trump, mou, gaza];

describe('assembleArc', () => {
  it('keeps a consistent A→B→C model response untouched', () => {
    const arc = assembleArc(
      [
        { id: 'trump', role: 'A', transition: 't1' },
        { id: 'mou', role: 'B', transition: 't2' },
        { id: 'gaza', role: 'C', transition: '' },
      ],
      stories,
      'rationale',
    );
    expect(arc.order).toEqual(['trump', 'mou', 'gaza']);
    expect(arc.leadId).toBe('trump');
    expect(arc.roles).toEqual({ trump: 'A', mou: 'B', gaza: 'C' });
    expect(arc.transitions).toEqual({ trump: 't1', mou: 't2', gaza: '' });
  });

  it('reorders to match roles when the model lists the C close in the B slot', () => {
    // The bug repro: roles/transitions say A=trump→B=mou→C=gaza, but the array
    // physically lists gaza second and mou third.
    const arc = assembleArc(
      [
        { id: 'trump', role: 'A', transition: 'into the mou story' },
        { id: 'gaza', role: 'C', transition: '' },
        { id: 'mou', role: 'B', transition: 'into the gaza story' },
      ],
      stories,
      'rationale',
    );
    expect(arc.order).toEqual(['trump', 'mou', 'gaza']);
    expect(arc.roles).toEqual({ trump: 'A', mou: 'B', gaza: 'C' });
    // The transition the model wrote for trump (the mou bridge) now sits with
    // trump, ahead of mou — not stranded above gaza.
    expect(arc.transitions.trump).toBe('into the mou story');
    expect(arc.transitions.mou).toBe('into the gaza story');
    // The genuine last story keeps its empty transition.
    expect(arc.transitions.gaza).toBe('');
  });

  it('drops unknown ids and duplicate ids', () => {
    const arc = assembleArc(
      [
        { id: 'trump', role: 'A', transition: 't1' },
        { id: 'ghost', role: 'B', transition: 'bogus' },
        { id: 'trump', role: 'C', transition: 'dupe' },
        { id: 'mou', role: 'B', transition: 't2' },
      ],
      stories,
      'rationale',
    );
    // 'ghost' dropped, second 'trump' dropped; 'gaza' was omitted so appended D.
    expect(arc.order).toEqual(['trump', 'mou', 'gaza']);
    expect(arc.roles).toEqual({ trump: 'A', mou: 'B', gaza: 'D' });
    expect(arc.transitions.trump).toBe('t1');
  });

  it('appends omitted stories as role D, last, in input order', () => {
    const arc = assembleArc(
      [{ id: 'mou', role: 'A', transition: 't' }],
      stories,
      'rationale',
    );
    // trump and gaza were omitted; they land after mou as D, in input order.
    expect(arc.order).toEqual(['mou', 'trump', 'gaza']);
    expect(arc.roles).toEqual({ mou: 'A', trump: 'D', gaza: 'D' });
  });

  it('keeps relative order for ties within the same role (stable sort)', () => {
    const arc = assembleArc(
      [
        { id: 'gaza', role: 'B', transition: 'g' },
        { id: 'mou', role: 'B', transition: 'm' },
        { id: 'trump', role: 'A', transition: 't' },
      ],
      stories,
      'rationale',
    );
    // A sorts ahead; the two B's keep their array order (gaza before mou).
    expect(arc.order).toEqual(['trump', 'gaza', 'mou']);
  });

  it('handles an empty model response by appending every story as D', () => {
    const arc = assembleArc([], stories, 'rationale');
    expect(arc.order).toEqual(['trump', 'mou', 'gaza']);
    expect(arc.leadId).toBe('trump');
    expect(arc.roles).toEqual({ trump: 'D', mou: 'D', gaza: 'D' });
  });
});

describe('extractedOrderArc', () => {
  it('keeps extracted order, gives the lead A and the rest their blockHint or D', () => {
    const arc = extractedOrderArc([
      story('a'),
      story('b', { blockHint: 'C' }),
      story('c'),
    ]);
    expect(arc.order).toEqual(['a', 'b', 'c']);
    expect(arc.leadId).toBe('a');
    expect(arc.roles).toEqual({ a: 'A', b: 'C', c: 'D' });
    expect(arc.transitions).toEqual({});
  });

  it('returns an empty-ish arc for no stories', () => {
    const arc = extractedOrderArc([]);
    expect(arc.order).toEqual([]);
    expect(arc.leadId).toBe('');
  });
});
