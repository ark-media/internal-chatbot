import { describe, expect, it } from 'vitest';

import { allInScopeApproved, newRun, type ScriptRun, type TopicRun } from './types';

import { normalizeScope, scopeForSourcedSlots } from './scope';

function approvedTopic(slot: 'A' | 'B' | 'C'): TopicRun {
  return {
    stage: 'approved',
    story: {
      headline: `Story ${slot}`,
      angle: 'a',
      rationale: 'r',
      blockSlot: slot,
      register: 'hard-news',
      sources: [],
    },
    contract: 'read',
    block: { text: 'text', version: 1 },
    blockVersions: [],
    reviewNotes: [],
  };
}

function runWith(scope: ScriptRun['scope'], topics: TopicRun[]): ScriptRun {
  return {
    ...newRun({ chatId: 'c', today: '2026-07-16', timezone: 'America/New_York' }),
    stage: 'working',
    scope,
    topics,
  };
}

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

describe('scopeForSourcedSlots', () => {
  it('keeps a full three-block rundown an episode, so assembly still applies', () => {
    expect(scopeForSourcedSlots(['A', 'B', 'C'])).toEqual({ type: 'episode' });
  });

  it('narrows to what sourced when a block fell out', () => {
    expect(scopeForSourcedSlots(['A', 'B'])).toEqual({ type: 'blocks', slots: ['A', 'B'] });
    expect(scopeForSourcedSlots(['A'])).toEqual({ type: 'single', slot: 'A' });
  });

  // The bug this exists to prevent: scope and topics are two sources of truth,
  // and a path that assigns slots itself (links, named topics) can leave a slot
  // in scope that holds no topic. Nothing downstream reconciles them.
  it('a slot in scope with no topic can never be approved — the trap it avoids', () => {
    const phantom = runWith({ type: 'episode' }, [approvedTopic('A'), approvedTopic('B')]);
    // Every block the writer HAS is approved, yet assembly is unreachable
    // forever, because slot C is in scope with no topic behind it.
    expect(allInScopeApproved(phantom)).toBe(false);

    // Reconciling scope to the slots that actually sourced makes it reachable.
    const reconciled = runWith(
      scopeForSourcedSlots(phantom.topics.map((t) => t.story.blockSlot)),
      phantom.topics,
    );
    expect(allInScopeApproved(reconciled)).toBe(true);
  });

  it('reconciles a lone link: scope must not stay an episode around one topic', () => {
    // parseScopeFromPrompt('') returns episode, but a lone pasted link slots to
    // A — leaving scope claiming A/B/C over a single-topic run.
    const lone = runWith({ type: 'episode' }, [approvedTopic('A')]);
    expect(allInScopeApproved(lone)).toBe(false);

    const reconciled = runWith(scopeForSourcedSlots(['A']), lone.topics);
    expect(reconciled.scope).toEqual({ type: 'single', slot: 'A' });
    expect(allInScopeApproved(reconciled)).toBe(true);
  });
});
