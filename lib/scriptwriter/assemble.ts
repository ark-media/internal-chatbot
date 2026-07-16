// Final assembly (full-episode scope only): one Opus pass stitches the
// approved blocks into a complete episode — verbatim blocks, global footnote
// renumbering, SONIC ID + intro, one-line transitions, sign-off, merged
// SOURCES. A deterministic guard verifies the blocks survived verbatim; on
// failure we fall back to a mechanical code-level stitch.

import { streamText } from 'ai';

import type { BlockSlot } from './types';

const ASSEMBLY_MODEL = process.env.BLOCK_WRITER_MODEL ?? 'anthropic/claude-opus-4-8';

export type ApprovedBlock = { slot: BlockSlot; text: string };

// -- Superscript helpers ---------------------------------------------------------

const SUPER_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const SUPER_TO_DIGIT: Record<string, string> = Object.fromEntries(
  SUPER_DIGITS.map((s, i) => [s, String(i)]),
);
const SUPER_RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g;

export function toSuperscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUPER_DIGITS[Number(d)])
    .join('');
}

export function fromSuperscript(s: string): number {
  return Number(
    s
      .split('')
      .map((ch) => SUPER_TO_DIGIT[ch] ?? '')
      .join(''),
  );
}

// -- Block parsing ----------------------------------------------------------------

export type ParsedBlock = {
  body: string; // the block including its [X BLOCK] marker, without the SOURCES section
  sources: Array<{ localNumber: number; entry: string }>;
};

// Split a single-block draft into its body and its numbered SOURCES entries.
export function parseBlock(text: string): ParsedBlock {
  const parts = text.split(/\n-{3,}\s*\n\s*SOURCES:\s*\n/);
  const body = (parts[0] ?? text).trimEnd();
  const sources: ParsedBlock['sources'] = [];
  if (parts[1]) {
    for (const line of parts[1].split('\n')) {
      const m = /^\s*(\d+)\.\s+(.+)$/.exec(line);
      if (m) sources.push({ localNumber: Number(m[1]), entry: m[2].trim() });
    }
  }
  return { body, sources };
}

// -- Mechanical stitch (fallback + renumber core) -----------------------------------

export type StitchResult = {
  fullText: string;
  sourceCount: number;
};

// Renumber each block's superscripts into one global sequence (assigned by
// order of first appearance) and merge the per-block SOURCES lists. Pure and
// deterministic — this is both the fallback stitch's core and what the
// verbatim guard normalizes against.
export function renumberBlocks(blocks: ApprovedBlock[]): {
  bodies: string[];
  sourceEntries: string[];
} {
  let nextGlobal = 1;
  const bodies: string[] = [];
  const sourceEntries: string[] = [];

  for (const block of blocks) {
    const parsed = parseBlock(block.text);
    const localToGlobal = new Map<number, number>();
    const body = parsed.body.replace(SUPER_RUN, (run) => {
      const local = fromSuperscript(run);
      if (!localToGlobal.has(local)) localToGlobal.set(local, nextGlobal++);
      return toSuperscript(localToGlobal.get(local)!);
    });
    bodies.push(body);
    // Sources cited in the body take their mapped number; uncited leftovers
    // (defensive) get fresh numbers so nothing is silently dropped.
    const ordered = [...parsed.sources].sort((a, b) => {
      const ga = localToGlobal.get(a.localNumber);
      const gb = localToGlobal.get(b.localNumber);
      return (ga ?? Number.MAX_SAFE_INTEGER) - (gb ?? Number.MAX_SAFE_INTEGER);
    });
    for (const s of ordered) {
      let g = localToGlobal.get(s.localNumber);
      if (g === undefined) {
        g = nextGlobal++;
        localToGlobal.set(s.localNumber, g);
      }
      sourceEntries[g - 1] = s.entry;
    }
  }

  return { bodies, sourceEntries: sourceEntries.filter(Boolean) };
}

function dateParts(today: string, timezone: string): { weekday: string; longDate: string } {
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  void timezone; // `today` is already writer-local; noon UTC keeps the calendar date stable
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const longDate = date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return { weekday, longDate };
}

export function episodeHeader(today: string, timezone: string): string {
  const { weekday, longDate } = dateParts(today, timezone);
  return `SONIC ID: You are listening to an Ark Media Podcast.

HOST: It's ${weekday}, ${longDate}.
This news update was recorded at [time] New York time on ${weekday}.
I'm Deborah Pardes and this is Ark News Daily.`;
}

const SIGN_OFF = `I'm Deborah Pardes, and this is Ark News Daily.`;

// The no-model fallback: template intro/outro, mechanical footnote renumber,
// no bespoke transitions. Correct but plain — used when the Opus assembly
// fails the verbatim guard or errors.
export function fallbackStitch(
  blocks: ApprovedBlock[],
  today: string,
  timezone: string,
): StitchResult {
  const { bodies, sourceEntries } = renumberBlocks(blocks);
  const fullText = [
    episodeHeader(today, timezone),
    '',
    bodies.join('\n\n'),
    '',
    SIGN_OFF,
    '',
    '---',
    '',
    'SOURCES:',
    '',
    sourceEntries.map((e, i) => `${i + 1}. ${e}`).join('\n'),
    '',
    '---',
  ].join('\n');
  return { fullText, sourceCount: sourceEntries.length };
}

// -- Verbatim guard ------------------------------------------------------------------

// Token-recall check: after stripping superscripts, markers, and whitespace,
// at least `threshold` of each approved block's tokens must appear in the
// assembled episode's corresponding section. Transitions ADD tokens (harmless
// to recall); rewriting or dropping approved prose lowers it.
const VERBATIM_THRESHOLD = 0.95;

// Recall alone can't catch ADDED prose — injected commentary or a fabricated
// sentence still scores full recall. Bound the net token growth per section so
// only a legitimate one-line transition (plus a little slack) survives; a
// section that balloons past this falls back to the mechanical stitch.
const MAX_ADDED_TOKENS_PER_SECTION = 60;

function tokensOf(text: string): string[] {
  return text
    .replace(SUPER_RUN, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function multisetRecall(needle: string[], haystack: string[]): number {
  if (needle.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const t of haystack) counts.set(t, (counts.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of needle) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      hit++;
      counts.set(t, c - 1);
    }
  }
  return hit / needle.length;
}

// Extract the section of the assembled episode belonging to each block marker.
export function sectionForSlot(assembled: string, slot: BlockSlot): string | null {
  const markers = ['[A BLOCK]', '[B BLOCK]', '[C BLOCK]', '[D BLOCK]'];
  const marker = `[${slot} BLOCK]`;
  const start = assembled.indexOf(marker);
  if (start === -1) return null;
  let end = assembled.length;
  for (const m of markers) {
    if (m === marker) continue;
    const idx = assembled.indexOf(m, start + marker.length);
    if (idx > start && idx < end) end = idx;
  }
  const sourcesIdx = assembled.indexOf('SOURCES:', start);
  if (sourcesIdx > start && sourcesIdx < end) end = sourcesIdx;
  return assembled.slice(start, end);
}

export function verifyBlocksVerbatim(
  assembled: string,
  blocks: ApprovedBlock[],
  threshold = VERBATIM_THRESHOLD,
  maxAdded = MAX_ADDED_TOKENS_PER_SECTION,
): { ok: boolean; recalls: Array<{ slot: BlockSlot; recall: number; added: number }> } {
  const recalls = blocks.map((b) => {
    const section = sectionForSlot(assembled, b.slot);
    const approvedTokens = tokensOf(parseBlock(b.text).body);
    if (!section) return { slot: b.slot, recall: 0, added: 0 };
    const sectionTokens = tokensOf(section);
    const recall = multisetRecall(approvedTokens, sectionTokens);
    const added = sectionTokens.length - approvedTokens.length;
    return { slot: b.slot, recall, added };
  });
  const ok = recalls.every((r) => r.recall >= threshold && r.added <= maxAdded);
  return { ok, recalls };
}

// -- Opus assembly pass -----------------------------------------------------------------

const ASSEMBLY_SYSTEM = `You assemble the final episode of *Ark News Daily* from blocks the writer has already approved. This is a mechanical-plus-transitions job, NOT a rewrite:

- Reproduce each approved block's text WORD FOR WORD. The only permitted in-block change is renumbering superscript footnotes into one global sequence across the episode.
- Add exactly: the SONIC ID and HOST intro (template supplied), a one-line spoken transition between consecutive blocks (smooth and logical, in the host's voice — never "And then"), the sign-off, and one merged, renumbered SOURCES list at the end.
- Transitions are single sentences that bridge the stories on substance. Do not add commentary, do not summarize blocks, do not editorialize.
- Remove each block's own trailing SOURCES section (its entries move to the merged list; keep entry text verbatim).

Any rephrasing, trimming, or "improving" of approved block prose is a failure.`;

// Decide whether the model's assembled text is trustworthy or we fall back to
// the mechanical stitch. Pure and side-effect-free (logging aside) so the
// accept/fallback decision is unit-testable without invoking the model.
export function finalizeAssembly(
  assembled: string,
  ordered: ApprovedBlock[],
  today: string,
  timezone: string,
): { fullText: string; usedFallback: boolean } {
  const check = verifyBlocksVerbatim(assembled, ordered);
  if (check.ok) return { fullText: assembled, usedFallback: false };
  console.warn(
    JSON.stringify({
      event: 'scriptwriter.assembly_verbatim_failed',
      recalls: check.recalls.map((r) => ({
        slot: r.slot,
        recall: Number(r.recall.toFixed(3)),
        added: r.added,
      })),
    }),
  );
  return { fullText: fallbackStitch(ordered, today, timezone).fullText, usedFallback: true };
}

export async function assembleEpisode(opts: {
  blocks: ApprovedBlock[];
  today: string;
  timezone: string;
  model?: string;
  onDelta?: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<{ fullText: string; usedFallback: boolean }> {
  const { blocks, today, timezone, onDelta, signal } = opts;
  const model = opts.model ?? ASSEMBLY_MODEL;
  const ordered = [...blocks].sort((a, b) => a.slot.localeCompare(b.slot));

  const prompt = `Episode header template (use verbatim, keeping the [time] placeholder):

${episodeHeader(today, timezone)}

Sign-off (use verbatim): ${SIGN_OFF}

Approved blocks:

${ordered.map((b) => b.text).join('\n\n=== NEXT APPROVED BLOCK ===\n\n')}

Assemble the full episode now: header, blocks word-for-word (with globally renumbered superscripts and one-line transitions between them), sign-off, then "---", "SOURCES:", and the merged numbered list, then "---".`;

  let assembled = '';
  try {
    const result = streamText({
      model,
      system: ASSEMBLY_SYSTEM,
      prompt,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' } } },
      abortSignal: signal,
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        assembled += part.text;
        onDelta?.(assembled);
      }
    }
    assembled = assembled.trim();
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(
      JSON.stringify({ event: 'scriptwriter.assembly_error', err: String(err).slice(0, 200) }),
    );
    const stitched = fallbackStitch(ordered, today, timezone);
    onDelta?.(stitched.fullText);
    return { fullText: stitched.fullText, usedFallback: true };
  }

  const decided = finalizeAssembly(assembled, ordered, today, timezone);
  if (decided.usedFallback) onDelta?.(decided.fullText);
  return decided;
}

// Post-completion episode revision: edit-in-place against the writer's
// instruction, preserving everything the instruction doesn't touch.
export async function reviseEpisodeText(opts: {
  currentEpisode: string;
  instruction: string;
  cachedSystemContent: string; // full-episode writer system (bible + examples + date)
  onDelta?: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<{ fullText: string }> {
  const { currentEpisode, instruction, cachedSystemContent, onDelta, signal } = opts;
  const result = streamText({
    model: ASSEMBLY_MODEL,
    system: {
      role: 'system',
      content: cachedSystemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt: `== Current script ==

${currentEpisode}

== Writer's request ==

${instruction}

Apply the writer's request to the current script and return the full revised script. Preserve every factual claim, citation, and FLAG that the request doesn't explicitly touch. Do not start from scratch — edit in place. Begin your response with "SONIC ID:" — no preamble.`,
    providerOptions: { anthropic: { thinking: { type: 'adaptive' } } },
    abortSignal: signal,
  });
  let text = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text;
      onDelta?.(text);
    }
  }
  return { fullText: text.trim() };
}
