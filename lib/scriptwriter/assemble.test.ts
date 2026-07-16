import { describe, expect, it } from 'vitest';

import {
  episodeHeader,
  fallbackStitch,
  finalizeAssembly,
  fromSuperscript,
  parseBlock,
  renumberBlocks,
  sectionForSlot,
  toSuperscript,
  verifyBlocksVerbatim,
  type ApprovedBlock,
} from './assemble';

const A_BLOCK = `[A BLOCK]
HOST:
The lead story happened yesterday¹ and it matters a great deal² for the region.

---

SOURCES:

1. Reuters, "Lead story" — https://reuters.com/a
2. Times of Israel, "Why it matters" — https://toi.example/b`;

const B_BLOCK = `[B BLOCK]
HOST:
The second story¹ is a different angle² on the same day³.

---

SOURCES:

1. AP, "Second story" — https://ap.example/c
2. Haaretz, "Angle" — https://haaretz.example/d
3. CNN, "Same day" — https://cnn.example/e`;

const blocks: ApprovedBlock[] = [
  { slot: 'A', text: A_BLOCK },
  { slot: 'B', text: B_BLOCK },
];

describe('superscript helpers', () => {
  it('round-trips numbers', () => {
    for (const n of [1, 5, 10, 23]) {
      expect(fromSuperscript(toSuperscript(n))).toBe(n);
    }
    expect(toSuperscript(12)).toBe('¹²');
  });
});

describe('parseBlock', () => {
  it('splits body from numbered SOURCES entries', () => {
    const parsed = parseBlock(A_BLOCK);
    expect(parsed.body).toContain('[A BLOCK]');
    expect(parsed.body).not.toContain('SOURCES:');
    expect(parsed.sources).toEqual([
      { localNumber: 1, entry: 'Reuters, "Lead story" — https://reuters.com/a' },
      { localNumber: 2, entry: 'Times of Israel, "Why it matters" — https://toi.example/b' },
    ]);
  });

  it('tolerates a block with no SOURCES section', () => {
    const parsed = parseBlock('[C BLOCK]\nHOST:\nNo citations here.');
    expect(parsed.sources).toEqual([]);
    expect(parsed.body).toContain('No citations here.');
  });
});

describe('renumberBlocks', () => {
  it('renumbers superscripts into one global sequence and merges sources', () => {
    const { bodies, sourceEntries } = renumberBlocks(blocks);
    expect(bodies[0]).toContain('yesterday¹');
    expect(bodies[0]).toContain('great deal²');
    // B block's ¹²³ become ³⁴⁵ globally.
    expect(bodies[1]).toContain('second story³');
    expect(bodies[1]).toContain('different angle⁴');
    expect(bodies[1]).toContain('same day⁵');
    expect(sourceEntries).toHaveLength(5);
    expect(sourceEntries[2]).toContain('AP');
  });
});

describe('fallbackStitch', () => {
  it('produces a full episode: header, renumbered blocks, sign-off, merged sources', () => {
    const { fullText, sourceCount } = fallbackStitch(blocks, '2026-07-15', 'America/New_York');
    expect(fullText).toMatch(/^SONIC ID: You are listening to an Ark Media Podcast\./);
    expect(fullText).toContain("It's Wednesday, July 15.");
    expect(fullText).toContain('[A BLOCK]');
    expect(fullText).toContain('[B BLOCK]');
    expect(fullText).toContain("I'm Deborah Pardes, and this is Ark News Daily.");
    expect(fullText).toContain('3. AP, "Second story"');
    expect(sourceCount).toBe(5);
  });
});

describe('episodeHeader', () => {
  it('renders the writer-local calendar date', () => {
    expect(episodeHeader('2026-07-13', 'America/New_York')).toContain("It's Monday, July 13.");
  });
});

describe('verifyBlocksVerbatim', () => {
  it('passes when blocks survive verbatim (with renumbering and transitions)', () => {
    const { fullText } = fallbackStitch(blocks, '2026-07-15', 'America/New_York');
    const check = verifyBlocksVerbatim(fullText, blocks);
    expect(check.ok).toBe(true);
    for (const r of check.recalls) expect(r.recall).toBeGreaterThanOrEqual(0.95);
  });

  it('fails when a block was rewritten', () => {
    const rewritten = fallbackStitch(
      [
        blocks[0],
        {
          slot: 'B',
          text: '[B BLOCK]\nHOST:\nA completely different paraphrase that shares almost nothing with the approved text at all.',
        },
      ],
      '2026-07-15',
      'America/New_York',
    ).fullText;
    const check = verifyBlocksVerbatim(rewritten, blocks);
    expect(check.ok).toBe(false);
    expect(check.recalls.find((r) => r.slot === 'B')!.recall).toBeLessThan(0.95);
  });

  it('fails when a block marker is missing entirely', () => {
    const check = verifyBlocksVerbatim('no markers here', blocks);
    expect(check.ok).toBe(false);
  });

  it('fails on injected prose even when the approved text is fully present', () => {
    // Recall alone can't catch additions; the added-token bound must.
    const clean = fallbackStitch(blocks, '2026-07-15', 'America/New_York').fullText;
    const injection = `moreover ${Array.from({ length: 70 }, (_, i) => `filler${i}`).join(' ')}`;
    const bloated = clean.replace('[B BLOCK]', `[B BLOCK]\n${injection}`);
    const check = verifyBlocksVerbatim(bloated, blocks);
    expect(check.ok).toBe(false);
    const b = check.recalls.find((r) => r.slot === 'B')!;
    expect(b.recall).toBeGreaterThanOrEqual(0.95); // approved prose intact...
    expect(b.added).toBeGreaterThan(60); // ...but net additions blow the budget
  });
});

describe('finalizeAssembly', () => {
  it('accepts a verbatim assembly unchanged', () => {
    const clean = fallbackStitch(blocks, '2026-07-15', 'America/New_York').fullText;
    const { fullText, usedFallback } = finalizeAssembly(
      clean,
      blocks,
      '2026-07-15',
      'America/New_York',
    );
    expect(usedFallback).toBe(false);
    expect(fullText).toBe(clean);
  });

  it('falls back to the mechanical stitch when a block was rewritten', () => {
    const rewritten = fallbackStitch(
      [
        blocks[0],
        {
          slot: 'B',
          text: '[B BLOCK]\nHOST:\nA completely different paraphrase that shares almost nothing with the approved text at all.',
        },
      ],
      '2026-07-15',
      'America/New_York',
    ).fullText;
    const { fullText, usedFallback } = finalizeAssembly(
      rewritten,
      blocks,
      '2026-07-15',
      'America/New_York',
    );
    expect(usedFallback).toBe(true);
    // The fallback restores the APPROVED B block verbatim.
    expect(fullText).toContain('second story');
  });

  it('falls back when approved prose is present but extra prose was injected', () => {
    const clean = fallbackStitch(blocks, '2026-07-15', 'America/New_York').fullText;
    const injection = `moreover ${Array.from({ length: 70 }, (_, i) => `filler${i}`).join(' ')}`;
    const bloated = clean.replace('[B BLOCK]', `[B BLOCK]\n${injection}`);
    const { usedFallback, fullText } = finalizeAssembly(
      bloated,
      blocks,
      '2026-07-15',
      'America/New_York',
    );
    expect(usedFallback).toBe(true);
    expect(fullText).not.toContain('filler0');
  });
});

describe('sectionForSlot', () => {
  it('extracts each block section, stopping at the next marker or SOURCES', () => {
    const { fullText } = fallbackStitch(blocks, '2026-07-15', 'America/New_York');
    const a = sectionForSlot(fullText, 'A')!;
    expect(a).toContain('lead story');
    expect(a).not.toContain('second story');
    const b = sectionForSlot(fullText, 'B')!;
    expect(b).toContain('second story');
    expect(b).not.toContain('SOURCES:');
  });
});
