import { describe, expect, it } from 'vitest';

import { buildReviewerSystemContent, truncateAtParagraph } from './reflect';

describe('truncateAtParagraph', () => {
  it('returns the input unchanged when shorter than the limit', () => {
    expect(truncateAtParagraph('short text', 100)).toBe('short text');
  });

  it('truncates at a paragraph boundary near the limit', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50);
    const result = truncateAtParagraph(text, 110);
    // Should cut at the second \n\n (index 102), leaving the first two paragraphs.
    expect(result).toBe('a'.repeat(50) + '\n\n' + 'b'.repeat(50));
  });

  it('falls back to a line boundary when no paragraph boundary is near enough', () => {
    const text = 'a'.repeat(80) + '\n' + 'b'.repeat(40);
    const result = truncateAtParagraph(text, 100);
    // No \n\n at all; nearest \n is at 80, which is > 0.6 * 100 = 60.
    expect(result).toBe('a'.repeat(80));
  });

  it('hard-cuts when no boundary is near enough', () => {
    const text = 'a'.repeat(200);
    const result = truncateAtParagraph(text, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toBe('a'.repeat(100));
  });

  it('never returns a string longer than the limit', () => {
    // Pathological case: limit just under the first paragraph boundary.
    const text = 'a'.repeat(200) + '\n\n' + 'b'.repeat(200);
    const result = truncateAtParagraph(text, 150);
    expect(result.length).toBeLessThanOrEqual(150);
  });
});

describe('buildReviewerSystemContent', () => {
  // Cache hit-rate on Opus calls depends on byte-stable output across
  // reflect iterations — these tests guard the determinism contract.
  const exampleScripts = 'EXAMPLE A\n\nEXAMPLE B';

  it('produces byte-identical output for identical inputs', async () => {
    const a = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: 'short sentences; active voice',
    });
    const b = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: 'short sentences; active voice',
    });
    expect(a).toBe(b);
  });

  it('omits the style block when styleProfile is empty, whitespace, or undefined', async () => {
    const undef = await buildReviewerSystemContent({ exampleScripts });
    const empty = await buildReviewerSystemContent({ exampleScripts, styleProfile: '' });
    const whitespace = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: '   \n  ',
    });
    expect(undef).not.toContain('WRITER STYLE PREFERENCES');
    expect(empty).not.toContain('WRITER STYLE PREFERENCES');
    expect(whitespace).not.toContain('WRITER STYLE PREFERENCES');
    expect(undef).toBe(empty);
    expect(undef).toBe(whitespace);
  });

  it('includes the style block when styleProfile has content', async () => {
    const result = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: 'short sentences',
    });
    expect(result).toContain('WRITER STYLE PREFERENCES');
    expect(result).toContain('short sentences');
  });
});
