import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

// Keyed by pathname: resolveUploads fetches by pathname so the SDK targets this
// app's own store. `size` overrides the reported size to test metadata checks
// without allocating; `fail` simulates a Blob outage.
type FakeBlob = { bytes: Buffer; contentType: string; size?: number; fail?: boolean };
const blobs = new Map<string, FakeBlob>();
const getMock = vi.fn(async (pathname: string) => {
  const b = blobs.get(pathname);
  if (!b) return null;
  if (b.fail) throw new Error('Failed to fetch blob: 503 Service Unavailable');
  return {
    statusCode: 200,
    stream: new Response(new Uint8Array(b.bytes)).body,
    blob: { contentType: b.contentType, size: b.size ?? b.bytes.length },
  };
});

vi.mock('@vercel/blob', () => ({
  get: (pathname: string) => getMock(pathname),
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
    return { numPages: pdf.pages.length, key, loadingTask: { destroy: async () => {} } };
  },
  extractText: async (proxy: { key: string }) => {
    const pdf = pdfs.get(proxy.key)!;
    return { totalPages: pdf.pages.length, text: pdf.pages };
  },
}));

import { estimateTokens, isUploadBlobUrl, resolveUploads } from './upload-parts';

let n = 0;
function blobUrl(name: string): string {
  n += 1;
  return `https://store123.private.blob.vercel-storage.com/uploads/${n}-${name}`;
}

function putBlob(name: string, bytes: Buffer, contentType: string, extra: Partial<FakeBlob> = {}): string {
  const url = blobUrl(name);
  blobs.set(new URL(url).pathname.slice(1), { bytes, contentType, ...extra });
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

  it('rejects, without fetching, a URL outside the upload store', async () => {
    const res = await resolveUploads(
      [userMessage({ url: 'https://example.com/uploads/x.pdf', mediaType: 'application/pdf', filename: 'x.pdf' })],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/unsupported URL/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('rejects an oversize image from its metadata', async () => {
    const url = putBlob('big.png', Buffer.alloc(6 * 1024 * 1024), 'image/png');
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'image/png', filename: 'big.png' })],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/per image/);
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

function assistant(text: string): UIMessage {
  return { id: `a${n}`, role: 'assistant', parts: [{ type: 'text', text }] };
}

function noteText(res: Awaited<ReturnType<typeof resolveUploads>>, msg: number, part = 1): string {
  if (!res.ok) throw new Error(res.error);
  return (res.messages[msg].parts[part] as { text: string }).text;
}

describe('resolveUploads limits and history', () => {
  it('fetches by pathname, never by the client-supplied store host', async () => {
    const url = putBlob('notes.txt', Buffer.from('hi'), 'text/plain');
    const otherStore = url.replace('store123', 'otherstore');
    await resolveUploads(
      [userMessage({ url: otherStore, mediaType: 'text/plain', filename: 'notes.txt' })],
      { modelId: MODEL },
    );
    expect(getMock).toHaveBeenCalledWith(new URL(url).pathname.slice(1));
  });

  it('turns a Blob outage into a 413-style error, not a throw', async () => {
    const url = putBlob('a.txt', Buffer.from('x'), 'text/plain', { fail: true });
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'text/plain', filename: 'a.txt' })],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/couldn't be loaded/);
  });

  it('downgrades a failing attachment in an earlier turn to a note', async () => {
    const scan = putPdf('scan.pdf', Array.from({ length: 250 }, () => ''));
    const res = await resolveUploads(
      [
        userMessage({ url: scan, mediaType: 'application/pdf', filename: 'scan.pdf' }),
        assistant('Sorry, that one failed.'),
        userMessage(),
      ],
      { modelId: MODEL },
    );
    expect(noteText(res, 0)).toMatch(/from earlier in this conversation couldn't be used: .*no selectable text/);
  });

  it('leaves out older attachments that no longer fit, keeping the newest', async () => {
    const page = 'word '.repeat(640); // ~800 tokens
    const older = putPdf('older.pdf', Array.from({ length: 120 }, () => page)); // ~96k tokens
    const newer = putPdf('newer.pdf', Array.from({ length: 120 }, () => page));
    const res = await resolveUploads(
      [
        userMessage({ url: older, mediaType: 'application/pdf', filename: 'older.pdf' }),
        assistant('Read it.'),
        userMessage({ url: newer, mediaType: 'application/pdf', filename: 'newer.pdf' }),
      ],
      { modelId: MODEL },
    );
    expect(noteText(res, 0)).toMatch(/left out of this turn/);
    expect(noteText(res, 2)).toContain('<uploaded_file name="newer.pdf"');
  });

  it('caps native PDF pages per request', async () => {
    const pages = Array.from({ length: 60 }, () => 'Some prose on this page.');
    const a = putPdf('a.pdf', pages);
    const b = putPdf('b.pdf', pages);
    const res = await resolveUploads(
      [
        userMessage(
          { url: a, mediaType: 'application/pdf', filename: 'a.pdf' },
          { url: b, mediaType: 'application/pdf', filename: 'b.pdf' },
        ),
      ],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/120 pages, more than the 100/);
  });

  it('rejects an image format the model cannot read', async () => {
    const url = putBlob('photo.heic', Buffer.from('x'), 'image/heic');
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'image/heic', filename: 'photo.heic' })],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/Convert it to JPEG or PNG/);
  });

  it('rejects oversize text from its metadata', async () => {
    const url = putBlob('dump.txt', Buffer.from('x'), 'text/plain', { size: 5 * 1024 * 1024 });
    const res = await resolveUploads(
      [userMessage({ url, mediaType: 'text/plain', filename: 'dump.txt' })],
      { modelId: MODEL },
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/more than can be sent/);
  });

  it('enforces the per-message total on the server', async () => {
    const big = { size: 45 * 1024 * 1024 };
    const files = ['a', 'b', 'c'].map((x) => ({
      url: putPdf(`${x}.pdf`, ['p']),
      mediaType: 'application/pdf',
      filename: `${x}.pdf`,
    }));
    for (const f of files) {
      const key = new URL(f.url).pathname.slice(1);
      blobs.set(key, { ...blobs.get(key)!, ...big });
    }
    const res = await resolveUploads([userMessage(...files)], { modelId: MODEL });
    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.error).toMatch(/Attachments total more than/);
  });
});

describe('resolveUploads validation', () => {
  it('accepts blob and data URLs in the latest message', async () => {
    const ok = userMessage(
      { url: putBlob('a.txt', Buffer.from('a'), 'text/plain'), mediaType: 'text/plain', filename: 'a.txt' },
      { url: 'data:text/plain,hi', mediaType: 'text/plain', filename: 'b.txt' },
    );
    expect((await resolveUploads([ok], { modelId: MODEL })).ok).toBe(true);
  });
});

describe('isUploadBlobUrl', () => {
  it('requires https, the blob host, and the uploads/ prefix', () => {
    expect(isUploadBlobUrl('https://s.private.blob.vercel-storage.com/uploads/a.pdf')).toBe(true);
    expect(isUploadBlobUrl('http://s.private.blob.vercel-storage.com/uploads/a.pdf')).toBe(false);
    expect(isUploadBlobUrl('https://s.private.blob.vercel-storage.com/other/a.pdf')).toBe(false);
    expect(isUploadBlobUrl('https://blob.vercel-storage.com.evil.test/uploads/a.pdf')).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('counts non-Latin script as denser than Latin', () => {
    expect(estimateTokens('abcd'.repeat(100))).toBe(100);
    expect(estimateTokens('שלום'.repeat(100))).toBeGreaterThan(200);
  });
});
