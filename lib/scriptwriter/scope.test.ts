import { describe, expect, it } from 'vitest';

import { normalizeScope } from './scope';

describe('normalizeScope', () => {
  it('passes through the three canonical shapes', () => {
    expect(normalizeScope({ type: 'episode' })).toEqual({ type: 'episode' });
    expect(normalizeScope({ type: 'blocks', slots: ['A', 'C'] })).toEqual({
      type: 'blocks',
      slots: ['A', 'C'],
    });
    expect(normalizeScope({ type: 'single', slot: 'B', storyHint: 'Hormuz tolls' })).toEqual({
      type: 'single',
      slot: 'B',
      storyHint: 'Hormuz tolls',
    });
  });

  it('collapses degenerate blocks shapes', () => {
    expect(normalizeScope({ type: 'blocks', slots: [] })).toEqual({ type: 'episode' });
    expect(normalizeScope({ type: 'blocks', slots: ['A', 'B', 'C'] })).toEqual({ type: 'episode' });
    expect(normalizeScope({ type: 'blocks', slots: ['C'] })).toEqual({ type: 'single', slot: 'C' });
  });

  it('orders block subsets on-air and defaults single slot to A', () => {
    expect(normalizeScope({ type: 'blocks', slots: ['C', 'A'] })).toEqual({
      type: 'blocks',
      slots: ['A', 'C'],
    });
    expect(normalizeScope({ type: 'single' })).toEqual({ type: 'single', slot: 'A' });
  });

  it('drops a blank storyHint', () => {
    expect(normalizeScope({ type: 'single', slot: 'C', storyHint: '  ' })).toEqual({
      type: 'single',
      slot: 'C',
    });
  });
});
