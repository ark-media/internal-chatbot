import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

const blobs = new Map<string, { bytes: Buffer; contentType: string }>();
const getMock = vi.fn(async (url: string) => {
  const b = blobs.get(url);
  if (!b) return null;
  return {
    statusCode: 200,
    stream: new Response(new Uint8Array(b.bytes)).body,
    blob: { contentType: b.contentType, size: b.bytes.length },
  };
});

vi.mock('@vercel/blob', () => ({
  get: (url: string) => getMock(url),
  list: vi.fn(),
  del: vi.fn(),
}));

// PDFs are described by their first bytes so each test can pick a page count
// and text layer without shipping fixture files.
type FakePdf = { pages: string[] };
const pdfs = new Map<string, FakePdf>();
vi.mock('unpdf', () => ({
  getDocumentProxy: async (data: Uint8Array) => {
    const key = Buffer.from(data).toString('utf8');
    const pdf = pdfs.get(key);
    if (!pdf) throw new Error('not a pdf');
    return { numPages: pdf.pages.length, key };
  },
  extractText: async (proxy: { key: string }) => {
    const pdf = pdfs.get(proxy.key)!;
    return { totalPages: pdf.pages.length, text: pdf.pages };
  },
}));

import { estimateTokens, isUploadBlobUrl, resolveUploads, validateUploads } from './upload-parts';

let n = 0;
function blobUrl(name: string): string {
  n += 1;
  return `https://store123.private.blob.vercel-storage.com/uploads/${n}-${name}`;
}

function putBlob(name: string, bytes: Buffer, contentType: string): string {
  const url = blobUrl(name);
  blobs.set(url, { bytes, contentType });
  return url;
}

function putPdf(name: string, pages: string[]): string {
  const key = `pdf-${name}-${n}`;
  pdfs.set(key, { pages });
  return putBlob(name, Buffer.from(key), 'application/pdf');
}

function userMessage(...files: Array<{ url: string; mediaType: string; filename: string }>): UIMessage {
  return {
    id: `m${n}`,
    role: 'user',
    parts: [
      { type: 'text', text: 'Prep me for this guest.' },
      ...files.map((f) => ({ type: 'file' as const, ...f })),
    ],
  };
}

const MODEL = 'anthropic/claude-sonnet-4-6'; // 200k context → 120k-token text budget

beforeEach(() => {
  blobs.clear();
  pdfs.clear();
  getMock.mockClear();
});

describe('resolveUploads', () => {
  it('turns a text blob into an uploaded_file text part', async () => {
    const url = putBlob('notes.md', Buffer.from('# Guest notes'), 'text/markdown');
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'text/markdown', filename: 'notes.md' })],
      { modelId: MODEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const part = res.messages[0].parts[1];
    expect(part).toMatchObject({ type: 'text' });
    expect((part as { text: string }).text).toContain('<uploaded_file name="notes.md"');
    expect((part as { text: string }).text).toContain('# Guest notes');
  });

  it('sends a short PDF natively as an inline data URL', async () => {
    const url = putPdf('outline.pdf', Array.from({ length: 20 }, () => 'Some prose on this page.'));
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'application/pdf', filename: 'outline.pdf' })],
      { modelId: MODEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const part = res.messages[0].parts[1] as { type: string; url: string; mediaType: string };
    expect(part.type).toBe('file');
    expect(part.mediaType).toBe('application/pdf');
    expect(part.url.startsWith('data:application/pdf;base64,')).toBe(true);
  });

  it('extracts text with page markers from a book-length PDF', async () => {
    const pages = Array.from({ length: 300 }, (_, i) => `Chapter text on page ${i + 1}. `.repeat(10));
    const url = putPdf('book.pdf', pages);
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'application/pdf', filename: 'book.pdf' })],
      { modelId: MODEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const text = (res.messages[0].parts[1] as { text: string }).text;
    expect(text).toContain('pages="300"');
    expect(text).toContain('[page 1]\nChapter text on page 1.');
    expect(text).toContain('[page 300]');
  });

  it('rejects a scanned PDF with no text layer', async () => {
    const url = putPdf('scan.pdf', Array.from({ length: 250 }, () => ''));
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'application/pdf', filename: 'scan.pdf' })],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/no selectable text/);
  });

  it('rejects documents whose text would crowd out the context window', async () => {
    // ~2,000 tokens per page × 300 pages ≈ 600k tokens, far over the 120k budget.
    const url = putPdf('huge.pdf', Array.from({ length: 300 }, () => 'word '.repeat(1600)));
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'application/pdf', filename: 'huge.pdf' })],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/Attach only the chapters you need/);
  });

  it('lets a full book through on a 1M-context model', async () => {
    // ~800 tokens per page × 300 pages ≈ 240k tokens: over a 200k model's
    // budget, under the 300k cap.
    const pages = Array.from({ length: 300 }, () => 'word '.repeat(640));
    const book = putPdf('book.pdf', pages);
    const msgs = [userMessage({ url: book, mediaType: 'application/pdf', filename: 'book.pdf' })];
    expect((await resolveUploads(msgs, { modelId: 'anthropic/claude-sonnet-5' })).ok).toBe(true);
    expect((await resolveUploads(msgs, { modelId: MODEL })).ok).toBe(false);
  });

  it('replaces an expired blob with a note instead of failing the turn', async () => {
    const url = blobUrl('gone.pdf');
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'application/pdf', filename: 'gone.pdf' })],
      { modelId: MODEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.messages[0].parts[1] as { text: string }).text).toMatch(/no longer available/);
  });

  it('never fetches a URL outside the upload store', async () => {
    const res = await resolveUploads(
      [userMessage({ url: 'https://example.com/uploads/x.pdf', mediaType: 'application/pdf', filename: 'x.pdf' })],
      { modelId: MODEL },
    );
    expect(res.ok).toBe(true);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('still decodes legacy inline text data URLs', async () => {
    const url = `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`;
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'text/plain', filename: 'a.txt' })],
      { modelId: MODEL },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.messages[0].parts[1] as { text: string }).text).toContain('hello');
  });
});

describe('validateUploads', () => {
  it('accepts blob and data URLs, rejects anything else', () => {
    const ok = userMessage(
      { url: blobUrl('a.pdf'), mediaType: 'application/pdf', filename: 'a.pdf' },
      { url: 'data:text/plain,hi', mediaType: 'text/plain', filename: 'b.txt' },
    );
    expect(validateUploads([ok])).toBeNull();
    const bad = userMessage({ url: 'https://evil.test/a.pdf', mediaType: 'application/pdf', filename: 'a.pdf' });
    expect(validateUploads([bad])).toMatch(/unsupported URL/);
  });
});

describe('isUploadBlobUrl', () => {
  it('requires https, the blob host, and the uploads/ prefix', () => {
    expect(isUploadBlobUrl('https://s.private.blob.vercel-storage.com/uploads/a.pdf')).toBe(true);
    expect(isUploadBlobUrl('http://s.private.blob.vercel-storage.com/uploads/a.pdf')).toBe(false);
    expect(isUploadBlobUrl('https://s.private.blob.vercel-storage.com/other/a.pdf')).toBe(false);
    expect(isUploadBlobUrl('https://blob.vercel-storage.com.evil.test/uploads/a.pdf')).toBe(false);
    expect(isUploadBlobUrl(undefined)).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('counts non-Latin script as denser than Latin', () => {
    expect(estimateTokens('abcd'.repeat(100))).toBe(100);
    expect(estimateTokens('שלום'.repeat(100))).toBeGreaterThan(200);
  });
});
