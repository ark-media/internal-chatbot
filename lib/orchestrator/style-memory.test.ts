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
  it.each([
    ['strips a single HTML comment', '<!-- note --> body', 'body'],
    ['strips multiple HTML comments', '<!-- a -->mid<!-- b -->', 'mid'],
    [
      'strips a multi-line HTML comment',
      '<!--\n  block-style note that spans\n  multiple lines\n-->\nreal content',
      'real content',
    ],
    ['comment-only input yields empty', '<!-- only a note -->', ''],
    ['comment-only input with padding yields empty', '   <!-- pad -->   ', ''],
    ['trims when there are no comments', '  hello world  ', 'hello world'],
    // Only paired <!-- ... --> tokens are stripped. Stray angle brackets stay.
    [
      'leaves unpaired angle brackets in the body',
      'use < and > in prose',
      'use < and > in prose',
    ],
  ])('%s', (_case, input, expected) => {
    expect(normalizeProfileText(input)).toBe(expected);
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
  // Case, refineHistoryLength, lastDistilledVersion, expected.
  it.each([
    ['already distilled at this exact version', 3, 3, true],
    ['refineHistory has grown since last distillation', 5, 3, false],
    // After undo, the recorded version points at a *future* state. The route
    // should NOT short-circuit — the writer is on a different version now. The
    // undo route also clears lastDistilledVersion, but the helper defends
    // against the stale value too.
    ['undo dropped refineHistory below lastDistilledVersion', 2, 3, false],
    ['never distilled before', 4, undefined, false],
    // The route has a separate `scriptVersions.length === 0` guard that returns
    // 409 before reaching this helper, so length 0 never occurs in production.
    // Verify the pure rule anyway.
    ['refineHistory is empty, nothing to learn from', 0, undefined, false],
  ])('%s', (_case, refineHistoryLength, lastDistilledVersion, expected) => {
    expect(
      shouldSkipDistillation({ refineHistoryLength, lastDistilledVersion }),
    ).toBe(expected);
  });
});
