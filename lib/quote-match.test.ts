import { describe, it, expect } from 'vitest';
import { findQuoteSpans } from './quote-match';

describe('findQuoteSpans', () => {
  it('locates an exact substring', () => {
    const text = 'Israel constantly attacking targets across the Middle East.';
    const spans = findQuoteSpans(text, 'attacking targets across the Middle East');
    expect(spans).toEqual([[18, 58]]);
    expect(text.slice(18, 58)).toBe('attacking targets across the Middle East');
  });

  it('tolerates collapsed whitespace differences', () => {
    const text = 'Israel\nconstantly  attacking\ttargets across the Middle East.';
    const spans = findQuoteSpans(text, 'Israel constantly attacking targets');
    expect(spans).not.toBeNull();
    const [start, end] = spans![0];
    expect(text.slice(start, end)).toBe('Israel\nconstantly  attacking\ttargets');
  });

  it('tolerates straight vs curly quotes', () => {
    const text = "the Houthis’ rising power and all the rest";
    const spans = findQuoteSpans(text, "the Houthis' rising power");
    expect(spans).not.toBeNull();
    const [start, end] = spans![0];
    expect(text.slice(start, end)).toBe("the Houthis’ rising power");
  });

  it('handles ellipsis-separated segments in order', () => {
    const text = 'Israel constantly attacking targets across the Middle East, and also the Houthis rising power and all the rest, that is worrying to them.';
    const spans = findQuoteSpans(
      text,
      'Israel constantly attacking targets ... that is worrying to them',
    );
    expect(spans).toHaveLength(2);
    expect(text.slice(spans![0][0], spans![0][1])).toBe(
      'Israel constantly attacking targets',
    );
    expect(text.slice(spans![1][0], spans![1][1])).toBe('that is worrying to them');
  });

  it('handles unicode ellipsis (…)', () => {
    const text = 'one two three four five six';
    const spans = findQuoteSpans(text, 'one two … five six');
    expect(spans).toHaveLength(2);
    expect(text.slice(spans![0][0], spans![0][1])).toBe('one two');
    expect(text.slice(spans![1][0], spans![1][1])).toBe('five six');
  });

  it('returns null when the quote is not present', () => {
    expect(findQuoteSpans('hello world', 'goodbye world')).toBeNull();
  });

  it('returns null when a later segment is missing', () => {
    expect(findQuoteSpans('one two three', 'one ... five')).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(findQuoteSpans('', 'anything')).toBeNull();
    expect(findQuoteSpans('something', '')).toBeNull();
    expect(findQuoteSpans('something', '   ')).toBeNull();
  });

  it('does not match a later segment before an earlier one', () => {
    // "five" appears once and comes before "one" in this contrived text.
    // The ordered cursor must reject matching "one ... five".
    const text = 'five and then one';
    expect(findQuoteSpans(text, 'one ... five')).toBeNull();
  });

  it('escapes regex metacharacters in the quote', () => {
    const text = 'price was $30 (give or take).';
    const spans = findQuoteSpans(text, '$30 (give or take)');
    expect(spans).not.toBeNull();
    const [start, end] = spans![0];
    expect(text.slice(start, end)).toBe('$30 (give or take)');
  });
});
