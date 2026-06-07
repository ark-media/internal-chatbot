import { generateObject } from 'ai';
import { z } from 'zod';

import { newsSystemPrompt } from '../news-prompt';
import type { TopicWithSources } from './types';

// Per-source text cap. Attached sources (via /attach) carry full content;
// doc-extracted sources carry only a facts summary. Either way this keeps the
// prompt bounded.
const SOURCE_TEXT_CHARS = 4000;

const deepenSchema = z.object({
  description: z
    .string()
    .describe(
      "The expanded 'why it matters' analysis for this topic — richer context and significance, grounded strictly in the sources provided. Preserve any existing 'Block:'/'Transition into next:' lines verbatim at the end if present.",
    ),
  articleQuotes: z
    .array(
      z.object({
        articleIndex: z.number().int().min(0),
        quotes: z
          .array(z.string())
          .max(5)
          .describe('Up to 5 ADDITIONAL verbatim quotes from this source, copied exactly. Empty if none.'),
      }),
    )
    .describe('New verbatim quotes per source. Omit sources with no full text or no new quotable material.'),
});

const DEEPEN_SYSTEM_PROMPT = `You are a senior editor for *Ark News Daily* deepening the analysis of one story before it goes to the script writer. Work ONLY from the sources provided — never invent facts, quotes, numbers, or causal claims that aren't supported by them.

Your job:
- Expand the topic's "why it matters" analysis: add genuine context, stakes, and connections that the sources support, in Ark's clear, contextual register. Do not pad or repeat. If the sources don't support more depth, return the description largely unchanged.
- Pull additional verbatim quotes from any source that has full text, copying the wording EXACTLY (no paraphrasing or normalizing).
- Stay grounded: this is analysis of reported facts, not opinion.`;

// Deepen one topic's analysis using its currently attached sources. Returns the
// new description plus any additional verbatim quotes keyed by article index.
export async function deepenTopic(
  topic: TopicWithSources,
  guidance: string,
  exampleScripts: string,
  signal?: AbortSignal,
): Promise<{ description: string; quotesByIndex: Map<number, string[]> }> {
  const cachedSystem = `${DEEPEN_SYSTEM_PROMPT}

== Ark editorial reference ==

${newsSystemPrompt('orchestrator').slice(0, 6000)}`;

  const sourceDigest = topic.articles
    .map((rated, i) => {
      const a = rated.article;
      const text = a.content
        ? a.content.slice(0, SOURCE_TEXT_CHARS).replace(/\s+/g, ' ').trim()
        : rated.summary ?? '';
      const quotes = (rated.keyQuotes ?? []).length
        ? `\nExisting quotes: ${(rated.keyQuotes ?? []).map((q) => `"${q}"`).join(' ')}`
        : '';
      return `[${i}] ${a.source} — ${a.title}\n${text}${quotes}`;
    })
    .join('\n\n');

  const guidanceLine = guidance
    ? `\n\nThe editor wants the analysis to push on this angle: ${guidance}`
    : '';

  const prompt = `Topic: ${topic.topic}

Current analysis:
${topic.description}

Sources:
${sourceDigest}${guidanceLine}

Expand the analysis grounded in these sources, and pull any additional verbatim quotes (only from sources with full text). Return the new description and the new quotes per source index.`;

  const { object } = await generateObject({
    model: 'anthropic/claude-sonnet-4-6',
    schema: deepenSchema,
    system: {
      role: 'system',
      content: cachedSystem,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.3,
    abortSignal: signal,
  });

  const quotesByIndex = new Map<number, string[]>();
  for (const aq of object.articleQuotes) {
    if (aq.articleIndex >= 0 && aq.articleIndex < topic.articles.length) {
      quotesByIndex.set(aq.articleIndex, aq.quotes);
    }
  }

  return { description: object.description, quotesByIndex };
}
