export const MAX_FILES = 6;
// Attachments upload straight from the browser to Vercel Blob, so these are no
// longer bound by Vercel's 4.5 MB function body limit — the chat request only
// carries the blob URL.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // aggregate guard across all files in one message
// Anthropic rejects images over 5 MB, and images are always sent inline.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A PDF goes to the model natively (text + page images) only when it is small
// enough to fit comfortably: 100 pages is the per-document cap for 200k-context
// models, and native pages cost ~1.5–3k tokens each. Anything bigger — a book —
// is sent as extracted text instead.
export const NATIVE_PDF_MAX_PAGES = 100;
export const NATIVE_PDF_MAX_BYTES = 10 * 1024 * 1024;

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

// Enforced by the Blob client token. `text/*` rather than the exact text list
// because the browser and Blob infer slightly different types for .md/.yml.
export const ALLOWED_UPLOAD_MEDIA_TYPES: readonly string[] = [
  'application/pdf',
  'image/*',
  'text/*',
  'application/json',
  'application/yaml',
  'application/x-yaml',
];

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
