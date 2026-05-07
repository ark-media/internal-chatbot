import { describe, expect, it } from 'vitest';

import { extractUrls } from './prep-extract';

describe('extractUrls', () => {
  it('captures bare URLs', () => {
    expect(extractUrls('see https://example.com for context')).toEqual([
      'https://example.com',
    ]);
  });

  it('strips trailing punctuation that is clearly not part of the URL', () => {
    expect(
      extractUrls('look at https://example.com/path), and https://b.com.'),
    ).toEqual(['https://example.com/path', 'https://b.com']);
  });

  it('preserves trailing slash and query string', () => {
    expect(
      extractUrls('https://example.com/path/ and https://example.com/?q=1'),
    ).toEqual(['https://example.com/path/', 'https://example.com/?q=1']);
  });

  it('dedupes repeated URLs', () => {
    expect(
      extractUrls('https://a.com and https://a.com again'),
    ).toEqual(['https://a.com']);
  });

  it('caps the result at MAX_URLS so a flood of links cannot blow the budget', () => {
    const text = Array.from({ length: 12 }, (_, i) => `https://x${i}.com`).join(
      ' ',
    );
    const result = extractUrls(text);
    expect(result.length).toBe(5);
    expect(result[0]).toBe('https://x0.com');
    expect(result[4]).toBe('https://x4.com');
  });
});
