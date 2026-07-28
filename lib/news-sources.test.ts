import { describe, expect, it } from 'vitest';

import { isApprovedSource, isHardPaywallSource } from './news-sources';

// The URL is the case name — it describes itself, and it is what you want to
// see in a failure message.
describe('isApprovedSource', () => {
  it.each([
    // Approved outlets, root domain and subdomain (suffix match).
    ['https://www.reuters.com/world/article-123', true],
    ['https://www.haaretz.com/middle-east-news/2026-05-04/something', true],
    ['https://www.bbc.com/news/world-middle-east-12345', true],
    ['https://www.bbc.co.uk/news/world-12345', true],
    ['https://www.theguardian.com/world/2026/may/04/israel', true],
    ['https://www.washingtonpost.com/world/2026/05/04/israel', true],
    ['https://www.ft.com/content/abc-123', true],
    ['https://www.cnn.com/2026/05/04/middleeast/israel', false],

    // X/Twitter: only a /status/ post from a listed handle counts.
    ['https://x.com/AmitSegal/status/1234567890', true],
    ['https://twitter.com/AmitSegal/status/1234567890', true],
    ['https://x.com/amitsegal/status/1234567890', true],
    ['https://x.com/AmitSegal', false],
    // x.com/i/... and /intent/... are routes, not handles.
    ['https://x.com/i/status/1234567890', false],
    ['https://x.com/intent/post?text=hi', false],
    ['https://x.com/elonmusk/status/1234567890', false],

    // Malformed input must not throw.
    ['not a url', false],
    ['', false],
  ])('%s -> %s', (url, expected) => {
    expect(isApprovedSource(url)).toBe(expected);
  });
});

describe('isHardPaywallSource', () => {
  it.each([
    ['https://www.wsj.com/world/x', true],
    ['https://www.nytimes.com/2026/05/04/x', true],
    ['https://www.washingtonpost.com/world/x', true],
    ['https://www.ft.com/content/x', true],
    ['https://www.reuters.com/world/x', false],
    ['https://www.bbc.com/news/x', false],
    ['https://www.timesofisrael.com/x', false],
  ])('%s -> %s', (url, expected) => {
    expect(isHardPaywallSource(url)).toBe(expected);
  });
});
