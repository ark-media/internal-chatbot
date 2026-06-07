import { describe, expect, it } from 'vitest';

import { buildSourceBlock } from './script-craft';
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
