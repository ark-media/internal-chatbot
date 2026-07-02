import { describe, expect, it } from 'vitest';

import { extractSources, parseScriptCoverage } from './news-script';

// A representative finalized script: SONIC ID + HOST intro boilerplate, three
// story blocks, the sign-off, and a SOURCES list.
const FINALIZED_SCRIPT = `---

SONIC ID: You are listening to an Ark Media Podcast.

HOST: It's Tuesday, June 30.
I'm Deborah Pardes and this is Ark News Daily.

[A BLOCK]
HOST:
Israel and Hamas edged toward a ceasefire yesterday¹, the first real break in months.

[B BLOCK]
HOST:
Separately, Iran restarted enrichment at a second site², drawing a sharp IAEA rebuke.

[C BLOCK]
A lighter close: the Maccabiah Games opened in Jerusalem³.

I'm Deborah Pardes, and this is Ark News Daily.

---

SOURCES:

1. Times of Israel — https://timesofisrael.com/ceasefire — June 30 2026
2. Reuters — https://reuters.com/iran-enrichment — June 30 2026
3. Jerusalem Post — https://jpost.com/maccabiah — June 29 2026`;

describe('parseScriptCoverage', () => {
  it('splits the script into A/B/C story blocks and pulls the sources', () => {
    const { blocks, sources } = parseScriptCoverage(FINALIZED_SCRIPT);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.label)).toEqual(['A', 'B', 'C']);
    expect(sources).toHaveLength(3);
  });

  it('does not return intro/outro boilerplate as a block', () => {
    const { blocks } = parseScriptCoverage(FINALIZED_SCRIPT);
    const joined = blocks.map((b) => b.text).join('\n');
    // SONIC ID intro is dropped entirely.
    expect(joined).not.toContain('SONIC ID');
    // The sign-off is stripped from the trailing (C) block.
    expect(blocks[2].text).not.toContain('this is Ark News Daily');
    expect(blocks[2].text).toContain('Maccabiah Games');
  });

  it('carries the real block body text', () => {
    const { blocks } = parseScriptCoverage(FINALIZED_SCRIPT);
    expect(blocks[0].text).toContain('ceasefire');
    expect(blocks[1].text).toContain('enrichment');
  });

  it('returns sources: [] without throwing when there is no SOURCES section', () => {
    const noSources = `[A BLOCK]
HOST:
A story with no source list at all.

[B BLOCK]
HOST:
Another block.`;
    const { blocks, sources } = parseScriptCoverage(noSources);
    expect(sources).toEqual([]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.label)).toEqual(['A', 'B']);
  });

  it('returns no blocks for prose that has no block markers', () => {
    const { blocks } = parseScriptCoverage('Just some prose with no markers.');
    expect(blocks).toEqual([]);
  });

  it('parses bare (unbracketed) A/B/C block headers from a pasted script', () => {
    // Externally-authored finalized scripts use bare headers and inline
    // superscript footnotes rather than the tool's own `[A BLOCK]` + SOURCES form.
    const bareScript = `It's Thursday, July 2nd.
I'm Deborah Pardes and this is Ark News Daily.

A BLOCK
Today marks 1,000 days since October 7th¹.

B BLOCK
A Democratic Socialist knocked off a 15-term incumbent².

C BLOCK
The creators of Fauda are issuing a warning to viewers³.

I'm Deborah Pardes, and this is Ark News Daily`;
    const { blocks, sources } = parseScriptCoverage(bareScript);
    expect(blocks.map((b) => b.label)).toEqual(['A', 'B', 'C']);
    expect(blocks[0].text).toContain('1,000 days');
    expect(blocks[2].text).toContain('Fauda');
    // No SOURCES list — footnotes are not parsed, so sources is empty.
    expect(sources).toEqual([]);
    // The intro is not mistaken for a block despite the "A" in the outro.
    expect(blocks[0].text).not.toContain('this is Ark News Daily');
  });

  it('does not match prose that merely contains the word "block"', () => {
    const prose = `HOST intro line here.
Officials met to discuss the blockade today.
We covered a lot on the blocks this week.`;
    expect(parseScriptCoverage(prose).blocks).toEqual([]);
  });
});

describe('extractSources (via shared module)', () => {
  it('parses a standard numbered source line', () => {
    const { sources } = extractSources(FINALIZED_SCRIPT);
    expect(sources[0]).toMatchObject({
      num: 1,
      title: 'Times of Israel',
      url: 'https://timesofisrael.com/ceasefire',
    });
  });
});
