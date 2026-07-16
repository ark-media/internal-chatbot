// Stage 3: block writing. Opus 4.8 drafts one block at a time against the
// confirmed substance contract, streaming deltas to the client. Each fresh
// draft gets ONE review pass (the writer is the gate, so no reflect loop):
// hard failures trigger a single silent correction pass; soft problems become
// editor notes for the writer to act on in chat.

import { streamText } from 'ai';

import { reviewScript } from '../orchestrator/reflect';
import { computeMetadata } from '../orchestrator/script-craft';
import type { ReviewCorrection } from '../orchestrator/types';
import { buildBlockPrompt } from './prompts';
import type { BlockSlot, StorySource } from './types';

// Opus 4.8: sampling parameters are removed (a 400 if sent), so there is no
// temperature here — lexical variety is steered by the voice sections of the
// prompt. Thinking is OFF unless adaptive is requested explicitly; a short
// burst of adaptive thinking measurably helps structure on writing tasks.
const BLOCK_WRITER_MODEL = process.env.BLOCK_WRITER_MODEL ?? 'anthropic/claude-opus-4-8';
const OPUS_PROVIDER_OPTIONS = {
  anthropic: {
    thinking: { type: 'adaptive' as const },
  },
};

export async function draftBlock(opts: {
  slot: BlockSlot;
  cachedSystemContent: string;
  contract: string;
  previousBlockTail?: string;
  previousDraft?: string;
  instruction?: string;
  corrections?: ReviewCorrection[];
  onDelta?: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<{ text: string }> {
  const { slot, cachedSystemContent, contract, previousBlockTail, previousDraft, instruction, onDelta, signal } = opts;

  const correctionsBlock =
    opts.corrections && opts.corrections.length > 0
      ? opts.corrections
          .map((c, i) => `${i + 1}. ${c.blockOrSection} — addresses: ${c.problem}\n   Fix: ${c.suggestedFix}`)
          .join('\n\n')
      : undefined;

  const prompt = buildBlockPrompt({
    slot,
    contract,
    previousBlockTail,
    previousDraft,
    instruction,
    corrections: correctionsBlock,
  });

  const result = streamText({
    model: BLOCK_WRITER_MODEL,
    system: {
      role: 'system',
      content: cachedSystemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    providerOptions: OPUS_PROVIDER_OPTIONS,
    abortSignal: signal,
  });

  let text = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text;
      onDelta?.(text);
    }
  }
  return { text: text.trim() };
}

// The last few lines of an approved block, handed to the next block's writer
// for transition awareness. Cuts at line boundaries so a SOURCES section or a
// trailing footnote list is skipped. Exported for tests.
export function blockTail(blockText: string, maxChars = 400): string {
  const body = blockText.split(/\n-{3,}\s*\nSOURCES:/)[0] ?? blockText;
  const trimmed = body.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(-maxChars);
  const firstBreak = cut.indexOf('\n');
  return firstBreak >= 0 ? cut.slice(firstBreak + 1) : cut;
}

export type BlockReview = {
  finalText: string;
  hardFixApplied: boolean;
  editorNotes: string[];
};

// Format the block's sources into the "APPROVED SOURCES" list the reviewer
// checks superscripts against.
export function buildReviewSourceList(sources: StorySource[]): string {
  return sources
    .map(
      (s) =>
        `- ${s.source} — ${s.title} (${s.publicationDate ?? 'unknown'})${s.isFlagged ? ' [FLAG: outside window]' : ''}: ${s.url}`,
    )
    .join('\n');
}

// One review pass over a fresh draft. Hard failures (factual, source
// fidelity) → one silent Opus correction pass; soft problems → surfaced as
// editor notes. Review failure falls back to the unreviewed draft — the
// writer is still the gate.
export async function reviewBlock(opts: {
  slot: BlockSlot;
  draftText: string;
  sources: StorySource[];
  cachedSystemContent: string; // the block writer's system (for the correction pass)
  reviewerSystemContent: string;
  contract: string;
  onDelta?: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<BlockReview> {
  const { slot, draftText, sources, cachedSystemContent, reviewerSystemContent, contract, onDelta, signal } = opts;

  let review;
  try {
    review = await reviewScript({
      script: { fullText: draftText, metadata: computeMetadata(draftText) },
      reviewerSystemContent,
      sourceList: buildReviewSourceList(sources),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(
      JSON.stringify({ event: 'scriptwriter.block_review_error', err: String(err).slice(0, 200) }),
    );
    return { finalText: draftText, hardFixApplied: false, editorNotes: [] };
  }

  const hard = review.problems.filter((p) => p.type === 'hard');
  const softNotes = review.problems
    .filter((p) => p.type === 'soft')
    .map((p) => `${p.issue}: ${p.detail}`);

  if (hard.length === 0) {
    return { finalText: draftText, hardFixApplied: false, editorNotes: softNotes };
  }

  // Hard failures only: apply the reviewer's corrections in one silent pass.
  // Soft corrections are deliberately withheld — auto-applying them is what
  // flattened the voice in the old reflect loop.
  //
  // Match a correction to a hard problem by meaningful text overlap. The length
  // floor stops an empty or near-empty issue/problem string from matching
  // everything (bare `includes('')` is always true).
  const MIN_MATCH_LEN = 8;
  const hardCorrections = review.corrections.filter((c) => {
    const prob = c.problem.toLowerCase().trim();
    if (prob.length < MIN_MATCH_LEN) return false;
    return hard.some((p) => {
      const iss = p.issue.toLowerCase().trim();
      return iss.length >= MIN_MATCH_LEN && (prob.includes(iss) || iss.includes(prob));
    });
  });
  const toApply = hardCorrections.length > 0 ? hardCorrections : review.corrections;

  try {
    const { text } = await draftBlock({
      slot,
      cachedSystemContent,
      contract,
      previousDraft: draftText,
      corrections: toApply,
      onDelta,
      signal,
    });
    return { finalText: text, hardFixApplied: true, editorNotes: softNotes };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(
      JSON.stringify({ event: 'scriptwriter.block_fix_error', err: String(err).slice(0, 200) }),
    );
    return {
      finalText: draftText,
      hardFixApplied: false,
      editorNotes: [
        ...softNotes,
        ...hard.map((p) => `UNRESOLVED (hard): ${p.issue}: ${p.detail}`),
      ],
    };
  }
}
