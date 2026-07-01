// Validation of extractSources() source parsing behavior with edge cases.
//
// This test validates that the two-tier parsing (strict + smart) correctly handles:
// - Standard format with all fields (title — url — date)
// - Em-dashes in titles (smart parsing detects URLs by pattern)
// - Missing optional fields (date, flags)
// - Flags with special characters
// - Complex titles with multiple em-dashes
//
// Before deploying changes to news/route.ts extractSources(), verify tests still pass.

import { describe, expect, it } from 'vitest';

import { extractSources } from '@/lib/news-script';

describe('extractSources', () => {
  it('parses standard format with all fields (strict parse)', () => {
    const input = `Some script text

---

SOURCES:

1. Reuters Report — https://reuters.com/article — May 2026`;
    const { sources } = extractSources(input);
    expect(sources[0]).toMatchObject({
      title: 'Reuters Report',
      url: 'https://reuters.com/article',
      date: 'May 2026',
    });
  });

  it('handles em-dash in title (smart parse)', () => {
    const input = `Script here

---

SOURCES:

1. Reuters — Analysis — https://reuters.com/news — May 2026`;
    const { sources } = extractSources(input);
    expect(sources[0]).toMatchObject({
      title: 'Reuters — Analysis',
      url: 'https://reuters.com/news',
      date: 'May 2026',
    });
  });

  it('handles missing date (smart parse)', () => {
    const input = `Script

---

SOURCES:

1. BBC Report — https://bbc.com/story`;
    const { sources } = extractSources(input);
    expect(sources[0]).toMatchObject({
      title: 'BBC Report',
      url: 'https://bbc.com/story',
    });
    expect(sources[0].date).toBeUndefined();
  });

  it('parses flag with em-dashes in title (smart parse)', () => {
    const input = `Script

---

SOURCES:

1. NYT — Full Story — https://nytimes.com/news — April 2026 [FLAG: paywall blocked]`;
    const { sources } = extractSources(input);
    expect(sources[0]).toMatchObject({
      title: 'NYT — Full Story',
      url: 'https://nytimes.com/news',
      date: 'April 2026',
      flags: 'paywall blocked',
    });
  });

  it('parses complex title with multiple em-dashes (smart parse)', () => {
    const input = `Script

---

SOURCES:

1. The Guardian — Breaking News — UK Politics — https://theguardian.com/uk-news — May 1 2026`;
    const { sources } = extractSources(input);
    expect(sources[0]).toMatchObject({
      title: 'The Guardian — Breaking News — UK Politics',
      url: 'https://theguardian.com/uk-news',
      date: 'May 1 2026',
    });
  });
});
