// Locate a model-emitted quote inside a transcript turn.
//
// Citations of the form [id:N "verbatim text"] / [turn:N "verbatim text"] carry
// a short substring the model copied from the cited turn/chunk so the UI can
// pinpoint the exact passage. The match has to be tolerant: even when the
// model copies "verbatim", whitespace gets normalized (newlines collapsed),
// smart quotes get straightened (or vice versa), and an ellipsis may be
// inserted to elide a phrase.

export type Span = readonly [start: number, end: number];

const ELLIPSIS_RE = /\s*(?:\.{3}|…)\s*/;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_META, '\\$&');
}

// Build a regex that matches `segment` in transcript text, tolerant of
// whitespace differences and curly/straight quote substitution.
function buildSegmentRegex(segment: string): RegExp | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).map(escapeRegex);
  const pattern = tokens
    .join('\\s+')
    // ‘ ' ’ ' (single curly), “ " ” " (double curly).
    // After escapeRegex, plain quotes appear as `'` or `"`; broaden each into
    // a class so transcript-side typography differences don't break matching.
    .replace(/'/g, "[\\u2018\\u2019']")
    .replace(/"/g, '["\\u201C\\u201D]');
  return new RegExp(pattern, 'i');
}

// Returns spans in `text` corresponding to the segments of `quote`. A quote
// can contain "..." or "…" to skip material; each segment is matched in order
// after the previous segment's end. Returns `null` if any segment fails to
// match — in that case the caller should fall back to whole-turn highlighting
// rather than partial highlighting that misrepresents the citation.
export function findQuoteSpans(text: string, quote: string): Span[] | null {
  const trimmed = quote.trim();
  if (!trimmed || !text) return null;

  const segments = trimmed
    .split(ELLIPSIS_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const spans: Span[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const re = buildSegmentRegex(seg);
    if (!re) return null;
    const slice = text.slice(cursor);
    const m = re.exec(slice);
    if (!m || m.index === undefined) return null;
    const start = cursor + m.index;
    const end = start + m[0].length;
    spans.push([start, end]);
    cursor = end;
  }
  return spans;
}
