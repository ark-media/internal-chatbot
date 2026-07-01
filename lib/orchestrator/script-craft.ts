import { generateText } from 'ai';

import { newsContextForDate, newsSystemPrompt } from '../news-prompt';
import type {
  Article,
  ReviewCorrection,
  Script,
  TopicWithSources,
} from './types';

// Soft cap on quotes per article surfaced to the writer. Distill's stage-2
// pass (Sonnet) already returns at most 5 quotes ranked by relevance; this
// is a defensive ceiling in case an upstream caller hands the writer
// pre-built RatedArticles with longer quote lists.
const MAX_QUOTES_PER_ARTICLE = 5;

// Char cap on the raw-excerpt fallback used for articles that bypass distill
// (e.g. /refetch). 1500 chars ≈ 250 words — enough for a lead + nut graf
// so the writer has something to work with, but small enough that one
// late-added article doesn't blow up the cached system block.
const FALLBACK_EXCERPT_CHARS = 1500;

// Temperature for the script writer (initial draft, revision loop, and
// user-driven refinement). Raised from 0.3 → 0.5 to restore lexical variety
// and natural rhythm; at 0.3 the prose came out flat and monotone, which read
// as robotic. Kept below the fact-critical stages (extract/distill run at ≤0.1).
const SCRIPT_WRITER_TEMPERATURE = 0.5;

// Model for the script writer. Flipped from claude-sonnet-4-6 to claude-sonnet-5
// on 2026-07-01 after a same-prompt A/B on the clipdist eval: Sonnet 5 placed
// SOT clips well across the script body on 20/20 runs vs 14/20 for 4.6 (which
// kept front-loading them), a significant gap (p ~ 0.02). Env-overridable so
// evals can still A/B. Both craftScript and refineScript use it.
const SCRIPT_WRITER_MODEL =
  process.env.SCRIPT_WRITER_MODEL ?? 'anthropic/claude-sonnet-5';

// Exported for unit testing — assembles the source digest the writer sees.
export function buildSourceBlock(topics: TopicWithSources[], extras: Article[]): string {
  const lines: string[] = [];
  topics.forEach((t, ti) => {
    lines.push(`# Topic ${ti + 1}: ${t.topic}`);
    lines.push(t.description);
    // Document flow folds the editor's arc decisions in here rather than into
    // the persisted description (see TopicWithSources.block/transition).
    if (t.block) lines.push(`Block: ${t.block}`);
    if (t.transition) lines.push(`Transition into next: "${t.transition}"`);
    lines.push('');
    t.articles.forEach((rated) => {
      const a = rated.article;
      const flag = a.isFlagged ? ' [outside acceptable date window]' : '';
      const err = a.fetchError ? ` [fetch error: ${a.fetchError}]` : '';
      const header = `## ${a.source} — ${a.title}${flag}${err}\nURL: ${a.url}\nDate: ${a.publicationDate ?? 'unknown'}\nScores: rel=${rated.relevance} cred=${rated.credibility} comp=${rated.completeness}`;

      // Prefer the distilled summary + verbatim quotes; fall back to a raw
      // content excerpt only for sources that bypassed distill (e.g. articles
      // added via /refetch).
      const quotes = (rated.keyQuotes ?? []).slice(0, MAX_QUOTES_PER_ARTICLE);
      const quotesBlock =
        quotes.length > 0
          ? `Quotes (verbatim):\n${quotes.map((q) => `- "${q}"`).join('\n')}`
          : '';
      let body: string;
      if (rated.summary && rated.summary.length > 0) {
        body = quotesBlock
          ? `Summary: ${rated.summary}\n\n${quotesBlock}`
          : `Summary: ${rated.summary}`;
      } else if (quotesBlock) {
        // No summary but verbatim quotes exist (e.g. a doc source whose facts
        // live at story level): surface the quotes instead of an empty excerpt.
        body = quotesBlock;
      } else {
        body = `Excerpt:\n${a.content.slice(0, FALLBACK_EXCERPT_CHARS)}`;
      }

      lines.push(`${header}\n\n${body}`);
      lines.push('');
    });
  });

  if (extras.length > 0) {
    lines.push('# Additional articles supplied by writer');
    extras.forEach((a) => {
      lines.push(
        `## ${a.source} — ${a.title}\nURL: ${a.url}\nDate: ${a.publicationDate ?? 'unknown'}\n\nExcerpt:\n${a.content.slice(0, FALLBACK_EXCERPT_CHARS)}`,
      );
      lines.push('');
    });
  }

  return lines.join('\n');
}

export function computeMetadata(fullText: string): Script['metadata'] {
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  const blockCount = (fullText.match(/\[(A|B|C|D) BLOCK\]/g) ?? []).length;
  const citedSources = new Set<string>();
  for (const m of fullText.matchAll(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g)) {
    citedSources.add(m[0]);
  }
  const flagCount = (fullText.match(/\[FLAG:/g) ?? []).length;
  return { wordCount, blockCount, citedSources: citedSources.size, flagCount };
}

const REFINE_INSTRUCTIONS = (corrections: ReviewCorrection[]) =>
  corrections.length === 0
    ? ''
    : `\n\n== Corrections from prior review (apply ALL) ==\n\n${corrections
        .map(
          (c, i) =>
            `${i + 1}. ${c.blockOrSection} — addresses: ${c.problem}\n   Fix: ${c.suggestedFix}`,
        )
        .join('\n\n')}\n\nApply these corrections faithfully while preserving the rest of the script.`;

// Stable across the lifetime of a run: system prompt, reference examples,
// date context, and sources. Cached as a single Anthropic ephemeral block so
// every call (initial craft, reflect-loop refines, user-driven refines) hits
// the cache.
//
// `styleProfile` is the distilled writer-preference text from
// `lib/orchestrator/style-memory`. It's also passed into the reflect/review
// agent (see `reflect.ts#reviewScript`) so the reviewer treats the
// same preferences as ground truth and doesn't oscillate against the writer.
export function buildCachedSystemContent(opts: {
  topics: TopicWithSources[];
  additionalArticles?: Article[];
  exampleScripts: string;
  today: string;
  styleProfile?: string;
}): string {
  const {
    topics,
    additionalArticles = [],
    exampleScripts,
    today,
    styleProfile,
  } = opts;
  const dateContext = newsContextForDate(today);
  const sourceBlock = buildSourceBlock(topics, additionalArticles);
  const styleBlock =
    styleProfile && styleProfile.trim().length > 0
      ? `\n\n== Writer Style Notes ==\n\nDistilled from how this writer revises drafts. Apply these preferences naturally; they do not override factual accuracy or the Output Format.\n\n${styleProfile.trim()}`
      : '';
  return `${newsSystemPrompt('orchestrator')}

== Reference Examples ==

${exampleScripts}

== Date Context ==

${dateContext}

== Approved Topics & Sources ==

${sourceBlock}${styleBlock}`;
}

export async function craftScript(opts: {
  cachedSystemContent: string;
  corrections?: ReviewCorrection[];
  previousScript?: string;
}): Promise<Script> {
  const { cachedSystemContent, corrections = [], previousScript } = opts;

  const refineBlock = REFINE_INSTRUCTIONS(corrections);
  const previousBlock = previousScript
    ? `\n\n== Previous draft (revise this; do not start from scratch) ==\n\n${previousScript}`
    : '';

  const prompt = `${previousBlock}${refineBlock}

Write the broadcast-ready script now. Begin your response with "SONIC ID:" — no preamble, no announcements about fetching or searching, no commentary about what you're about to do. Follow the Output Format from the system prompt exactly: SONIC ID + intro, [A BLOCK]/[B BLOCK]/[C BLOCK] (and [D BLOCK] if warranted), outro, then "---" then "SOURCES:" with a numbered list. Use superscript footnotes (¹²³…) for every factual claim. Add inline [FLAG: ...] notes for uncertain or weak sourcing. Aim for 1000–1200 words of script body.`;

  const { text } = await generateText({
    model: SCRIPT_WRITER_MODEL,
    system: {
      role: 'system',
      content: cachedSystemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: SCRIPT_WRITER_TEMPERATURE,
  });

  return { fullText: text.trim(), metadata: computeMetadata(text) };
}

// User-driven refinement after the script is complete. Stateless: model only
// sees the latest script + the new instruction (plus an optional list of
// recently-applied edits to discourage drift), never the full chat history.
export async function refineScript(opts: {
  cachedSystemContent: string;
  previousScript: string;
  instruction: string;
  recentEdits?: Array<{ instruction: string; version: number }>;
}): Promise<Script> {
  const { cachedSystemContent, previousScript, instruction, recentEdits = [] } = opts;

  const recentBlock =
    recentEdits.length === 0
      ? ''
      : `\n\n== Recent edits already applied (do not undo) ==\n${recentEdits
          .map((e) => `- v${e.version - 1} → v${e.version}: ${e.instruction}`)
          .join('\n')}`;

  const prompt = `== Current script ==

${previousScript}${recentBlock}

== Writer's request ==

${instruction}

Apply the writer's request to the current script and return the full revised script. Preserve every factual claim, citation, and FLAG that the request doesn't explicitly touch. Do not start from scratch — edit in place. Follow the Output Format from the system prompt exactly: SONIC ID + intro, blocks, outro, then "---" then "SOURCES:". Begin your response with "SONIC ID:" — no preamble.`;

  const { text } = await generateText({
    model: SCRIPT_WRITER_MODEL,
    system: {
      role: 'system',
      content: cachedSystemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: SCRIPT_WRITER_TEMPERATURE,
  });

  return { fullText: text.trim(), metadata: computeMetadata(text) };
}
