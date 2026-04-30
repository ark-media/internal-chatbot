// Pure citation parsing — no React dependency so it can be tested without
// a DOM environment. MessageText imports this and maps the tokens to chips.

export type CitationToken =
  | { type: 'text'; text: string }
  | { type: 'cite'; kind: 'id' | 'turn'; id: number; quote?: string };

// Match any bracket that contains at least one id:N or turn:N reference,
// optionally followed by a quoted verbatim substring.
// Examples handled:
//   [id:1]                          → 1 cite token
//   [id:1,2,3]                      → 3 cite tokens
//   [turn:4, 5]                     → 2 cite tokens
//   [turn:8368, id:2985]            → 2 cite tokens
//   [id:1 "verbatim quote text"]    → 1 cite token carrying the quote
//   [turn:4 "another quote"]        → 1 cite token carrying the quote
// Quote only attaches when exactly one id is cited — for multi-id brackets
// it's ambiguous which evidence the model meant to pinpoint, so it's dropped.
const BRACKET_RE = /\[[^\]]*(?:id|turn):\s*\d+[^\]]*\]/g;
const QUOTE_TAIL_RE = /\s+"([^"]+)"\s*$/;
const INNER_RE = /(id|turn):\s*(\d+(?:\s*,\s*\d+)*)/g;

export function parseCitations(text: string): CitationToken[] {
  const tokens: CitationToken[] = [];
  let lastIndex = 0;
  let bracket: RegExpExecArray | null;
  BRACKET_RE.lastIndex = 0;

  while ((bracket = BRACKET_RE.exec(text)) !== null) {
    if (bracket.index > lastIndex) {
      tokens.push({ type: 'text', text: text.slice(lastIndex, bracket.index) });
    }

    let inner = bracket[0];
    let quote: string | undefined;
    // Strip the optional trailing `"verbatim"` before parsing references so
    // INNER_RE doesn't see digits inside the quote (defensive — quote text
    // shouldn't contain id:N patterns in practice).
    const tail = QUOTE_TAIL_RE.exec(inner.slice(0, -1));
    if (tail) {
      quote = tail[1];
      inner = inner.slice(0, tail.index) + ']';
    }

    const refs: Array<{ kind: 'id' | 'turn'; id: number }> = [];
    INNER_RE.lastIndex = 0;
    let ref: RegExpExecArray | null;
    while ((ref = INNER_RE.exec(inner)) !== null) {
      const [, kind, idsStr] = ref;
      const ids = idsStr
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      for (const id of ids) refs.push({ kind: kind as 'id' | 'turn', id });
    }

    const attachQuote = refs.length === 1 ? quote : undefined;
    for (const { kind, id } of refs) {
      tokens.push({ type: 'cite', kind, id, quote: attachQuote });
    }

    lastIndex = bracket.index + bracket[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return tokens;
}
