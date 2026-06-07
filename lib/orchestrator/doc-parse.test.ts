import { describe, expect, it } from 'vitest';
import TurndownService from 'turndown';

import { parseDocumentToMarkdown, UnsupportedDocError } from './doc-parse';

describe('parseDocumentToMarkdown', () => {
  it('passes .md through unchanged, preserving inline links', async () => {
    const src = '# Hi\n\n([Reuters](https://reuters.com))';
    const out = await parseDocumentToMarkdown(Buffer.from(src), 'dossier.md', 'text/markdown');
    expect(out).toBe(src);
  });

  it('treats .txt as plain markdown', async () => {
    const out = await parseDocumentToMarkdown(Buffer.from('plain text'), 'a.txt', 'text/plain');
    expect(out).toBe('plain text');
  });

  it('treats empty mime as markdown (falls back to text)', async () => {
    const out = await parseDocumentToMarkdown(Buffer.from('hello'), 'unknown', '');
    expect(out).toBe('hello');
  });

  it('rejects unsupported types', async () => {
    await expect(
      parseDocumentToMarkdown(Buffer.from('%PDF'), 'a.pdf', 'application/pdf'),
    ).rejects.toBeInstanceOf(UnsupportedDocError);
  });
});

// Guards the load-bearing assumption that turndown preserves <a href> links
// server-side (the .docx → HTML → markdown path depends on this).
describe('turndown link preservation', () => {
  it('converts <a href> into a markdown link', () => {
    const td = new TurndownService();
    const md = td.turndown('<p>See <a href="https://reuters.com">Reuters</a></p>');
    expect(md).toBe('See [Reuters](https://reuters.com)');
  });
});
