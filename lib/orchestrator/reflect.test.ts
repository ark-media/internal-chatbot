import { describe, expect, it } from 'vitest';

import { truncateAtParagraph } from './reflect';

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
