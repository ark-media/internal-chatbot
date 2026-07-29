import { describe, expect, it } from 'vitest';

import {
  ARTICLE_TEXT_CAP,
  isLiveBlogUrl,
  liveBlogAnchorId,
  stripLinkTargets,
  trimArticleText,
} from './article-trim';

describe('stripLinkTargets', () => {
  it('keeps link labels, drops targets, images, and bare URLs', () => {
    const input = [
      'Officials [confirmed the strike](https://example.com/a?utm=x) on Monday.',
      '![Image 2: user](https://cdn.example.com/user.png)',
      'Share: https://twitter.com/intent/tweet?text=UN+chief&url=https%3A%2F%2Fexample.com',
      'Plain prose survives.',
    ].join('\n');
    const out = stripLinkTargets(input);
    expect(out).toContain('Officials confirmed the strike on Monday.');
    expect(out).toContain('Plain prose survives.');
    expect(out).not.toContain('http');
    expect(out).not.toContain('Image 2');
  });

  it('removes bullet lines emptied by link removal and collapses blank runs', () => {
    const input = '*   [Facebook](https://fb.com/share)\n*   [X](https://x.com/share)\n\n\n\nEntry text.';
    const out = stripLinkTargets(input);
    expect(out).not.toMatch(/^\s*\*\s*$/m);
    expect(out).not.toContain('\n\n\n');
    expect(out).toContain('Entry text.');
  });
});

describe('liveBlogAnchorId', () => {
  it('reads the Haaretz liveBlogItemId query param', () => {
    expect(
      liveBlogAnchorId(
        'https://www.haaretz.com/2026-07-23/ty-article-live/x?liveBlogItemId=1577291325#1577291325',
      ),
    ).toBe('1577291325');
  });

  it('reads a purely numeric fragment', () => {
    expect(liveBlogAnchorId('https://example.com/live#298152038')).toBe('298152038');
  });

  it('ignores slug fragments and anchorless URLs', () => {
    expect(liveBlogAnchorId('https://example.com/story#main-content')).toBeNull();
    expect(liveBlogAnchorId('https://example.com/story')).toBeNull();
  });
});

describe('isLiveBlogUrl', () => {
  it('recognizes the formats writers actually paste', () => {
    expect(isLiveBlogUrl('https://www.timesofisrael.com/liveblog-july-22-2026/')).toBe(true);
    expect(isLiveBlogUrl('https://www.timesofisrael.com/liveblog_entry/some-slug/')).toBe(true);
    expect(isLiveBlogUrl('https://www.haaretz.com/2026-07-23/ty-article-live/slug')).toBe(true);
    expect(isLiveBlogUrl('https://www.bbc.com/news/live/cewr512jv8dt')).toBe(true);
    expect(isLiveBlogUrl('https://www.reuters.com/world/middle-east/some-story/')).toBe(false);
  });
});

// Synthetic liveblog raw text: `entries` blocks of prose, each followed by the
// share-link boilerplate real extractions carry, with the anchor id embedded
// in a permalink URL (never in visible prose) — matching what production
// cached pages look like.
function syntheticLiveblog(entries: number, anchorId?: string, anchorAt?: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < entries; i++) {
    const id = i === anchorAt ? anchorId : `90000${i}`;
    blocks.push(
      `Entry ${i}: reporting text for entry number ${i}. `.repeat(20) +
        `\n*   [Facebook](https://facebook.com/share?u=https%3A%2F%2Fexample.com%2Fliveblog_entry%2Fe${i})` +
        `\n*   [X](https://twitter.com/intent/tweet?url=https%3A%2F%2Fexample.com%2Flive%3FliveBlogItemId%3D${id})`,
    );
  }
  return blocks.join('\n\n');
}

describe('trimArticleText', () => {
  it('returns short articles unchanged apart from link stripping', () => {
    const out = trimArticleText('https://example.com/story', 'Short [a](https://x.com) piece.');
    expect(out).toEqual({
      text: 'Short a piece.',
      truncated: false,
      totalChars: 'Short a piece.'.length,
    });
  });

  it('caps long pages, keeps the head, and explains itself for liveblogs', () => {
    const raw = syntheticLiveblog(200);
    const out = trimArticleText('https://www.timesofisrael.com/liveblog-may-5-2026/', raw);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(ARTICLE_TEXT_CAP + 200);
    // Head-first: the newest entries (top of page) survive.
    expect(out.text).toContain('Entry 0:');
    expect(out.trimNote).toContain('newest first');
    expect(out.totalChars).toBeGreaterThan(ARTICLE_TEXT_CAP);
  });

  it('appends the anchored entry when the cap would have cut it', () => {
    const raw = syntheticLiveblog(200, '1577291325', 150);
    const out = trimArticleText(
      'https://example.com/2026-07-23/ty-article-live/x?liveBlogItemId=1577291325',
      raw,
    );
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("referenced by the link's anchor");
    expect(out.text).toContain('Entry 150:');
    expect(out.trimNote).toContain('1577291325');
    expect(out.text.length).toBeLessThanOrEqual(ARTICLE_TEXT_CAP + 200);
  });

  it('does not duplicate an anchored entry that already sits in the head', () => {
    const raw = syntheticLiveblog(200, '1577291325', 1);
    const out = trimArticleText(
      'https://example.com/2026-07-23/ty-article-live/x?liveBlogItemId=1577291325',
      raw,
    );
    expect(out.truncated).toBe(true);
    expect(out.text).not.toContain("referenced by the link's anchor");
  });

  it('notes an anchor id that is missing from the extracted text', () => {
    const raw = syntheticLiveblog(200);
    const out = trimArticleText(
      'https://example.com/2026-07-23/ty-article-live/x?liveBlogItemId=1577291325',
      raw,
    );
    expect(out.truncated).toBe(true);
    expect(out.trimNote).toContain('not found');
  });
});
