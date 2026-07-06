import { generateObject } from 'ai';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { craftScript } from './script-craft';
import type {
  ReviewResult,
  Script,
} from './types';

const reviewSchema = z.object({
  problems: z.array(
    z.object({
      type: z.enum(['hard', 'soft']),
      issue: z.string(),
      detail: z.string(),
    }),
  ),
  decision: z.enum(['loop', 'exit']),
  corrections: z.array(
    z.object({
      blockOrSection: z.string(),
      problem: z.string(),
      suggestedFix: z.string(),
    }),
  ),
});

let cachedChecklist: string | null = null;
async function loadEditorialChecklist(): Promise<string> {
  if (cachedChecklist !== null) return cachedChecklist;
  try {
    cachedChecklist = await fs.readFile(
      path.join(process.cwd(), 'lib', 'news-editorial-checklist.md'),
      'utf-8',
    );
  } catch {
    cachedChecklist = '';
  }
  return cachedChecklist;
}

const ADVISOR_SYSTEM = `You are a senior editor for *Ark News Daily*, a daily news briefing hosted by Deborah Pardes.

Your job: review the script against the editorial checklist and the gold-standard examples. Identify distinct problems, decide whether the script is ready, and return targeted corrections.

Distinguish:
- HARD failures (must be fixed): factual inaccuracy, claims not supported by sources, source-fidelity violations (orphaned superscripts, misquoted/misattributed material, missing FLAGs on uncertain claims).
- SOFT feedback (guidance, not blockers): structural imbalance, clarity/jargon, audio pacing, word repetition, AND AI-cadence tells (see below).

AI-CADENCE TELLS (mark each as type "soft"). These read as machine-written when they pile up, but an isolated one is not worth forcing a full rewrite — and over-scrubbing flattens the voice into a monotone, which is its own tell. Flag genuine instances, but do not hunt for borderline cases, and never demand the removal of natural emphasis or sentence-length variation:
- Takeaway-as-its-own-beat: "Here's the problem." "Here's the thing." "Here's what matters." "But here's the catch."
- Naming the tension instead of telling it: "And that's the real tension." "That's the paradox." "And that's the bind."
- The "not X — it's Y" reframe used as a punchline.
- Rhetorical question answered by a one-word/one-line fragment ("So what changed? Everything.").
- Dramatic one-clause sentences for effect ("And it worked." "Until now." "Not anymore.").
- Stock essay connectors ("Make no mistake," "The bigger picture," "At the end of the day," "The bottom line," "What's clear is").
- Em-dash overuse (a common AI tell). Flag it only when the script leans on em-dashes heavily (two in one sentence, or back-to-back sentences). The correction should replace some em-dashes with commas, periods, or plain connectors.
For each, the correction must rewrite the offending line in the show's voice (see the gold-standard examples) — fold the point into the surrounding prose or cut it. Do not just delete substance.

Counting rule: each distinct issue counts as 1 problem (do NOT weight by severity). If the same defect appears in multiple places, it's still 1 problem with one correction — but distinct AI-cadence tells (different phrasings) are separate problems.

Decision rule:
- "loop" (revise) if there is ANY hard failure, or 3+ distinct problems of any kind.
- "exit" (ship it) only when there are zero hard failures and fewer than 3 soft problems.

Corrections must be specific and directly implementable. Don't say "improve voice" — quote the offending text and suggest exact replacement language. Don't invent new content; the corrections should preserve every factual claim already cited.`;

// Cap on the reviewer's output. The schema is structured (≤N problems +
// corrections), so unbounded generation just produces verbose `detail` and
// `suggestedFix` fields — one observed run cost $0.39 mostly from 12k output
// tokens. 2000 tokens covers a thorough review at normal verbosity.
const REVIEWER_MAX_OUTPUT_TOKENS = 2000;

async function reviewScript(opts: {
  script: Script;
  reviewerSystemContent: string;
  sourceList: string;
}): Promise<ReviewResult> {
  const { script, reviewerSystemContent, sourceList } = opts;

  const prompt = `APPROVED SOURCES (every superscript citation in the script should map to one of these):

${sourceList}

SCRIPT TO REVIEW:

${script.fullText}

Review the script. Return a JSON object with: problems (array of {type, issue, detail}), decision ("loop" or "exit"), corrections (array of {blockOrSection, problem, suggestedFix}). Apply the decision rule strictly: "loop" if there is ANY hard failure or 3+ distinct problems; "exit" only with zero hard failures and fewer than 3 soft problems.`;

  const { object } = await generateObject({
    model: 'anthropic/claude-sonnet-4-6',
    schema: reviewSchema,
    system: {
      role: 'system',
      content: reviewerSystemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.1,
    maxOutputTokens: REVIEWER_MAX_OUTPUT_TOKENS,
  });

  // Defensive: enforce the decision rule in code rather than trusting the model.
  // Loop on ANY hard failure (factual/source-fidelity) or on 3+ problems of any
  // kind. AI-cadence tells are now SOFT: a lone stylistic tell no longer forces a
  // rewrite pass (which tended to flatten the voice), but several still trigger a
  // revision via the 3+ total-problems threshold.
  const hardCount = object.problems.filter((p) => p.type === 'hard').length;
  const decision: 'loop' | 'exit' =
    hardCount >= 1 || object.problems.length >= 3 ? 'loop' : 'exit';

  return {
    problems: object.problems,
    decision,
    corrections: object.corrections,
  };
}

const MAX_ITERATIONS = 3;

// Soft cap on the examples block in the reviewer's cached system. The
// reviewer judges against the editorial checklist + source list; examples
// only set tone reference, so a smaller slice still does the job. 6k chars
// (~1.5k tokens) keeps the cached system lean. Truncated at the nearest
// preceding paragraph boundary by `truncateAtParagraph` so we don't cut
// mid-sentence.
const EXAMPLE_TRUNCATE_CHARS = 6000;

// Truncate `text` to at most `limit` characters at a paragraph boundary
// (double-newline). Falls back to a single-newline cut, then a hard slice,
// so the function always returns ≤ `limit` chars. Exported for tests.
export function truncateAtParagraph(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const para = head.lastIndexOf('\n\n');
  if (para > limit * 0.6) return head.slice(0, para);
  const line = head.lastIndexOf('\n');
  if (line > limit * 0.6) return head.slice(0, line);
  return head;
}

// Pre-build the reviewer's system content once per generate run. Content is
// identical across all reflect iterations (checklist + examples + style are
// stable), so building it once guarantees a single cache write and cache
// reads on every subsequent reviewer call in the loop.
export async function buildReviewerSystemContent(opts: {
  exampleScripts: string;
  styleProfile?: string;
}): Promise<string> {
  const { exampleScripts, styleProfile } = opts;
  const checklist = await loadEditorialChecklist();
  const styleBlock =
    styleProfile && styleProfile.trim().length > 0
      ? `\n\nWRITER STYLE PREFERENCES (treat as ground truth — do not flag as problems):\n\n${styleProfile.trim()}`
      : '';
  return `${ADVISOR_SYSTEM}

EDITORIAL CHECKLIST:

${checklist}

GOLD-STANDARD EXAMPLES (match this register):

${truncateAtParagraph(exampleScripts, EXAMPLE_TRUNCATE_CHARS)}${styleBlock}`;
}

export type ReflectOutcome = {
  finalScript: Script;
  iterations: number;
  history: Array<{
    iteration: number;
    decision: 'loop' | 'exit';
    problemCount: number;
  }>;
};

export async function reflectLoop(opts: {
  initialScript: Script;
  // Pre-formatted "APPROVED SOURCES" list the reviewer checks superscript
  // citations against — one `- source — title (date): url` line per source.
  // The orchestrator builds this from approved topics; the freeform news chat
  // builds it from the script's own SOURCES section.
  sourceList: string;
  cachedSystemContent: string;
  cachedReviewerSystemContent: string;
}): Promise<ReflectOutcome> {
  const { initialScript, sourceList, cachedSystemContent, cachedReviewerSystemContent } = opts;

  let script = initialScript;
  const history: ReflectOutcome['history'] = [];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let review: ReviewResult;
    try {
      review = await reviewScript({ script, reviewerSystemContent: cachedReviewerSystemContent, sourceList });
    } catch (err) {
      // If the reviewer call fails, fall back to the writer's own judgment
      // and exit the loop with the latest draft.
      console.warn(JSON.stringify({ event: 'orchestrator.reflect.reviewer_error', err: String(err) }));
      return { finalScript: script, iterations: iteration, history };
    }

    history.push({
      iteration,
      decision: review.decision,
      problemCount: review.problems.length,
    });

    if (review.decision === 'exit' || iteration === MAX_ITERATIONS) {
      return { finalScript: script, iterations: iteration, history };
    }

    try {
      script = await craftScript({
        cachedSystemContent,
        corrections: review.corrections,
        previousScript: script.fullText,
      });
    } catch (err) {
      console.warn(JSON.stringify({ event: 'orchestrator.reflect.refine_error', err: String(err) }));
      return { finalScript: script, iterations: iteration, history };
    }
  }

  return { finalScript: script, iterations: MAX_ITERATIONS, history };
}
