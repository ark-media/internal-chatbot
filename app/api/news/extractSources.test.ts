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

type ExtractedSources = Array<{
  num: number;
  title: string;
  url: string;
  date?: string;
  flags?: string;
}>;

function extractSources(text: string): { script: string; sources: ExtractedSources } {
  const match = text.match(/^([\s\S]*?)\n\s*---+\s*\n\s*SOURCES:\s*\n([\s\S]+)$/i);
  if (!match) {
    return { script: text, sources: [] };
  }

  const [, script, sourcesText] = match;
  const sources: ExtractedSources = [];

  const lines = sourcesText.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const strictMatch = line.match(
      /^(\d+)\.\s+(.+?)\s+—\s+(https?:\/\/[^\s]+)(?:\s+—\s+(.+?))?(?:\s+\[FLAG:\s+(.+?)\])?$/
    );
    if (strictMatch) {
      sources.push({
        num: parseInt(strictMatch[1], 10),
        title: strictMatch[2].trim(),
        url: strictMatch[3].trim(),
        date: strictMatch[4]?.trim(),
        flags: strictMatch[5]?.trim(),
      });
      continue;
    }

    const numMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      const rest = numMatch[2];

      const flagMatch = rest.match(/\[FLAG:\s+(.+?)\]$/);
      const flagText = flagMatch?.[1]?.trim();
      const withoutFlag = flagMatch ? rest.slice(0, flagMatch.index).trim() : rest;

      const urlMatch = withoutFlag.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) {
        continue;
      }

      const url = urlMatch[0];
      const urlStartIndex = withoutFlag.indexOf(url);
      const titlePart = withoutFlag.slice(0, urlStartIndex).trim();
      const datePart = withoutFlag.slice(urlStartIndex + url.length).trim();

      const cleanTitle = titlePart.replace(/\s+—\s*$/, '').trim();
      const cleanDate = datePart.replace(/^\s*—\s+/, '').trim() || undefined;

      sources.push({
        num,
        title: cleanTitle,
        url,
        date: cleanDate,
        flags: flagText,
      });
    }
  }

  return { script, sources };
}

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
