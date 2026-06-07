import { generateObject } from 'ai';
import { z } from 'zod';

import type { ExtractedStory } from './types';

// Extraction schema. Mirrors ExtractedStory minus `id` (assigned server-side
// after generation — we never trust the model for stable ids).
const extractSchema = z.object({
  stories: z
    .array(
      z.object({
        headline: z
          .string()
          .describe('A short, specific headline for this story.'),
        lead: z
          .string()
          .optional()
          .describe('The dossier "Lead:" line — the one-paragraph framing, if present.'),
        dryFacts: z
          .array(z.string())
          .describe(
            'Just what happened — the bare facts, one per item, no analysis. Condense each to one sentence. Pull from the "What happened" section and bullet sub-points.',
          ),
        relevance: z
          .string()
          .describe(
            "Ark Media's analysis — why this story matters and why the listener should care. Copy or condense the dossier's \"Why it matters\" section. Do not invent analysis that isn't supported by the dossier.",
          ),
        whatsNext: z
          .string()
          .optional()
          .describe('The dossier "What\'s next:" / forward-looking line, if present.'),
        blockHint: z
          .enum(['A', 'B', 'C', 'D'])
          .optional()
          .describe('If the dossier labels this an "A BLOCK" / "B BLOCK" etc., record the letter.'),
        sources: z
          .array(
            z.object({
              label: z
                .string()
                .describe('The outlet / link text, e.g. "Reuters", "Times of Israel".'),
              url: z.string().describe('The source URL, copied verbatim.'),
              facts: z
                .array(z.string())
                .optional()
                .describe('Dry facts attributable to THIS specific source, if the dossier ties them to it.'),
              sotClips: z
                .array(
                  z.object({
                    speaker: z
                      .string()
                      .describe('Who is speaking, in caps (e.g. TRUMP). Use SPEAKER_01 if unknown.'),
                    text: z.string().describe('The quote text, copied EXACTLY — never paraphrase.'),
                  }),
                )
                .optional()
                .describe('Verbatim "SOT:" audio-clip quotes attached to this source.'),
            }),
          )
          .describe('Every source link cited for this story. Capture both `([Outlet](url))` links and bare `Outlet — https://…` lines.'),
      }),
    )
    .describe('Every distinct story found in the dossier, in the order they appear.'),
});

const EXTRACT_SYSTEM_PROMPT = `You are an editorial assistant for *Ark News Daily*, a daily briefing on Israel, Jews, and the Middle East. You are parsing an editor's research dossier into clean, structured stories. You are NOT inventing or researching news — everything you output must come from the dossier.

The dossier is long and dense. It is often (but not always) loosely organized into "A BLOCK / B BLOCK / C BLOCK" sections, each with a bold headline, a "Lead:" line, a "What happened:" section, bullet sub-points (each a fact, sometimes with an inline "SOT:" audio-clip quote), a "Why it matters:" section, and a "What's next:" line. Sources appear inline as markdown links like \`([Reuters](https://…))\` OR as bare lines like \`Outlet — https://…\`.

Your job:
- Extract EVERY distinct story. If the dossier uses A/B/C BLOCK labels, each block is usually one story — record the letter in blockHint. For unstructured dossiers, infer the story boundaries yourself.
- Separate DRY FACTS (just what happened) from RELEVANCE (Ark's analysis of why it matters). The dossier usually labels these "What happened" and "Why it matters". Keep them distinct — never put analysis in dryFacts or raw events in relevance.
- Capture EVERY source URL, in both the \`([Outlet](url))\` and bare \`Outlet — https://…\` forms. Copy URLs character-for-character. Never fabricate, complete, or guess a URL.
- Copy SOT quotes EXACTLY — verbatim, including punctuation. These are read on air; fidelity is critical. Never paraphrase or smooth a quote.
- When a fact or quote is clearly tied to one source, attach it to that source's facts/sotClips. Otherwise put it in the story-level dryFacts.
- Condense long passages into tight one-sentence facts, but never change names, numbers, dates, or quotes.`;

// Parse an editor's dossier (markdown) into structured stories. Single Sonnet
// call — a 5–8k-word dossier (~11k tokens) fits comfortably; we set a generous
// output budget for stories with long fact lists. The system block is cached so
// a re-extract reuses the cached instructions. Ids are assigned by the caller.
export async function extractStories(
  documentMarkdown: string,
  signal?: AbortSignal,
): Promise<Omit<ExtractedStory, 'id'>[]> {
  const { object } = await generateObject({
    model: 'anthropic/claude-sonnet-4-6',
    schema: extractSchema,
    system: {
      role: 'system',
      content: EXTRACT_SYSTEM_PROMPT,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt: `Parse the following editor's dossier into structured stories.\n\n---\n\n${documentMarkdown}`,
    temperature: 0.1,
    maxOutputTokens: 16000,
    abortSignal: signal,
  });

  return object.stories.map((s) => ({
    headline: s.headline,
    lead: s.lead,
    dryFacts: s.dryFacts,
    relevance: s.relevance,
    whatsNext: s.whatsNext,
    blockHint: s.blockHint,
    sources: s.sources.map((src) => ({
      label: src.label,
      url: src.url,
      facts: src.facts,
      sotClips: src.sotClips,
    })),
  }));
}
