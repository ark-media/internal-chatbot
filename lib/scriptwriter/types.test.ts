import { describe, expect, it } from 'vitest';

import {
  allInScopeApproved,
  approveTopicBlock,
  canDraft,
  confirmContract,
  newRun,
  recordBlockDraft,
  recordBlockRevision,
  recordEpisode,
  reviseEpisode,
  scopeWantsAssembly,
  slotsInScope,
  startTopic,
  storyCountForScope,
  topicForSlot,
  undoEpisode,
  type ScriptRun,
  type StoryProposal,
  type TopicRun,
} from './types';

function story(slot: 'A' | 'B' | 'C', headline = `story ${slot}`): StoryProposal {
  return {
    headline,
    angle: 'angle',
    rationale: 'rationale',
    blockSlot: slot,
    register: slot === 'C' ? 'human-interest' : 'hard-news',
    sources: [
      {
        url: `https://example.com/${slot}`,
        title: 't',
        source: 'example.com',
        publicationDate: '2026-07-14',
        credibility: 80,
        credibilityNote: 'wire',
      },
    ],
  };
}

function topic(slot: 'A' | 'B' | 'C'): TopicRun {
  return { stage: 'proposed', story: story(slot), contract: null, block: null, blockVersions: [], reviewNotes: [] };
}

function runWithTopics(): ScriptRun {
  return {
    ...newRun({ chatId: 'c1', today: '2026-07-15', timezone: 'America/New_York' }),
    stage: 'working',
    topics: [topic('A'), topic('B'), topic('C')],
  };
}

describe('scope helpers', () => {
  it('maps scope to slots in on-air order', () => {
    expect(slotsInScope({ type: 'episode' })).toEqual(['A', 'B', 'C']);
    expect(slotsInScope({ type: 'blocks', slots: ['C', 'A'] })).toEqual(['A', 'C']);
    expect(slotsInScope({ type: 'single', slot: 'B' })).toEqual(['B']);
  });

  it('story count and assembly follow the scope', () => {
    expect(storyCountForScope({ type: 'single', slot: 'C' })).toBe(1);
    expect(scopeWantsAssembly({ type: 'episode' })).toBe(true);
    expect(scopeWantsAssembly({ type: 'single', slot: 'A' })).toBe(false);
    expect(scopeWantsAssembly({ type: 'blocks', slots: ['A', 'B'] })).toBe(false);
  });
});

describe('topic lifecycle (out-of-order capable)', () => {
  it('runs the full gate → draft → revise → approve path', () => {
    let run = runWithTopics();
    // Work C first — order is the writer's choice.
    const c = topicForSlot(run, 'C');
    run = startTopic(run, c);
    expect(run.topics[c].stage).toBe('understanding');
    expect(canDraft(run.topics[c])).toBe(false);

    run = confirmContract(run, c, 'six-dimension read for C');
    expect(run.topics[c].stage).toBe('confirmed');
    expect(canDraft(run.topics[c])).toBe(true);

    run = recordBlockDraft(run, c, '[C BLOCK]\nHOST:\ndraft v1');
    expect(run.topics[c].block).toEqual({ text: '[C BLOCK]\nHOST:\ndraft v1', version: 1 });
    expect(run.topics[c].stage).toBe('revising');

    run = recordBlockRevision(run, c, '[C BLOCK]\nHOST:\ndraft v2', 'warmer close');
    expect(run.topics[c].block?.version).toBe(2);
    expect(run.topics[c].blockVersions).toEqual([
      { text: '[C BLOCK]\nHOST:\ndraft v1', version: 1, instruction: 'warmer close' },
    ]);
    expect(run.revisionCount).toBe(1);

    run = approveTopicBlock(run, c);
    expect(run.topics[c].stage).toBe('approved');
    // A and B untouched.
    expect(run.topics[topicForSlot(run, 'A')].stage).toBe('proposed');
  });

  it('draft requires a confirmed contract', () => {
    const run = runWithTopics();
    expect(() => recordBlockDraft(run, 0, 'text')).toThrow(/no confirmed contract/);
  });

  it('refuses to re-draft an approved topic (must revise explicitly)', () => {
    let run = runWithTopics();
    run = confirmContract(run, 0, 'read');
    run = recordBlockDraft(run, 0, 'draft 1');
    run = approveTopicBlock(run, 0);
    expect(() => recordBlockDraft(run, 0, 'sneaky redraft')).toThrow(/approved/);
  });

  it('re-drafting after amendment keeps prior versions', () => {
    let run = runWithTopics();
    run = confirmContract(run, 0, 'read v1');
    run = recordBlockDraft(run, 0, 'draft 1');
    run = confirmContract(run, 0, 'read v2 (amended)'); // amend keeps stage
    expect(run.topics[0].stage).toBe('revising');
    run = recordBlockDraft(run, 0, 'draft 2');
    expect(run.topics[0].block?.version).toBe(2);
    expect(run.topics[0].blockVersions).toHaveLength(1);
  });

  it('allInScopeApproved respects scope subsets', () => {
    let run = runWithTopics();
    run = { ...run, scope: { type: 'single', slot: 'B' } };
    const b = topicForSlot(run, 'B');
    run = confirmContract(run, b, 'read');
    run = recordBlockDraft(run, b, 'text');
    expect(allInScopeApproved(run)).toBe(false);
    run = approveTopicBlock(run, b);
    expect(allInScopeApproved(run)).toBe(true); // A and C don't matter for this scope
  });
});

describe('episode versioning', () => {
  it('revise pushes onto the undo stack; undo pops', () => {
    let run = runWithTopics();
    run = recordEpisode(run, 'episode v1');
    expect(run.stage).toBe('complete');
    run = reviseEpisode(run, 'episode v2', 'tighten the intro');
    expect(run.episode?.fullText).toBe('episode v2');
    expect(run.episodeVersions).toEqual([{ fullText: 'episode v1', instruction: 'tighten the intro' }]);
    run = undoEpisode(run);
    expect(run.episode?.fullText).toBe('episode v1');
    expect(run.episodeVersions).toHaveLength(0);
    expect(() => undoEpisode(run)).toThrow(/no prior/);
  });
});
