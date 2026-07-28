import { describe, it, expect } from 'vitest';
import { parseCitations } from './citation-parser';

// Shorthands so the expectation tables below stay readable at a glance.
const text = (t: string) => ({ type: 'text', text: t });
const cite = (kind: 'id' | 'turn', id: number, quote?: string) => ({
  type: 'cite',
  kind,
  id,
  quote,
});

describe('parseCitations', () => {
  it.each([
    ['[id:N] becomes one cite token', 'Hello [id:42] world', [
      text('Hello '),
      cite('id', 42),
      text(' world'),
    ]],
    ['[turn:N] becomes one cite token', '[turn:7]', [cite('turn', 7)]],
    ['comma-separated ids fan out', '[id:1,2,3]', [
      cite('id', 1),
      cite('id', 2),
      cite('id', 3),
    ]],
    ['a bracket may mix kinds', '[turn:8368, id:2985]', [
      cite('turn', 8368),
      cite('id', 2985),
    ]],
    ['leading and trailing text become their own tokens', 'Before [id:1] after', [
      text('Before '),
      cite('id', 1),
      text(' after'),
    ]],
    ['text with no citations is one token', 'No citations here.', [
      text('No citations here.'),
    ]],
  ])('%s', (_case, input, expected) => {
    expect(parseCitations(input)).toEqual(expected);
  });

  // The quote form: [id:N "verbatim"] carries a span for the UI to highlight
  // inside the turn-level highlight. It is only meaningful for a single id, so
  // any multi-id bracket drops it rather than guessing which id it belongs to.
  it.each([
    [
      'a quote attaches to a single id',
      '[id:42 "Israel constantly attacking targets"]',
      [cite('id', 42, 'Israel constantly attacking targets')],
    ],
    [
      'a quote attaches to a single turn',
      '[turn:99 "rising power and all the rest"]',
      [cite('turn', 99, 'rising power and all the rest')],
    ],
    [
      'a quote is dropped on a multi-id bracket',
      '[id:1,2 "some quote"]',
      [cite('id', 1), cite('id', 2)],
    ],
    [
      'a quote is dropped on a mixed-kind bracket',
      '[id:1, turn:2 "some quote"]',
      [cite('id', 1), cite('turn', 2)],
    ],
    [
      'surrounding text survives a quoted citation',
      'He noted [id:5 "Houthis rising power"] in his analysis.',
      [
        text('He noted '),
        cite('id', 5, 'Houthis rising power'),
        text(' in his analysis.'),
      ],
    ],
    [
      'quoted and unquoted citations coexist in one string',
      '[id:1 "first quote"] and [id:2]',
      [cite('id', 1, 'first quote'), text(' and '), cite('id', 2)],
    ],
  ])('%s', (_case, input, expected) => {
    expect(parseCitations(input)).toEqual(expected);
  });
});
