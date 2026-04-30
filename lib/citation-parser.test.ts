import { describe, it, expect } from 'vitest';
import { parseCitations } from './citation-parser';

describe('parseCitations', () => {
  // ── plain brackets (existing format) ──────────────────────────────────────

  it('parses [id:N] into a single cite token', () => {
    const tokens = parseCitations('Hello [id:42] world');
    expect(tokens).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'cite', kind: 'id', id: 42, quote: undefined },
      { type: 'text', text: ' world' },
    ]);
  });

  it('parses [turn:N] into a single cite token', () => {
    const tokens = parseCitations('[turn:7]');
    expect(tokens).toEqual([{ type: 'cite', kind: 'turn', id: 7, quote: undefined }]);
  });

  it('parses comma-separated ids into multiple cite tokens', () => {
    const tokens = parseCitations('[id:1,2,3]');
    expect(tokens).toEqual([
      { type: 'cite', kind: 'id', id: 1, quote: undefined },
      { type: 'cite', kind: 'id', id: 2, quote: undefined },
      { type: 'cite', kind: 'id', id: 3, quote: undefined },
    ]);
  });

  it('parses mixed-kind bracket', () => {
    const tokens = parseCitations('[turn:8368, id:2985]');
    expect(tokens).toEqual([
      { type: 'cite', kind: 'turn', id: 8368, quote: undefined },
      { type: 'cite', kind: 'id', id: 2985, quote: undefined },
    ]);
  });

  it('emits leading and trailing text tokens', () => {
    const tokens = parseCitations('Before [id:1] after');
    expect(tokens[0]).toEqual({ type: 'text', text: 'Before ' });
    expect(tokens[2]).toEqual({ type: 'text', text: ' after' });
  });

  it('handles text with no citations', () => {
    const tokens = parseCitations('No citations here.');
    expect(tokens).toEqual([{ type: 'text', text: 'No citations here.' }]);
  });

  // ── new quote form ─────────────────────────────────────────────────────────

  it('attaches quote to single-id citation', () => {
    const tokens = parseCitations('[id:42 "Israel constantly attacking targets"]');
    expect(tokens).toEqual([
      {
        type: 'cite',
        kind: 'id',
        id: 42,
        quote: 'Israel constantly attacking targets',
      },
    ]);
  });

  it('attaches quote to single turn citation', () => {
    const tokens = parseCitations('[turn:99 "rising power and all the rest"]');
    expect(tokens).toEqual([
      {
        type: 'cite',
        kind: 'turn',
        id: 99,
        quote: 'rising power and all the rest',
      },
    ]);
  });

  it('suppresses quote on multi-id citation', () => {
    const tokens = parseCitations('[id:1,2 "some quote"]');
    expect(tokens).toEqual([
      { type: 'cite', kind: 'id', id: 1, quote: undefined },
      { type: 'cite', kind: 'id', id: 2, quote: undefined },
    ]);
  });

  it('suppresses quote on mixed-kind citation', () => {
    const tokens = parseCitations('[id:1, turn:2 "some quote"]');
    for (const t of tokens) {
      if (t.type === 'cite') expect(t.quote).toBeUndefined();
    }
  });

  it('preserves surrounding text with quoted citation', () => {
    const tokens = parseCitations(
      'He noted [id:5 "Houthis rising power"] in his analysis.',
    );
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toEqual({ type: 'text', text: 'He noted ' });
    expect(tokens[1]).toEqual({
      type: 'cite',
      kind: 'id',
      id: 5,
      quote: 'Houthis rising power',
    });
    expect(tokens[2]).toEqual({ type: 'text', text: ' in his analysis.' });
  });

  it('handles multiple citations in one string', () => {
    const tokens = parseCitations('[id:1 "first quote"] and [id:2]');
    const cites = tokens.filter((t) => t.type === 'cite');
    expect(cites).toHaveLength(2);
    expect(cites[0]).toMatchObject({ id: 1, quote: 'first quote' });
    expect(cites[1]).toMatchObject({ id: 2, quote: undefined });
  });
});
