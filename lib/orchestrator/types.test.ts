import { describe, expect, it } from 'vitest';

import {
  deriveApprovedTopics,
  renumberIndicesAfterDelete,
  reorderArticlesByUrl,
  type Article,
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

describe('reorderArticlesByUrl', () => {
  it('reorders to match the given URL order', () => {
    const articles = [article('a'), article('b'), article('c')];
    const result = reorderArticlesByUrl(articles, ['c', 'a', 'b']);
    expect(result.map((a) => a.url)).toEqual(['c', 'a', 'b']);
  });

  it('appends articles missing from the order, preserving original order', () => {
    const articles = [article('a'), article('b'), article('c')];
    const result = reorderArticlesByUrl(articles, ['c']);
    expect(result.map((a) => a.url)).toEqual(['c', 'a', 'b']);
  });

  it('ignores URLs in the order that match no article', () => {
    const articles = [article('a'), article('b')];
    const result = reorderArticlesByUrl(articles, ['b', 'ghost', 'a']);
    expect(result.map((a) => a.url)).toEqual(['b', 'a']);
  });

  it('ignores duplicate URLs in the order', () => {
    const articles = [article('a'), article('b')];
    const result = reorderArticlesByUrl(articles, ['b', 'b', 'a']);
    expect(result.map((a) => a.url)).toEqual(['b', 'a']);
  });

  it('returns an empty array when there are no articles', () => {
    expect(reorderArticlesByUrl([], ['a'])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const articles = [article('a'), article('b')];
    reorderArticlesByUrl(articles, ['b', 'a']);
    expect(articles.map((a) => a.url)).toEqual(['a', 'b']);
  });
});
