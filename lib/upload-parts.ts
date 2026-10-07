// Upload handling shared by the prep and news chat routes.
//
// The browser uploads attachments straight to Vercel Blob (see
// app/api/uploads/route.ts) and the chat message carries only the private blob
// URL. Before the model sees the conversation, every such file part is
// resolved here:
//
//   - text-ish uploads (.md, .txt, .csv, …) become a text part
//   - images become an inline data URL
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

import { getContextWindow } from './models';
import {
  EXTRACTED_TEXT_CONTEXT_SHARE,
  EXTRACTED_TEXT_MAX_TOKENS,
  MAX_FILES,
  MAX_IMAGE_BYTES,
  NATIVE_PDF_MAX_BYTES,
  NATIVE_PDF_MAX_PAGES,
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

type Resolved =
  | { kind: 'part'; part: Part; extractedTokens: number }
  | { kind: 'error'; message: string };

// Fluid Compute reuses instances, so a follow-up turn in the same conversation
// usually skips re-downloading and re-parsing the same book. Bounded by total
// characters held (data URLs and extracted text), least-recently-used evicted
// first.
const RESOLVED_CACHE_MAX_CHARS = 64 * 1024 * 1024;
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

function inlineFilePart(name: string, mediaType: string, bytes: Buffer): Resolved {
  return {
    kind: 'part',
    part: {
      type: 'file',
      mediaType,
      filename: name,
      url: `data:${mediaType};base64,${bytes.toString('base64')}`,
    },
    extractedTokens: 0,
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
      return inlineFilePart(name, 'application/pdf', bytes);
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
      extractedTokens: estimateTokens(body),
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function resolveBlobPart(part: FilePart): Promise<Resolved> {
  const cached = cacheGet(part.url);
  if (cached) return cached;

  const name = part.filename ?? 'uploaded file';
  const result = await get(part.url, { access: 'private' });
  if (!result || result.statusCode !== 200) {
    // Expired (UPLOAD_RETENTION_DAYS) or deleted. Don't fail the whole turn —
    // an old message in a long-open tab shouldn't block a new question.
    return {
      kind: 'part',
      part: {
        type: 'text',
        text: `[Attachment "${name}" is no longer available; it was shared earlier in this conversation.]`,
      },
      extractedTokens: 0,
    };
  }
  const mediaType = part.mediaType || result.blob.contentType;

  // Checked from blob metadata so an oversize image is never downloaded.
  if (mediaType.startsWith('image/') && result.blob.size > MAX_IMAGE_BYTES) {
    await result.stream.cancel();
    return {
      kind: 'error',
      message: `Image "${name}" is ${formatBytes(result.blob.size)}. Maximum ${formatBytes(MAX_IMAGE_BYTES)} per image.`,
    };
  }

  const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
  const resolved = await resolveBytes(name, mediaType, bytes);
  if (resolved.kind === 'part') cacheSet(part.url, resolved);
  return resolved;
}

async function resolveBytes(name: string, mediaType: string, bytes: Buffer): Promise<Resolved> {
  if (isTextMediaType(mediaType)) {
    const text = bytes.toString('utf8');
    return {
      kind: 'part',
      part: uploadedFileText(name, mediaType, text),
      extractedTokens: estimateTokens(text),
    };
  }
  if (mediaType === 'application/pdf') return resolvePdf(name, bytes);
  if (mediaType.startsWith('image/')) return inlineFilePart(name, mediaType, bytes);
  return { kind: 'error', message: `"${name}" has an unsupported file type (${mediaType}).` };
}

function resolveDataUrlPart(part: FilePart): Part {
  if (!isTextMediaType(part.mediaType)) return part;
  const text = decodeDataUrl(part.url);
  if (text === null) return part;
  return uploadedFileText(part.filename ?? 'uploaded file', part.mediaType, text);
}

async function resolvePart(part: Part): Promise<Resolved> {
  if (part.type === 'file' && isUploadBlobUrl(part.url)) return resolveBlobPart(part);
  if (part.type === 'file' && part.url.startsWith('data:')) {
    return { kind: 'part', part: resolveDataUrlPart(part), extractedTokens: 0 };
  }
  return { kind: 'part', part, extractedTokens: 0 };
}

export type ResolveUploadsResult =
  | { ok: true; messages: UIMessage[] }
  | { ok: false; error: string };

/**
 * Validate the latest message's attachments, then turn every file part in user
 * messages into something the model can read. Fails (for a 413) when a file
 * can't be used or when extracted document text across the conversation would
 * crowd out the rest of the context window — never silently truncates a
 * document.
 */
export async function resolveUploads(
  messages: UIMessage[],
  opts: { modelId: string },
): Promise<ResolveUploadsResult> {
  const invalid = validateLatestUploads(messages);
  if (invalid) return { ok: false, error: invalid };

  // Every attachment in the conversation resolves concurrently; downloads and
  // PDF parses would otherwise add up in time-to-first-token.
  const resolved = await Promise.all(
    messages.map((m) =>
      m.role === 'user' && Array.isArray(m.parts) ? Promise.all(m.parts.map(resolvePart)) : null,
    ),
  );

  let extractedTokens = 0;
  const out: UIMessage[] = [];
  for (const [i, m] of messages.entries()) {
    const parts = resolved[i];
    if (!parts) {
      out.push(m);
      continue;
    }
    const newParts: Part[] = [];
    for (const r of parts) {
      if (r.kind === 'error') return { ok: false, error: r.message };
      extractedTokens += r.extractedTokens;
      newParts.push(r.part);
    }
    out.push({ ...m, parts: newParts });
  }

  const budget = Math.min(
    EXTRACTED_TEXT_MAX_TOKENS,
    Math.floor(getContextWindow(opts.modelId) * EXTRACTED_TEXT_CONTEXT_SHARE),
  );
  if (extractedTokens > budget) {
    return {
      ok: false,
      error:
        `The attached documents come to about ${Math.round(extractedTokens / 1000)}k tokens of text, ` +
        `more than can be sent alongside the rest of the conversation (about ${Math.round(budget / 1000)}k). ` +
        `Attach only the chapters you need — for example, export a page range from Preview — or start a new chat.`,
    };
  }

  return { ok: true, messages: out };
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
