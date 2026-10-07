// Upload handling shared by the prep and news chat routes.
//
// The browser uploads attachments straight to Vercel Blob (see
// app/api/uploads/route.ts) and the chat message carries only the private blob
// URL. Before the model sees the conversation, every such file part is
// resolved here:
//
//   - text-ish uploads (.md, .txt, .csv, …) become a text part
//   - images (JPEG, PNG, GIF, WebP) become an inline data URL
//   - PDFs within NATIVE_PDF_MAX_PAGES / NATIVE_PDF_MAX_BYTES go natively (the
//     model reads text and page images); larger ones — books — are sent as
//     extracted text with page markers, which is several times cheaper and
//     fits in context where the native form never would.
//
// Legacy inline data URLs (messages from before blob uploads) keep the old
// behavior: text-ish files are decoded, everything else passes through.

import type { UIMessage } from 'ai';
import { del, get, list } from '@vercel/blob';
import { extractText, getDocumentProxy } from 'unpdf';

import { errText, errorEvent } from './log-event';
import { getContextWindow } from './models';
import {
  EXTRACTED_TEXT_CONTEXT_SHARE,
  EXTRACTED_TEXT_MAX_TOKENS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_REQUEST_INLINE_BYTES,
  MAX_REQUEST_PDF_PAGES,
  MAX_TOTAL_BYTES,
  NATIVE_PDF_MAX_BYTES,
  NATIVE_PDF_MAX_PAGES,
  SUPPORTED_IMAGE_TYPES,
  UPLOAD_PATH_PREFIX,
  UPLOAD_RETENTION_DAYS,
  formatBytes,
  isTextMediaType,
} from './prep-limits';

type Part = UIMessage['parts'][number];
type FilePart = Extract<Part, { type: 'file' }>;

function decodeDataUrl(url: string): string | null {
  const match = /^data:[^;,]*(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const isBase64 = match[1] === ';base64';
  const payload = match[2];
  try {
    if (isBase64) return Buffer.from(payload, 'base64').toString('utf8');
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

function attr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

function uploadedFileText(name: string, mediaType: string, body: string, extra = ''): Part {
  return {
    type: 'text',
    text: `<uploaded_file name="${attr(name)}" media_type="${mediaType}"${extra}>\n${body}\n</uploaded_file>`,
  };
}

// Only blobs this app uploaded are fetched — never an arbitrary URL a client
// put in a message.
export function isUploadBlobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname.endsWith('.blob.vercel-storage.com') &&
      u.pathname.startsWith(`/${UPLOAD_PATH_PREFIX}`)
    );
  } catch {
    return false;
  }
}

// Rough token estimate for budget checks. Latin text runs ~4 chars/token;
// Hebrew and other non-Latin scripts tokenize far less efficiently.
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5);
}

// Inspects the latest user message only — historical turns were already
// validated on their own request. Sizes are enforced by the Blob upload token;
// this guards the count and rejects file URLs we wouldn't fetch. Returns null
// on success, an error message on violation.
function validateLatestUploads(messages: UIMessage[]): string | null {
  const lastUser = messages.findLast((m) => m.role === 'user');
  if (!lastUser?.parts) return null;
  const fileParts = lastUser.parts.filter((p) => p.type === 'file');
  if (fileParts.length > MAX_FILES) {
    return `Too many files (${fileParts.length}). Maximum ${MAX_FILES} per message.`;
  }
  for (const p of fileParts) {
    if (!p.url.startsWith('data:') && !isUploadBlobUrl(p.url)) {
      return `File "${p.filename ?? 'uploaded file'}" has an unsupported URL. Re-attach it and try again.`;
    }
  }
  return null;
}

// -- Blob resolution ---------------------------------------------------------

// What a resolved part costs against the per-request limits.
type Cost = { textTokens: number; pdfPages: number; inlineBytes: number };
const FREE: Cost = { textTokens: 0, pdfPages: 0, inlineBytes: 0 };

type Resolved =
  | { kind: 'part'; part: Part; cost: Cost }
  | { kind: 'error'; message: string };

function note(text: string): Part {
  return { type: 'text', text };
}

// Fluid Compute reuses instances, so a follow-up turn in the same conversation
// usually skips re-downloading and re-parsing the same book. Bounded by total
// characters held (≈2 bytes each in a JS string), least-recently-used evicted
// first.
const RESOLVED_CACHE_MAX_CHARS = 16 * 1024 * 1024;
const resolvedCache = new Map<string, { value: Resolved; chars: number }>();
let resolvedCacheChars = 0;

function cacheGet(key: string): Resolved | undefined {
  const entry = resolvedCache.get(key);
  if (!entry) return undefined;
  resolvedCache.delete(key);
  resolvedCache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: Resolved & { kind: 'part' }): void {
  const p = value.part;
  const chars = p.type === 'text' ? p.text.length : p.type === 'file' ? p.url.length : 0;
  if (chars > RESOLVED_CACHE_MAX_CHARS) return;
  const prev = resolvedCache.get(key);
  if (prev) resolvedCacheChars -= prev.chars;
  resolvedCache.delete(key);
  resolvedCache.set(key, { value, chars });
  resolvedCacheChars += chars;
  for (const [k, e] of resolvedCache) {
    if (resolvedCacheChars <= RESOLVED_CACHE_MAX_CHARS) break;
    resolvedCache.delete(k);
    resolvedCacheChars -= e.chars;
  }
}

function inlineFilePart(name: string, mediaType: string, bytes: Buffer, pdfPages = 0): Resolved {
  return {
    kind: 'part',
    part: {
      type: 'file',
      mediaType,
      filename: name,
      url: `data:${mediaType};base64,${bytes.toString('base64')}`,
    },
    cost: { textTokens: 0, pdfPages, inlineBytes: bytes.length },
  };
}

async function resolvePdf(name: string, bytes: Buffer): Promise<Resolved> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    return { kind: 'error', message: `"${name}" could not be read as a PDF.` };
  }

  try {
    if (pdf.numPages <= NATIVE_PDF_MAX_PAGES && bytes.length <= NATIVE_PDF_MAX_BYTES) {
      return inlineFilePart(name, 'application/pdf', bytes, pdf.numPages);
    }

    const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
    const charCount = pages.reduce((n, p) => n + p.trim().length, 0);
    // A scanned book has page images and no text layer. ~50 chars/page is well
    // below any real prose page, so this only trips on image-only PDFs.
    if (charCount < totalPages * 50) {
      return {
        kind: 'error',
        message: `"${name}" (${totalPages} pages) has no selectable text — it looks like a scan. Run it through OCR first, or attach a ${NATIVE_PDF_MAX_PAGES}-page-or-shorter excerpt.`,
      };
    }

    const body = pages
      .map((p, i) => (p.trim() ? `[page ${i + 1}]\n${p.trim()}` : ''))
      .filter(Boolean)
      .join('\n\n');
    return {
      kind: 'part',
      part: uploadedFileText(
        name,
        'application/pdf',
        body,
        ` pages="${totalPages}" note="Text extracted from a large PDF; images and layout are not included. Cite page numbers from the [page N] markers."`,
      ),
      cost: { ...FREE, textTokens: estimateTokens(body) },
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// Rejects a blob from its metadata alone, before any bytes are downloaded.
// `messageBytes` is the running total for the latest message, which the
// server enforces too (the Blob token only caps each file).
function rejectBeforeDownload(
  name: string,
  mediaType: string,
  size: number,
  messageBytes?: { total: number },
): string | null {
  if (size > MAX_FILE_BYTES) {
    return `"${name}" is ${formatBytes(size)}. Maximum ${formatBytes(MAX_FILE_BYTES)} per file.`;
  }
  if (messageBytes) {
    messageBytes.total += size;
    if (messageBytes.total > MAX_TOTAL_BYTES) {
      return `Attachments total more than ${formatBytes(MAX_TOTAL_BYTES)}. Attach fewer files per message.`;
    }
  }
  if (mediaType.startsWith('image/')) {
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      return `Image "${name}" is ${mediaType}, which the model can't read. Convert it to JPEG or PNG.`;
    }
    if (size > MAX_IMAGE_BYTES) {
      return `Image "${name}" is ${formatBytes(size)}. Maximum ${formatBytes(MAX_IMAGE_BYTES)} per image.`;
    }
    return null;
  }
  if (isTextMediaType(mediaType)) {
    // Any UTF-8 text costs at least one token per 6 bytes (estimateTokens), so
    // a file this large can't fit the budget whatever it contains.
    if (size / 6 > EXTRACTED_TEXT_MAX_TOKENS) {
      return `"${name}" is ${formatBytes(size)} of text, more than can be sent to the model. Attach only the part you need.`;
    }
    return null;
  }
  if (mediaType === 'application/pdf') return null;
  return `"${name}" has an unsupported file type (${mediaType}).`;
}

async function resolveBlobPart(
  part: FilePart,
  messageBytes?: { total: number },
): Promise<Resolved> {
  // Fetched by pathname, so the SDK builds the URL for this app's own store —
  // a client can't point us at another store's blob.
  const pathname = new URL(part.url).pathname.slice(1);
  const cached = cacheGet(pathname);
  if (cached) return cached;

  const name = part.filename ?? 'uploaded file';
  let result;
  try {
    result = await get(pathname, { access: 'private' });
  } catch (err) {
    errorEvent('uploads.fetch_failed', { pathname, error: errText(err) });
    return { kind: 'error', message: `"${name}" couldn't be loaded from storage. Try again in a moment.` };
  }
  if (!result || result.statusCode !== 200) {
    // Expired (UPLOAD_RETENTION_DAYS) or deleted. Don't fail the whole turn —
    // an old message in a long-open tab shouldn't block a new question.
    return {
      kind: 'part',
      part: note(`[Attachment "${name}" is no longer available; it was shared earlier in this conversation.]`),
      cost: FREE,
    };
  }

  const mediaType = part.mediaType || result.blob.contentType;
  const rejection = rejectBeforeDownload(name, mediaType, result.blob.size, messageBytes);
  if (rejection) {
    await result.stream.cancel();
    return { kind: 'error', message: rejection };
  }

  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  const resolved = await resolveBytes(name, mediaType, bytes);
  if (resolved.kind === 'part') cacheSet(pathname, resolved);
  return resolved;
}

async function resolveBytes(name: string, mediaType: string, bytes: Buffer): Promise<Resolved> {
  if (isTextMediaType(mediaType)) {
    const text = bytes.toString('utf8');
    return {
      kind: 'part',
      part: uploadedFileText(name, mediaType, text),
      cost: { ...FREE, textTokens: estimateTokens(text) },
    };
  }
  if (mediaType === 'application/pdf') return resolvePdf(name, bytes);
  return inlineFilePart(name, mediaType, bytes);
}

function resolveDataUrlPart(part: FilePart): Part {
  if (!isTextMediaType(part.mediaType)) return part;
  const text = decodeDataUrl(part.url);
  if (text === null) return part;
  return uploadedFileText(part.filename ?? 'uploaded file', part.mediaType, text);
}

function resolveFilePart(part: FilePart, messageBytes?: { total: number }): Promise<Resolved> | Resolved {
  if (isUploadBlobUrl(part.url)) return resolveBlobPart(part, messageBytes);
  if (part.url.startsWith('data:')) {
    return { kind: 'part', part: resolveDataUrlPart(part), cost: FREE };
  }
  return { kind: 'part', part, cost: FREE };
}

// Runs `fn` over `items` with at most `limit` in flight, keeping order. Bounds
// how many attachments are held in memory at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R> | R): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const BLOB_FETCH_CONCURRENCY = 3;

export type ResolveUploadsResult =
  | { ok: true; messages: UIMessage[] }
  | { ok: false; error: string };

/**
 * Validate the latest message's attachments, then turn every file part in user
 * messages into something the model can read.
 *
 * Only the latest message can fail the request (for a 413): a file it can't
 * use, or attachments that on their own exceed the per-request limits.
 * Attachments from earlier turns are budgeted newest-first, and any that fail
 * or no longer fit become a short note instead — a bad upload in history must
 * not block every later question. Documents are never silently truncated.
 */
export async function resolveUploads(
  messages: UIMessage[],
  opts: { modelId: string },
): Promise<ResolveUploadsResult> {
  const invalid = validateLatestUploads(messages);
  if (invalid) return { ok: false, error: invalid };

  const latestIndex = messages.findLastIndex((m) => m.role === 'user');
  const jobs: Array<{ msg: number; idx: number; part: FilePart }> = [];
  messages.forEach((m, msg) => {
    if (m.role !== 'user' || !Array.isArray(m.parts)) return;
    m.parts.forEach((part, idx) => {
      if (part.type === 'file') jobs.push({ msg, idx, part });
    });
  });

  const messageBytes = { total: 0 };
  const resolved = await mapLimit(jobs, BLOB_FETCH_CONCURRENCY, (j) =>
    resolveFilePart(j.part, j.msg === latestIndex ? messageBytes : undefined),
  );

  const limits: Cost = {
    textTokens: Math.min(
      EXTRACTED_TEXT_MAX_TOKENS,
      Math.floor(getContextWindow(opts.modelId) * EXTRACTED_TEXT_CONTEXT_SHARE),
    ),
    pdfPages: MAX_REQUEST_PDF_PAGES,
    inlineBytes: MAX_REQUEST_INLINE_BYTES,
  };
  const used: Cost = { ...FREE };
  const replacements = new Map<string, Part>();

  // Newest first, so the latest message always gets first claim on the budget.
  for (let k = jobs.length - 1; k >= 0; k--) {
    const { msg, idx, part } = jobs[k];
    const r = resolved[k];
    const latest = msg === latestIndex;
    const name = part.filename ?? 'uploaded file';
    if (r.kind === 'error') {
      if (latest) return { ok: false, error: r.message };
      replacements.set(`${msg}:${idx}`, note(`[Attachment "${name}" from earlier in this conversation couldn't be used: ${r.message}]`));
      continue;
    }
    const over = overLimit(used, r.cost, limits);
    if (over) {
      if (latest) return { ok: false, error: over };
      replacements.set(
        `${msg}:${idx}`,
        note(`[Attachment "${name}" was shared earlier in this conversation but is left out of this turn to stay within the model's request limits. Ask the writer to re-attach it if it's needed.]`),
      );
      continue;
    }
    used.textTokens += r.cost.textTokens;
    used.pdfPages += r.cost.pdfPages;
    used.inlineBytes += r.cost.inlineBytes;
    replacements.set(`${msg}:${idx}`, r.part);
  }

  return {
    ok: true,
    messages: messages.map((m, msg) =>
      m.role === 'user' && Array.isArray(m.parts)
        ? { ...m, parts: m.parts.map((p, idx) => replacements.get(`${msg}:${idx}`) ?? p) }
        : m,
    ),
  };
}

// The user-facing reason adding `cost` would exceed a limit, or null.
function overLimit(used: Cost, cost: Cost, limits: Cost): string | null {
  const text = used.textTokens + cost.textTokens;
  if (text > limits.textTokens) {
    return (
      `The attached documents come to about ${Math.round(text / 1000)}k tokens of text, ` +
      `more than can be sent alongside the rest of the conversation (about ${Math.round(limits.textTokens / 1000)}k). ` +
      `Attach only the chapters you need — for example, export a page range from Preview.`
    );
  }
  const pages = used.pdfPages + cost.pdfPages;
  if (pages > limits.pdfPages) {
    return `The attached PDFs come to ${pages} pages, more than the ${limits.pdfPages} the model accepts in one message. Attach fewer PDFs at a time.`;
  }
  const bytes = used.inlineBytes + cost.inlineBytes;
  if (bytes > limits.inlineBytes) {
    return `The attached PDFs and images come to ${formatBytes(bytes)}, more than the ${formatBytes(limits.inlineBytes)} the model accepts in one message. Attach fewer at a time.`;
  }
  return null;
}

// -- Retention ---------------------------------------------------------------

/** Delete uploaded attachments older than UPLOAD_RETENTION_DAYS. Run by the daily purge cron. */
export async function purgeExpiredUploads(): Promise<number> {
  const cutoff = Date.now() - UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: UPLOAD_PATH_PREFIX, cursor, limit: 1000 });
    const expired = page.blobs
      .filter((b) => b.uploadedAt.getTime() < cutoff)
      .map((b) => b.url);
    if (expired.length > 0) {
      await del(expired);
      deleted += expired.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
