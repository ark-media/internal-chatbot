import { describe, expect, it } from 'vitest';

import { buildOutputInstruction, buildSourceBlock } from './script-craft';
import type { TopicWithSources } from './types';

const rated = (over: Partial<TopicWithSources['articles'][number]> = {}) => ({
  article: {
    title: 'A title',
    url: 'https://example.com/a',
    publicationDate: null,
    source: 'example.com',
    content: '',
    isFlagged: false,
  },
  relevance: 75,
  credibility: 75,
  completeness: 75,
  avgScore: 75,
  provenance: 'manual' as const,
  ...over,
});

const topicWith = (article: TopicWithSources['articles'][number]): TopicWithSources => ({
  topic: 'Topic',
  description: 'desc',
  articles: [article],
});

describe('buildSourceBlock', () => {
  it('renders verbatim quotes even when the summary is empty', () => {
    // Regression: a doc source whose facts live at story level has an empty
    // summary but real SOT quotes. Those quotes must still reach the writer
    // instead of an empty `Excerpt:` block.
    const block = buildSourceBlock(
      [topicWith(rated({ summary: '', keyQuotes: ['AIDE: a clip with no facts'] }))],
      [],
    );
    expect(block).toContain('Quotes (verbatim):');
    expect(block).toContain('- "AIDE: a clip with no facts"');
    expect(block).not.toContain('Excerpt:');
  });

  it('renders summary and quotes together when both are present', () => {
    const block = buildSourceBlock(
      [topicWith(rated({ summary: 'the facts', keyQuotes: ['a quote'] }))],
      [],
    );
    expect(block).toContain('Summary: the facts');
    expect(block).toContain('- "a quote"');
  });

  it('folds the document flow block + transition into the writer view', () => {
    const block = buildSourceBlock(
      [
        {
          ...topicWith(rated({ summary: 'the facts' })),
          block: 'B',
          transition: 'and that brings us to the next story',
        },
      ],
      [],
    );
    expect(block).toContain('Block: B');
    expect(block).toContain('Transition into next: "and that brings us to the next story"');
  });

  it('omits block + transition for discover-flow topics that have neither', () => {
    const block = buildSourceBlock([topicWith(rated({ summary: 'the facts' }))], []);
    expect(block).not.toContain('Block:');
    expect(block).not.toContain('Transition into next:');
  });

  it('falls back to a content excerpt when there is neither summary nor quotes', () => {
    const block = buildSourceBlock(
      [
        topicWith(
          rated({
            article: {
              title: 'A title',
              url: 'https://example.com/a',
              publicationDate: null,
              source: 'example.com',
              content: 'raw body text',
              isFlagged: false,
            },
            summary: '',
            keyQuotes: [],
          }),
        ),
      ],
      [],
    );
    expect(block).toContain('Excerpt:');
    expect(block).toContain('raw body text');
  });
});

describe('buildOutputInstruction', () => {
  // The single-C-block regression: a scope-limited draft was handed the
  // full-episode instruction, so the correction pass was told to open with a
  // SONIC ID and invent A and B blocks it had no sources for.
  it('asks for a full episode on an initial craft', () => {
    expect(buildOutputInstruction()).toContain('SONIC ID:');
    expect(buildOutputInstruction()).toContain('1000–1200 words');
  });

  it('holds a single-block draft to its own scope', () => {
    const draft = '[C BLOCK]\n\nBoy George released a song.\n\n---\n\nSOURCES:\n\n1. NME';
    const instruction = buildOutputInstruction(draft);

    expect(instruction).toContain('[C BLOCK]');
    expect(instruction).toContain('no SONIC ID');
    expect(instruction).not.toContain('1000–1200 words');
    expect(instruction).not.toContain('[A BLOCK]');
  });

  it('lists every block of a multi-block draft', () => {
    const instruction = buildOutputInstruction('[A BLOCK]\n\nOne.\n\n[B BLOCK]\n\nTwo.');

    expect(instruction).toContain('[A BLOCK], [B BLOCK]');
    expect(instruction).toContain('Begin your response with "[A BLOCK]"');
  });

  it('treats a draft with a SONIC ID as a full episode', () => {
    const draft = 'SONIC ID: intro\n\n[A BLOCK]\n\nOne.';
    expect(buildOutputInstruction(draft)).toBe(buildOutputInstruction());
  });

  it('falls back to the full episode when the draft has no blocks', () => {
    expect(buildOutputInstruction('just some prose')).toBe(buildOutputInstruction());
  });

  // The substance-stripping failure: each correction pass satisfied the
  // reviewer by deleting the fact it could not verify.
  it('forbids dropping sourced detail to satisfy a correction', () => {
    const instruction = buildOutputInstruction('[C BLOCK]\n\nBody.');
    expect(instruction).toContain('dropping a sourced detail');
  });
});
