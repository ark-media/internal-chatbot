// Parsing helpers for finalized Ark News Daily scripts. Shared by the chat
// route (which extracts the SOURCES list off a freshly written script) and the
// breaking-news scan (which needs both the cited sources and the block
// structure to diff post-lock candidates against what the script covers).

// `url` is optional: the prompt's own SOURCES template permits a URL-less
// entry ("[URL if available]"), and writers' finalized scripts routinely cite
// an outlet and headline with no link. Such a source is still a real source —
// dropping it silently emptied the list, which made the reflect reviewer treat
// every superscript as an unverified citation (a hard failure) and pinned the
// loop at max iterations.
export type ExtractedSources = Array<{
  num: number;
  title: string;
  url?: string;
  date?: string;
  flags?: string;
}>;

// One story block of a finalized script, keyed by its structural label
// (A/B/C/D). The `text` is the block body with the block marker and the
// recurring sign-off boilerplate stripped.
export type ScriptBlock = { label: string; text: string };

// The machine-readable "coverage profile" the breaking-news scan diffs
// candidates against: the ordered story blocks plus the sources the script
// already cites.
export type ScriptCoverage = { blocks: ScriptBlock[]; sources: ExtractedSources };

// Matches an `[A BLOCK]` / `[C block]` / bare `A BLOCK` structural marker at the
// start of a line and captures the label letter. The tool's own drafts bracket
// the markers, but writers also paste externally-authored finalized scripts that
// use bare headers, so the brackets are optional. Anchored to a line start (after
// optional markdown/quote prefixes) and requiring a word boundary after BLOCK so
// prose like "on the blocks today" or "a blockade" never matches.
const BLOCK_MARKER = /(?:^|\n)[ \t>*#]*\[?[ \t]*([A-Za-z])[ \t]+BLOCK\b[ \t]*\]?/gi;

// Strip the recurring sign-off boilerplate ("I'm Deborah Pardes, and this is
// Ark News Daily.") and any trailing divider from the tail of a block so the
// outro isn't mistaken for story content. Only the final block carries the
// sign-off, but applying this everywhere is a harmless no-op elsewhere.
function trimOutro(text: string): string {
  return text
    .replace(/\n[\s>*#]*[-*_]{3,}\s*$/, '')
    .replace(/\n+\s*I'?m Deborah Pardes,?\s+and this is Ark News Daily\.?\s*$/i, '')
    .replace(/\s+$/, '');
}

// Split a finalized script into its A/B/C/D story blocks and the sources it
// cites. Everything before the first `[X BLOCK]` marker (SONIC ID + HOST
// intro) and the trailing sign-off are boilerplate and are not returned as
// blocks. A script with no SOURCES section still parses its blocks and returns
// `sources: []`, matching the tolerant behavior of extractSources.
export function parseScriptCoverage(text: string): ScriptCoverage {
  const { script, sources } = extractSources(text);

  const blocks: ScriptBlock[] = [];
  const matches = [...script.matchAll(BLOCK_MARKER)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const label = m[1].toUpperCase();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? script.length) : script.length;
    const body = trimOutro(script.slice(start, end)).replace(/^\s+/, '');
    blocks.push({ label, text: body });
  }

  return { blocks, sources };
}

export function extractSources(text: string): { script: string; sources: ExtractedSources } {
  // Find the SOURCES heading at the start of a line. Tolerate:
  //   - any divider before it (---, ***, ___, or none),
  //   - heading variants (SOURCES, Sources, "Sources:", "## Sources"),
  //   - smart quotes / extra punctuation around the colon.
  // A strict prior regex required `\n---\nSOURCES:\n` exactly and silently
  // returned zero sources whenever the model drifted, persisting scripts
  // with empty source lists.
  const headingMatch = text.match(/(^|\n)[#\s>*]*sources\b[\s:．·.\-—]*\n/i);
  if (!headingMatch || headingMatch.index === undefined) {
    console.warn(
      JSON.stringify({
        event: 'news.extract_sources_format_not_found',
        textLength: text.length,
      })
    );
    return { script: text, sources: [] };
  }

  // Trim any trailing divider (---, ***, ___) or whitespace from the
  // script body so it doesn't end with the separator.
  const scriptEnd = headingMatch.index + (headingMatch[1] === '\n' ? 1 : 0);
  const script = text
    .slice(0, scriptEnd)
    .replace(/\n[\s>*#]*[-*_]{3,}\s*$/, '')
    .replace(/\s+$/, '');
  const sourcesText = text.slice(headingMatch.index + headingMatch[0].length);
  const sources: ExtractedSources = [];

  // Parse lines like: "1. Title — URL — Date [FLAG: note]"
  // Handles em-dashes in titles by identifying URLs and dates via pattern matching.
  // Examples that now parse correctly:
  // - "1. Reuters — Analysis — https://example.com — May 2026" (em-dash in title)
  // - "2. BBC Report — https://bbc.com/news" (missing date)
  // - "3. NYT: The Story — Full Text — https://nytimes.com [FLAG: blocked]" (complex title)
  const lines = sourcesText.split('\n').filter((l) => l.trim());
  let parseErrors = 0;
  let parseMethod: 'strict' | 'smart' = 'strict';

  for (const line of lines) {
    // First, try strict parsing: number. Title — URL — optional(Date) optional([FLAG: ...])
    // Require URL to start with http:// or https:// to avoid matching em-dashes in titles.
    const strictMatch = line.match(
      /^(\d+)\.\s+(.+?)\s+—\s+(https?:\/\/[^\s]+)(?:\s+—\s+(.+?))?(?:\s+\[FLAG:\s+(.+?)\])?$/
    );
    if (strictMatch) {
      sources.push({
        num: parseInt(strictMatch[1], 10),
        title: strictMatch[2].trim(),
        url: strictMatch[3].trim(),
        date: strictMatch[4]?.trim(),
        flags: strictMatch[5]?.trim(),
      });
      continue;
    }

    // Fallback: smart parsing that identifies URLs and dates by pattern.
    // This handles em-dashes in titles by recognizing field types.
    const numMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      const rest = numMatch[2];
      parseMethod = 'smart';

      // Extract flag if present (always at the end: [FLAG: ...])
      const flagMatch = rest.match(/\[FLAG:\s+(.+?)\]$/);
      const flagText = flagMatch?.[1]?.trim();
      const withoutFlag = flagMatch ? rest.slice(0, flagMatch.index).trim() : rest;

      // Find URL: look for http:// or https:// followed by non-whitespace.
      // A line with no URL is still a valid source (outlet + headline, no
      // link) — keep it, with the whole remainder as the title.
      const urlMatch = withoutFlag.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) {
        sources.push({ num, title: withoutFlag.trim(), flags: flagText });
        continue;
      }

      const url = urlMatch[0];
      const urlStartIndex = withoutFlag.indexOf(url);
      const titlePart = withoutFlag.slice(0, urlStartIndex).trim();
      const datePart = withoutFlag.slice(urlStartIndex + url.length).trim();

      // Clean up title: remove trailing em-dash if present
      const cleanTitle = titlePart.replace(/\s+—\s*$/, '').trim();

      // Clean up date: remove leading em-dash if present
      const cleanDate = datePart.replace(/^\s*—\s+/, '').trim() || undefined;

      sources.push({
        num,
        title: cleanTitle,
        url,
        date: cleanDate,
        flags: flagText,
      });
    } else {
      parseErrors++;
    }
  }

  if (parseErrors > 0) {
    console.warn(
      JSON.stringify({
        event: 'news.extract_sources_parse_errors',
        totalLines: lines.length,
        parseErrors,
        successfulParses: sources.length,
        parseMethod,
      })
    );
  }

  return { script, sources };
}
