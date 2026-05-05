import { generateText } from 'ai';

import { newsContextForDate, newsSystemPrompt } from '../news-prompt';
import type {
  Article,
  ReviewCorrection,
  Script,
  TopicWithSources,
} from './types';

function buildSourceBlock(topics: TopicWithSources[], extras: Article[]): string {
  const lines: string[] = [];
  topics.forEach((t, ti) => {
    lines.push(`# Topic ${ti + 1}: ${t.topic}`);
    lines.push(t.description);
    lines.push('');
    t.articles.forEach((rated) => {
      const a = rated.article;
      const flag = a.isFlagged ? ' [outside acceptable date window]' : '';
      const err = a.fetchError ? ` [fetch error: ${a.fetchError}]` : '';
      const header = `## ${a.source} — ${a.title}${flag}${err}\nURL: ${a.url}\nDate: ${a.publicationDate ?? 'unknown'}\nScores: rel=${rated.relevance} cred=${rated.credibility} comp=${rated.completeness}`;

      // Prefer the distilled summary + verbatim quotes; fall back to a raw
      // content excerpt only for sources that bypassed distill (e.g. articles
      // added via /refetch).
      let body: string;
      if (rated.summary && rated.summary.length > 0) {
        const quotesBlock =
          rated.keyQuotes && rated.keyQuotes.length > 0
            ? `\n\nQuotes (verbatim):\n${rated.keyQuotes.map((q) => `- "${q}"`).join('\n')}`
            : '';
        body = `Summary: ${rated.summary}${quotesBlock}`;
      } else {
        body = `Excerpt:\n${a.content.slice(0, 2000)}`;
      }

      lines.push(`${header}\n\n${body}`);
      lines.push('');
    });
  });

  if (extras.length > 0) {
    lines.push('# Additional articles supplied by writer');
    extras.forEach((a) => {
      lines.push(
        `## ${a.source} — ${a.title}\nURL: ${a.url}\nDate: ${a.publicationDate ?? 'unknown'}\n\nExcerpt:\n${a.content.slice(0, 2000)}`,
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
// agent (see `reflect.ts#reviewScriptWithOpus`) so the reviewer treats the
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
    model: 'anthropic/claude-sonnet-4-6',
    system: {
      role: 'system',
      content: cachedSystemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.3,
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
    model: 'anthropic/claude-sonnet-4-6',
    system: {
      role: 'system',
      content: cachedSystemContent,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.3,
  });

  return { fullText: text.trim(), metadata: computeMetadata(text) };
}
