import { describe, expect, it } from 'vitest';

import { takeCompleteLines } from './ndjson';

describe('takeCompleteLines', () => {
  it('returns complete lines and carries the trailing partial forward', () => {
    const { lines, rest } = takeCompleteLines('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it('treats a buffer with no newline as all-partial', () => {
    const { lines, rest } = takeCompleteLines('{"a":1}');
    expect(lines).toEqual([]);
    expect(rest).toBe('{"a":1}');
  });

  it('emits a line only once its terminating newline arrives', () => {
    // Simulate two chunks of one logical line split mid-token.
    let buf = '{"hea';
    let out = takeCompleteLines(buf);
    expect(out.lines).toEqual([]);
    buf = out.rest + 'dline":"x"}\n';
    out = takeCompleteLines(buf);
    expect(out.lines).toEqual(['{"headline":"x"}']);
    expect(out.rest).toBe('');
  });

  it('drops blank lines', () => {
    const { lines, rest } = takeCompleteLines('{"a":1}\n\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('');
  });

  it('handles a clean buffer ending in a newline (no partial)', () => {
    const { lines, rest } = takeCompleteLines('{"done":true}\n');
    expect(lines).toEqual(['{"done":true}']);
    expect(rest).toBe('');
  });
});
