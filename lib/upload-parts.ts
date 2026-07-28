// Upload handling shared by the prep and news chat routes.
//
// Claude reads PDFs and images natively via file parts. For text-ish uploads
// (.md, .txt, .csv) we decode the data URL to UTF-8 and replace the file part
// with a text part so the content actually reaches the model.

import type { UIMessage } from 'ai';

import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  TEXT_MEDIA_TYPES,
  formatBytes,
} from './prep-limits';

function estimateDataUrlBytes(url: string): number {
  // data:<media-type>;base64,<payload>  or  data:<media-type>,<url-encoded>
  const comma = url.indexOf(',');
  if (comma < 0) return url.length;
  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  if (header.endsWith(';base64')) {
    // base64 encodes 3 bytes per 4 chars; subtract padding
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.floor((payload.length * 3) / 4) - padding;
  }
  return payload.length;
}

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

// Inspects the latest user message only — historical turns were already
// validated on their own request. Returns null on success, an error message on
// violation.
export function validateUploads(messages: UIMessage[]): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser?.parts) return null;
  const fileParts = lastUser.parts.filter((p) => p.type === 'file');
  if (fileParts.length === 0) return null;
  if (fileParts.length > MAX_FILES) {
    return `Too many files (${fileParts.length}). Maximum ${MAX_FILES} per message.`;
  }
  let total = 0;
  for (const p of fileParts) {
    const size = estimateDataUrlBytes(p.url);
    if (size > MAX_FILE_BYTES) {
      return `File "${p.filename ?? 'uploaded file'}" is ${formatBytes(size)}. Maximum ${formatBytes(MAX_FILE_BYTES)} per file.`;
    }
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) {
    return `Uploaded files total ${formatBytes(total)}. Maximum ${formatBytes(MAX_TOTAL_BYTES)} per message.`;
  }
  return null;
}

export function normalizeMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.parts)) return m;
    const newParts: UIMessage['parts'] = [];
    for (const part of m.parts) {
      if (part.type !== 'file') {
        newParts.push(part);
        continue;
      }
      if (!TEXT_MEDIA_TYPES.has(part.mediaType)) {
        newParts.push(part);
        continue;
      }
      const text = decodeDataUrl(part.url);
      if (text === null) {
        newParts.push(part);
        continue;
      }
      const label = (part.filename ?? 'uploaded file').replace(/"/g, '&quot;');
      newParts.push({
        type: 'text',
        text: `<uploaded_file name="${label}" media_type="${part.mediaType}">\n${text}\n</uploaded_file>`,
      });
    }
    return { ...m, parts: newParts };
  });
}
