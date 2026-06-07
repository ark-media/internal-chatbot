import mammoth from 'mammoth';
import TurndownService from 'turndown';

// Supported upload types. .docx must be converted via HTML (not raw text) so
// hyperlinks survive — the dossier's sources ARE the links.
export type DocKind = 'docx' | 'markdown';

export class UnsupportedDocError extends Error {
  constructor(public readonly filename: string) {
    super(`Unsupported file type: ${filename}. Upload a .docx, .md, or .txt file.`);
    this.name = 'UnsupportedDocError';
  }
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function classify(filename: string, mime: string): DocKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx') || mime === DOCX_MIME) return 'docx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
    return 'markdown';
  }
  // text/* and empty mime fall back to markdown (treat as plain text).
  if (mime.startsWith('text/') || mime === '') return 'markdown';
  throw new UnsupportedDocError(filename);
}

// Convert an uploaded file to markdown the extraction agent can read. .docx is
// converted to HTML (preserving <a href>) then to markdown so inline source
// links become `[Outlet](url)`. .md/.txt pass through as UTF-8.
export async function parseDocumentToMarkdown(
  buffer: Buffer,
  filename: string,
  mime: string,
): Promise<string> {
  const kind = classify(filename, mime);
  if (kind === 'markdown') {
    return buffer.toString('utf-8');
  }
  // docx → HTML → markdown
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  return turndown.turndown(html);
}
