import { describe, it, expect, vi } from 'vitest';

// db.ts throws at import time when DATABASE_URL is unset, so stub the module
// before style-memory imports it. The pure functions under test never touch
// the db, so a no-op mock is sufficient.
vi.mock('../db', () => ({
  sql: vi.fn(),
}));

import {
  buildDistillPrompt,
  MAX_PROFILE_CHARS,
  normalizeProfileText,
  shouldSkipDistillation,
} from './style-memory';

describe('normalizeProfileText', () => {
  it('strips a single HTML comment', () => {
    expect(normalizeProfileText('<!-- note --> body')).toBe('body');
  });

  it('strips multiple HTML comments', () => {
    expect(normalizeProfileText('<!-- a -->mid<!-- b -->')).toBe('mid');
  });

  it('strips multi-line HTML comments', () => {
    const input = `<!--
      block-style note that spans
      multiple lines
    -->
    real content`;
    expect(normalizeProfileText(input)).toBe('real content');
  });

  it('returns empty string when input is comment-only', () => {
    expect(normalizeProfileText('<!-- only a note -->')).toBe('');
    expect(normalizeProfileText('   <!-- pad -->   ')).toBe('');
  });

  it('returns trimmed input when there are no comments', () => {
    expect(normalizeProfileText('  hello world  ')).toBe('hello world');
  });

  it('preserves comment-like content inside the body', () => {
    // Only paired <!-- ... --> tokens are stripped. Stray angle brackets stay.
    expect(normalizeProfileText('use < and > in prose')).toBe(
      'use < and > in prose',
    );
  });
});

describe('buildDistillPrompt', () => {
  const baseInputs = {
    currentProfile: '- prefer short sentences',
    originalDraft: 'INITIAL TEXT',
    finalDraft: 'FINAL TEXT',
    refineInstructions: ['tighten the intro', 'cut the outro pun'],
  };

  it('includes all four labelled sections in order', () => {
    const prompt = buildDistillPrompt(baseInputs);
    const profileIdx = prompt.indexOf('== Current style profile ==');
    const initialIdx = prompt.indexOf('== Initial AI draft ==');
    const finalIdx = prompt.indexOf("== Writer's final draft ==");
    const refineIdx = prompt.indexOf(
      "== Writer's refine instructions (in order) ==",
    );
    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(initialIdx).toBeGreaterThan(profileIdx);
    expect(finalIdx).toBeGreaterThan(initialIdx);
    expect(refineIdx).toBeGreaterThan(finalIdx);
  });

  it('numbers refine instructions in order', () => {
    const prompt = buildDistillPrompt(baseInputs);
    expect(prompt).toContain('1. tighten the intro');
    expect(prompt).toContain('2. cut the outro pun');
  });

  it('marks the profile section as empty on first distillation', () => {
    const prompt = buildDistillPrompt({
      ...baseInputs,
      currentProfile: '',
    });
    expect(prompt).toContain('(empty — first distillation)');
  });

  it('marks the refine block when the writer accepted the initial draft', () => {
    const prompt = buildDistillPrompt({
      ...baseInputs,
      refineInstructions: [],
    });
    expect(prompt).toContain(
      '(no explicit refines — writer accepted the initial draft as-is)',
    );
  });

  it('embeds the draft texts verbatim', () => {
    const prompt = buildDistillPrompt({
      ...baseInputs,
      originalDraft: 'ORIGINAL_MARKER_xyz',
      finalDraft: 'FINAL_MARKER_xyz',
    });
    expect(prompt).toContain('ORIGINAL_MARKER_xyz');
    expect(prompt).toContain('FINAL_MARKER_xyz');
  });

  it('ends with the production instruction', () => {
    const prompt = buildDistillPrompt(baseInputs);
    expect(prompt.trimEnd().endsWith('Produce the updated profile now.')).toBe(
      true,
    );
  });
});

describe('MAX_PROFILE_CHARS', () => {
  it('is exposed as a number for callers that want to check length bounds', () => {
    expect(typeof MAX_PROFILE_CHARS).toBe('number');
    expect(MAX_PROFILE_CHARS).toBeGreaterThan(0);
  });
});

describe('shouldSkipDistillation', () => {
  it('skips when lastDistilledVersion equals refineHistoryLength', () => {
    expect(
      shouldSkipDistillation({
        refineHistoryLength: 3,
        lastDistilledVersion: 3,
      }),
    ).toBe(true);
  });

  it('does not skip when refineHistory has grown since last distillation', () => {
    expect(
      shouldSkipDistillation({
        refineHistoryLength: 5,
        lastDistilledVersion: 3,
      }),
    ).toBe(false);
  });

  it('does not skip when undo has reduced refineHistory below lastDistilledVersion', () => {
    // After undo, the recorded version points at a future state. The route
    // should NOT short-circuit — the writer is on a different version now.
    // The undo route also clears lastDistilledVersion in this case, but the
    // helper itself defends against the stale value too.
    expect(
      shouldSkipDistillation({
        refineHistoryLength: 2,
        lastDistilledVersion: 3,
      }),
    ).toBe(false);
  });

  it('does not skip when there has never been a distillation', () => {
    expect(
      shouldSkipDistillation({
        refineHistoryLength: 4,
        lastDistilledVersion: undefined,
      }),
    ).toBe(false);
  });

  it('does not skip when refineHistory is empty (nothing to learn from)', () => {
    // Note: the route also has a separate `scriptVersions.length === 0` guard
    // that returns 409 before reaching this helper, so the helper never sees
    // refineHistoryLength=0 in production. Verify the pure rule anyway.
    expect(
      shouldSkipDistillation({
        refineHistoryLength: 0,
        lastDistilledVersion: undefined,
      }),
    ).toBe(false);
  });
});
