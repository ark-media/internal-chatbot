import { describe, expect, it } from 'vitest';

import {
  deriveApprovedTopics,
  extractedStoriesToDistill,
  extractedStoryToTopic,
  renumberIndicesAfterDelete,
  reorderByUrl,
  type Article,
  type ExtractedStory,
  type TopicWithSources,
} from './types';

const article = (url: string): Article => ({
  title: `title ${url}`,
  url,
  publicationDate: '2026-05-04',
  source: 'example.com',
  content: 'body',
});

const topic = (
  name: string,
  articleCount = 1,
): TopicWithSources => ({
  topic: name,
  description: `desc for ${name}`,
  articles: Array.from({ length: articleCount }, (_, i) => ({
    article: {
      title: `${name} article ${i}`,
      url: `https://example.com/${name}/${i}`,
      publicationDate: '2026-05-04',
      source: 'example.com',
      content: 'body',
    },
    relevance: 70,
    credibility: 70,
    completeness: 70,
    avgScore: 70,
  })),
});

describe('renumberIndicesAfterDelete', () => {
  it('drops the deleted index', () => {
    expect(renumberIndicesAfterDelete([0, 1, 2], 1)).toEqual([0, 1]);
  });

  it('shifts higher indices down by one', () => {
    expect(renumberIndicesAfterDelete([2, 3, 5], 2)).toEqual([2, 4]);
  });

  it('preserves indices below the deletion point', () => {
    expect(renumberIndicesAfterDelete([0, 1], 3)).toEqual([0, 1]);
  });

  it('returns an empty array when the only index is deleted', () => {
    expect(renumberIndicesAfterDelete([2], 2)).toEqual([]);
  });

  it('handles an empty input', () => {
    expect(renumberIndicesAfterDelete([], 0)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [0, 2, 4];
    const result = renumberIndicesAfterDelete(input, 2);
    expect(input).toEqual([0, 2, 4]);
    expect(result).toEqual([0, 3]);
  });
});

describe('deriveApprovedTopics', () => {
  const distill = [topic('a'), topic('b', 0), topic('c'), topic('d')];

  it('returns the topics at the given indices in order', () => {
    const result = deriveApprovedTopics(distill, [0, 2]);
    expect(result.map((t) => t.topic)).toEqual(['a', 'c']);
  });

  it('drops indices that are out of range', () => {
    const result = deriveApprovedTopics(distill, [0, 99]);
    expect(result.map((t) => t.topic)).toEqual(['a']);
  });

  it('drops topics with zero articles', () => {
    // index 1 ('b') is zero-article
    const result = deriveApprovedTopics(distill, [0, 1, 2]);
    expect(result.map((t) => t.topic)).toEqual(['a', 'c']);
  });

  it('returns an empty array when indices is undefined', () => {
    expect(deriveApprovedTopics(distill, undefined)).toEqual([]);
  });

  it('returns an empty array when indices is empty', () => {
    expect(deriveApprovedTopics(distill, [])).toEqual([]);
  });

  it('preserves index order even if not ascending', () => {
    const result = deriveApprovedTopics(distill, [3, 0, 2]);
    expect(result.map((t) => t.topic)).toEqual(['d', 'a', 'c']);
  });
});

describe('reorderByUrl', () => {
  it('reorders to match the given URL order', () => {
    const articles = [article('a'), article('b'), article('c')];
    const result = reorderByUrl(articles, ['c', 'a', 'b']);
    expect(result.map((a) => a.url)).toEqual(['c', 'a', 'b']);
  });

  it('appends items missing from the order, preserving original order', () => {
    const articles = [article('a'), article('b'), article('c')];
    const result = reorderByUrl(articles, ['c']);
    expect(result.map((a) => a.url)).toEqual(['c', 'a', 'b']);
  });

  it('ignores URLs in the order that match no item', () => {
    const articles = [article('a'), article('b')];
    const result = reorderByUrl(articles, ['b', 'ghost', 'a']);
    expect(result.map((a) => a.url)).toEqual(['b', 'a']);
  });

  it('ignores duplicate URLs in the order', () => {
    const articles = [article('a'), article('b')];
    const result = reorderByUrl(articles, ['b', 'b', 'a']);
    expect(result.map((a) => a.url)).toEqual(['b', 'a']);
  });

  it('returns an empty array when there are no items', () => {
    expect(reorderByUrl([], ['a'])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const articles = [article('a'), article('b')];
    reorderByUrl(articles, ['b', 'a']);
    expect(articles.map((a) => a.url)).toEqual(['a', 'b']);
  });
});

const story = (over: Partial<ExtractedStory> = {}): ExtractedStory => ({
  id: 's1',
  headline: 'Headline',
  lead: 'A lead',
  dryFacts: ['fact one', 'fact two'],
  relevance: 'why it matters',
  whatsNext: 'what next',
  sources: [
    {
      label: 'Reuters',
      url: 'https://www.reuters.com/a',
      facts: ['reuters fact'],
      sotClips: [{ speaker: 'TRUMP', text: 'a verbatim quote' }],
    },
  ],
  ...over,
});

describe('extractedStoryToTopic', () => {
  it('carries the source story id so the merged review screen can track it', () => {
    expect(extractedStoryToTopic(story({ id: 'abc' })).id).toBe('abc');
  });

  it('maps headline/lead/relevance/whatsNext into topic + description', () => {
    const t = extractedStoryToTopic(story());
    expect(t.topic).toBe('Headline');
    expect(t.description).toContain('Lead: A lead');
    expect(t.description).toContain('Why it matters: why it matters');
    expect(t.description).toContain("What's next: what next");
  });

  it('maps each source to a RatedArticle with summary + verbatim quotes', () => {
    const t = extractedStoryToTopic(story());
    expect(t.articles).toHaveLength(1);
    const a = t.articles[0];
    expect(a.article.url).toBe('https://www.reuters.com/a');
    expect(a.article.source).toBe('reuters.com');
    expect(a.article.content).toBe('');
    expect(a.article.isFlagged).toBe(false);
    expect(a.article.publicationDate).toBeNull();
    // SOT speaker attribution is preserved into keyQuotes (read on air).
    expect(a.keyQuotes).toEqual(['TRUMP: a verbatim quote']);
    expect(a.provenance).toBe('manual');
  });

  it('drops a blank/placeholder speaker prefix, keeping the verbatim text', () => {
    const t = extractedStoryToTopic(
      story({
        sources: [
          {
            label: 'Reuters',
            url: 'https://reuters.com/a',
            sotClips: [{ speaker: '  ', text: 'no speaker here' }],
          },
        ],
      }),
    );
    expect(t.articles[0].keyQuotes).toEqual(['no speaker here']);
  });

  it('keeps SOT quotes even when the source has no dry facts (empty summary)', () => {
    const t = extractedStoryToTopic(
      story({
        dryFacts: [],
        sources: [
          { label: 'A', url: 'https://a.com', facts: ['only fact'] },
          {
            label: 'B',
            url: 'https://b.com',
            sotClips: [{ speaker: 'AIDE', text: 'a clip with no facts' }],
          },
        ],
      }),
    );
    expect(t.articles[1].summary).toBe('');
    expect(t.articles[1].keyQuotes).toEqual(['AIDE: a clip with no facts']);
  });

  it('folds story-level dryFacts onto the first source summary', () => {
    const t = extractedStoryToTopic(story());
    expect(t.articles[0].summary).toBe('fact one fact two reuters fact');
  });

  it('only folds dryFacts onto the first source, not later ones', () => {
    const t = extractedStoryToTopic(
      story({
        sources: [
          { label: 'A', url: 'https://a.com', facts: ['af'] },
          { label: 'B', url: 'https://b.com', facts: ['bf'] },
        ],
      }),
    );
    expect(t.articles[0].summary).toBe('fact one fact two af');
    expect(t.articles[1].summary).toBe('bf');
  });

  it('synthesizes a placeholder article when the story has no sources', () => {
    const t = extractedStoryToTopic(story({ sources: [] }));
    expect(t.articles).toHaveLength(1);
    expect(t.articles[0].article.url).toBe('');
    expect(t.articles[0].summary).toBe('fact one fact two');
    expect(t.articles[0].keyQuotes).toEqual([]);
  });

  it('falls back to headline for the article title when label is empty', () => {
    const t = extractedStoryToTopic(
      story({ sources: [{ label: '', url: '' }] }),
    );
    expect(t.articles[0].article.title).toBe('Headline');
    expect(t.articles[0].article.source).toBe('editor dossier');
  });
});

describe('extractedStoriesToDistill', () => {
  const stories = [
    story({ id: 'a', headline: 'A' }),
    story({ id: 'b', headline: 'B' }),
    story({ id: 'c', headline: 'C' }),
  ];

  it('preserves input order when no order is given', () => {
    const d = extractedStoriesToDistill(stories);
    expect(d.topics.map((t) => t.topic)).toEqual(['A', 'B', 'C']);
    expect(d.rationale).toBe('Extracted from editor dossier.');
  });

  it('reorders topics to match the arc order', () => {
    const d = extractedStoriesToDistill(stories, ['c', 'a', 'b']);
    expect(d.topics.map((t) => t.topic)).toEqual(['C', 'A', 'B']);
  });

  it('appends stories missing from the order in original order', () => {
    const d = extractedStoriesToDistill(stories, ['c']);
    expect(d.topics.map((t) => t.topic)).toEqual(['C', 'A', 'B']);
  });

  it('ignores unknown ids and duplicates in the order', () => {
    const d = extractedStoriesToDistill(stories, ['b', 'ghost', 'b', 'a', 'c']);
    expect(d.topics.map((t) => t.topic)).toEqual(['B', 'A', 'C']);
  });
});
