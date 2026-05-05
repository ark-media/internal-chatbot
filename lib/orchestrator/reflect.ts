import { generateObject } from 'ai';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { craftScript } from './script-craft';
import type {
  Article,
  ReviewResult,
  Script,
  TopicWithSources,
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
- SOFT feedback (guidance, not blockers): voice/tone, structural imbalance, clarity/jargon, audio pacing, word repetition.

Counting rule: each distinct issue counts as 1 problem (do NOT weight by severity). If the same defect appears in multiple places, it's still 1 problem with one correction.

Decision rule:
- Fewer than 3 distinct problems → "exit" (ship it)
- 3 or more distinct problems → "loop" (revise)

Corrections must be specific and directly implementable. Don't say "improve voice" — quote the offending text and suggest exact replacement language. Don't invent new content; the corrections should preserve every factual claim already cited.`;

async function reviewScriptWithOpus(opts: {
  script: Script;
  exampleScripts: string;
  approvedTopics: TopicWithSources[];
}): Promise<ReviewResult> {
  const { script, exampleScripts, approvedTopics } = opts;
  const checklist = await loadEditorialChecklist();

  const sourceList = approvedTopics
    .flatMap((t) => t.articles.map((r) => r.article))
    .map((a) => `- ${a.source} — ${a.title} (${a.publicationDate ?? 'unknown'})${a.isFlagged ? ' [outside-window]' : ''}: ${a.url}`)
    .join('\n');

  const prompt = `EDITORIAL CHECKLIST:

${checklist}

GOLD-STANDARD EXAMPLES (match this register):

${exampleScripts.slice(0, 12000)}

APPROVED SOURCES (every superscript citation in the script should map to one of these):

${sourceList}

SCRIPT TO REVIEW:

${script.fullText}

Review the script. Return a JSON object with: problems (array of {type, issue, detail}), decision ("loop" or "exit"), corrections (array of {blockOrSection, problem, suggestedFix}). Apply the decision rule strictly: <3 distinct problems → exit, ≥3 → loop.`;

  const { object } = await generateObject({
    model: 'anthropic/claude-opus-4-7',
    schema: reviewSchema,
    system: {
      role: 'system',
      content: ADVISOR_SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.1,
  });

  // Defensive: enforce the decision rule in code rather than trusting the model.
  const decision: 'loop' | 'exit' = object.problems.length >= 3 ? 'loop' : 'exit';

  return {
    problems: object.problems,
    decision,
    corrections: object.corrections,
  };
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

const MAX_ITERATIONS = 3;

export async function reflectLoop(opts: {
  initialScript: Script;
  approvedTopics: TopicWithSources[];
  additionalArticles?: Article[];
  exampleScripts: string;
  today: string;
}): Promise<ReflectOutcome> {
  const { initialScript, approvedTopics, additionalArticles = [], exampleScripts, today } = opts;

  let script = initialScript;
  const history: ReflectOutcome['history'] = [];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let review: ReviewResult;
    try {
      review = await reviewScriptWithOpus({ script, exampleScripts, approvedTopics });
    } catch (err) {
      // Spec: if Opus call fails, fall back to Sonnet's own judgment and exit.
      console.warn(JSON.stringify({ event: 'orchestrator.reflect.opus_error', err: String(err) }));
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
        topics: approvedTopics,
        additionalArticles,
        exampleScripts,
        today,
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
