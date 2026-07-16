import { describe, expect, it } from 'vitest';

import { blockTail } from './block-craft';
import { buildBlockPrompt, buildBlockSystemContent, buildRunStateContext, buildTopicDigest } from './prompts';
import { confirmContract, newRun, recordBlockDraft, type ScriptRun, type TopicRun } from './types';

function topic(slot: 'A' | 'B' | 'C'): TopicRun {
  return {
    stage: 'proposed',
    story: {
      headline: `Story ${slot}`,
      angle: 'the angle',
      rationale: 'the rationale',
      blockSlot: slot,
      register: 'hard-news',
      sources: [
        {
          url: 'https://example.com/x',
          title: 'Example title',
          source: 'example.com',
          publicationDate: '2026-07-14',
          credibility: 85,
          credibilityNote: 'established wire',
          summary: 'What happened, per the wire.',
          keyQuotes: ['an exact quote'],
        },
        {
          url: 'https://blog.example/y',
          title: 'Blog take',
          source: 'blog.example',
          publicationDate: null,
          credibility: 30,
          credibilityNote: 'unverified blog',
          fetchError: 'paywall',
        },
      ],
    },
    contract: null,
    block: null,
    blockVersions: [],
    reviewNotes: [],
  };
}

function baseRun(): ScriptRun {
  return {
    ...newRun({ chatId: 'c', today: '2026-07-15', timezone: 'America/New_York' }),
    stage: 'working',
    topics: [topic('A'), topic('B'), topic('C')],
  };
}

describe('buildTopicDigest', () => {
  it('carries credibility judgments, summaries, quotes, and fetch errors', () => {
    const digest = buildTopicDigest(topic('A'));
    expect(digest).toContain('# A block story: Story A');
    expect(digest).toContain('Credibility: 85/100 — established wire');
    expect(digest).toContain('Summary: What happened, per the wire.');
    expect(digest).toContain('- "an exact quote"');
    expect(digest).toContain('[fetch error: paywall]');
    expect(digest).toContain('Credibility: 30/100 — unverified blog');
  });
});

describe('buildRunStateContext', () => {
  it('lists per-topic stages and only-legal tool calls', () => {
    let run = baseRun();
    run = confirmContract(run, 0, 'read A');
    run = recordBlockDraft(run, 0, '[A BLOCK]\nHOST:\ntext');
    const cx = buildRunStateContext(run);
    expect(cx).toContain('Scope: full episode');
    expect(cx).toContain('[0] A block — "Story A" — revising');
    expect(cx).toContain('draftBlock(0)');
    expect(cx).toContain('reviseBlock(0)');
    expect(cx).toContain('approveBlock(0)');
    expect(cx).toContain('startTopic(1)');
    expect(cx).not.toContain('draftBlock(1)'); // no contract yet
    expect(cx).not.toContain('assembleEpisode'); // not all approved
  });

  it('offers assembly only when every in-scope block is approved (episode scope)', () => {
    let run = baseRun();
    for (const i of [0, 1, 2]) {
      run = confirmContract(run, i, `read ${i}`);
      run = recordBlockDraft(run, i, `[${run.topics[i].story.blockSlot} BLOCK]\ntext`);
      run = { ...run, topics: run.topics.map((t, j) => (j === i ? { ...t, stage: 'approved' as const } : t)) };
    }
    expect(buildRunStateContext(run)).toContain('assembleEpisode()');
    const single = { ...run, scope: { type: 'single', slot: 'A' } as const };
    expect(buildRunStateContext(single)).not.toContain('assembleEpisode');
  });
});

describe('buildBlockSystemContent', () => {
  const opts = {
    slot: 'C' as const,
    blockExamples: '## C BLOCKS\nexample text',
    topicDigest: 'digest text',
    today: '2026-07-15',
  };

  it('is stable across calls (one cache write per block)', () => {
    expect(buildBlockSystemContent(opts)).toBe(buildBlockSystemContent(opts));
  });

  it('scopes output to the single block and excludes the episode format', () => {
    const sys = buildBlockSystemContent(opts);
    expect(sys).toContain('You are writing ONLY the C block');
    expect(sys).toContain('== Reference Examples (C block) ==');
    expect(sys).toContain('digest text');
    expect(sys).not.toContain('SONIC ID: You are listening'); // episode Output Format excluded
    expect(sys).toContain('no outlet allowlist');
  });

  it('keeps the contract OUT of the cached system (it lives in the user prompt)', () => {
    const sys = buildBlockSystemContent(opts);
    expect(sys).not.toContain('substance contract (the writer');
    const prompt = buildBlockPrompt({ slot: 'C', contract: 'THE CONTRACT TEXT' });
    expect(prompt).toContain('THE CONTRACT TEXT');
    expect(prompt).toContain('Begin your response with "[C BLOCK]"');
  });
});

describe('buildBlockPrompt', () => {
  it('revision prompts carry the prior draft and instruction', () => {
    const p = buildBlockPrompt({
      slot: 'B',
      contract: 'contract',
      previousDraft: 'OLD DRAFT',
      instruction: 'shorter sentences',
    });
    expect(p).toContain('OLD DRAFT');
    expect(p).toContain('shorter sentences');
    expect(p).toContain('revise this; do not start from scratch');
  });

  it('includes the preceding block tail when supplied', () => {
    const p = buildBlockPrompt({ slot: 'B', contract: 'c', previousBlockTail: 'END OF A.' });
    expect(p).toContain('END OF A.');
    expect(p).toContain('transition awareness');
  });
});

describe('blockTail', () => {
  it('returns the end of the block body, excluding the SOURCES section', () => {
    const text = `[A BLOCK]\nHOST:\nfirst line\nlast line of the block\n\n---\n\nSOURCES:\n\n1. entry`;
    const tail = blockTail(text);
    expect(tail).toContain('last line of the block');
    expect(tail).not.toContain('SOURCES');
  });

  it('cuts long blocks at a line boundary', () => {
    const long = `[A BLOCK]\nHOST:\n${'x'.repeat(500)}\nfinal line`;
    const tail = blockTail(long, 100);
    expect(tail.length).toBeLessThanOrEqual(100);
    expect(tail).toContain('final line');
  });
});
