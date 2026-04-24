export const MAX_FILES = 6;
export const MAX_FILE_BYTES = 3 * 1024 * 1024; // 3 MiB raw → ~4 MiB base64, fits Vercel's 4.5 MB body limit
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024; // aggregate guard across all files in one request

export const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/yaml',
  'application/x-yaml',
]);

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
