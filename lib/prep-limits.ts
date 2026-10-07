export const MAX_FILES = 6;
// Attachments upload straight from the browser to Vercel Blob, so these are no
// longer bound by Vercel's 4.5 MB function body limit — the chat request only
// carries the blob URL.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // aggregate guard across all files in one message
// Anthropic rejects images over 5 MB, and images are always sent inline.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Files above this upload in parallel chunks.
export const MULTIPART_UPLOAD_BYTES = 8 * 1024 * 1024;

// A PDF goes to the model natively (text + page images) only when it is small
// enough to fit comfortably: 100 pages is the per-document cap for 200k-context
// models, and native pages cost ~1.5–3k tokens each. Anything bigger — a book —
// is sent as extracted text instead.
export const NATIVE_PDF_MAX_PAGES = 100;
export const NATIVE_PDF_MAX_BYTES = 10 * 1024 * 1024;

// Per-request caps on what goes to the model inline, across every turn that is
// re-sent: Anthropic allows 100 native PDF pages per request and ~32 MB per
// request body (base64 adds a third, so 20 MB raw leaves headroom).
export const MAX_REQUEST_PDF_PAGES = 100;
export const MAX_REQUEST_INLINE_BYTES = 20 * 1024 * 1024;

// Share of the selected model's context window that extracted document text may
// take in one request, leaving room for the system prompt, dossiers, history
// and output.
export const EXTRACTED_TEXT_CONTEXT_SHARE = 0.6;
// Absolute cap regardless of window: extracted text is re-sent on every turn,
// so on a 1M-context model this bounds per-turn input cost (~a long book).
export const EXTRACTED_TEXT_MAX_TOKENS = 300_000;

export const UPLOAD_PATH_PREFIX = 'uploads/';
// Uploaded blobs outlive the message that sent them only for follow-up turns in
// the same tab; saved chats keep the filename, not the bytes.
export const UPLOAD_RETENTION_DAYS = 7;

export const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/yaml',
  'application/x-yaml',
]);

// Text uploads are decoded and sent as text. `text/*` counts as well as the
// exact list because the browser and Blob infer slightly different types for
// .md/.yml.
export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType);
}

// The only image formats Anthropic accepts.
export const SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Enforced by the Blob client token.
export const ALLOWED_UPLOAD_MEDIA_TYPES: readonly string[] = [
  'application/pdf',
  ...SUPPORTED_IMAGE_TYPES,
  'text/*',
  ...[...TEXT_MEDIA_TYPES].filter((t) => !t.startsWith('text/')),
];

// The composer's file-picker filter.
export const UPLOAD_ACCEPT = [
  '.pdf,.md,.txt,.csv,.tsv,.json,.yml,.yaml,.png,.jpg,.jpeg,.gif,.webp',
  'application/pdf,text/markdown,text/plain,text/csv,application/json',
  ...SUPPORTED_IMAGE_TYPES,
].join(',');

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
