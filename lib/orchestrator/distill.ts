import { generateObject } from 'ai';
import { z } from 'zod';

import type { Article, DistillResult, RatedArticle, TopicWithSources } from './types';

// Stage 1 schema (Haiku): topic grouping + scoring + summaries.
// Quotes are pulled in Stage 2 by Sonnet because verbatim copying is Haiku's
// known weak spot and on-air attribution requires exact source text.
const stage1Schema = z.object({
  topics: z
    .array(
      z.object({
        topic: z.string().describe('Short topic name, e.g. "Strait of Hormuz tensions"'),
        description: z.string().describe('1–2 sentence summary of what this topic is about'),
        articleIndices: z
          .array(z.number().int().min(0))
          .describe('Indices into the input articles array that belong to this topic'),
        ratings: z
          .array(
            z.object({
              articleIndex: z.number().int().min(0),
              relevance: z.number().int().min(0).max(100),
              credibility: z.number().int().min(0).max(100),
              completeness: z.number().int().min(0).max(100),
              summary: z
                .string()
                .describe(
                  '2–4 sentence summary of what this article contributes to this topic — the key facts, actors, numbers, and dates the script writer needs. No quoted material here.',
                ),
            }),
          )
          .describe('One rating per article in articleIndices, same length and order'),
      }),
    )
    .describe('Top 3 most newsworthy topics, ordered by interest (most newsworthy first)'),
  rationale: z.string().describe('1–3 sentences on why these topics were chosen over alternatives'),
});

// Stage 2 schema (Sonnet): verbatim quote extraction for selected articles.
const stage2Schema = z.object({
  articleQuotes: z
    .array(
      z.object({
        articleIndex: z.number().int().min(0),
        quotes: z
          .array(z.string())
          .max(5)
          .describe(
            'Up to 5 verbatim quotes from this article. Copy the source text exactly — do not paraphrase, smooth, or normalize punctuation. Empty array if no quotable material.',
          ),
      }),
    )
    .describe('One entry per selected article. Articles not present in input must be omitted.'),
});

const STAGE1_SYSTEM_PROMPT = `You are the news editor for *Ark News Daily*, a 6–10 minute daily briefing on Israel, Jews, and the Middle East. You group raw articles into newsworthy topics and rate sources.

Your selection principles (from the show's editorial guidance):
- Pick stories with broader significance — new developments, policy shifts, direct impact on the audience.
- Avoid "same story, no new angle" repetitions.
- Prefer topics where multiple credible sources are reporting.
- One article can map to multiple topics if relevant.

Rate every (article, topic) pair on three axes 0–100:
- relevance: does the article directly address this topic?
- credibility: is the outlet reputable for this kind of coverage? Mainstream wires and the major Israeli/US/Hebrew outlets score high; tabloids and unverified accounts score low.
- completeness: does the article add new info, or just repeat earlier coverage?

For every (article, topic) pair, also produce a summary: 2–4 sentences capturing what this article contributes to the topic — facts, actors, numbers, dates. The script writer will rely on this instead of re-reading the source, so be precise. Don't editorialize. No quoted material here — verbatim quotes are extracted in a separate downstream pass.

Return the top 3 topics ordered by newsworthiness (primary), source quality (secondary), completeness (tertiary). Return fewer than 3 only if the source pool genuinely doesn't support it.`;

const STAGE2_SYSTEM_PROMPT = `You extract quotable soundbites from news articles for a daily broadcast script. The quotes you return will be attributed and read on air, so verbatim fidelity is critical.

Rules:
- Copy quotes EXACTLY from the source text. Do not paraphrase, smooth wording, normalize punctuation, or correct typos.
- Pick lines that are quotable on air or that lock in attribution for a contested claim — direct quotations from named sources are best; tight factual sentences are also acceptable.
- Up to 5 quotes per article. Empty array if the article has no useful quotable material — do not pad.
- If the source has no embedded quotations, you may return short factual sentences copied verbatim, but never invent or recombine wording.`;

// Stage 1 article excerpt cap. Haiku is doing classification + summarization;
// 2000 chars ≈ 350 words covers the lead + nut graf of most news stories.
const STAGE1_ARTICLE_EXCERPT_CHARS = 2000;

// Stage 2 article excerpt cap. Sonnet runs only on the ~10–15 selected
// articles, so we can afford richer source text. 6000 chars covers the lead
// plus several body paragraphs where the strongest quotes from interviews,
// op-eds, and analysis pieces tend to live.
const STAGE2_ARTICLE_EXCERPT_CHARS = 6000;

// Cap on the tone-reference excerpt of prior scripts included in the cached
// stage-1 system. The full examples file is ~25k chars; 8000 chars carries
// enough register and pacing for the model to recognize the show's voice.
const EXAMPLES_CHARS = 8000;

function buildStage1Articles(articles: Article[]): string {
  return articles
    .map((a, i) => {
      const flag = a.isFlagged ? ' [outside-window]' : '';
      const err = a.fetchError ? ' [fetch-failed]' : '';
      const excerpt = a.content.slice(0, STAGE1_ARTICLE_EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
      return `[${i}] ${a.source} — ${a.title} (${a.publicationDate ?? 'no date'})${flag}${err}\n${excerpt}`;
    })
    .join('\n\n');
}

function buildStage2Articles(articles: Article[], indices: number[]): string {
  return indices
    .map((idx) => {
      const a = articles[idx];
      const excerpt = a.content.slice(0, STAGE2_ARTICLE_EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
      return `[${idx}] ${a.source} — ${a.title}\n${excerpt}`;
    })
    .join('\n\n');
}

export async function distillTopics(
  articles: Article[],
  exampleScripts: string,
  signal?: AbortSignal,
): Promise<DistillResult> {
  if (articles.length === 0) {
    return { topics: [], rationale: 'No articles available to distill.' };
  }

  // Stage 1 (Haiku): topic grouping + scoring + summaries on all candidates.
  // The system block (system prompt + tone reference) is stable across runs
  // and cached so consecutive runs in a session hit the prompt cache instead
  // of re-paying full input price for ~8k tokens of examples.
  const stage1CachedSystem = `${STAGE1_SYSTEM_PROMPT}

Tone reference (recent Ark News Daily scripts — match this register when judging newsworthiness):

${exampleScripts.slice(0, EXAMPLES_CHARS)}`;

  const stage1Prompt = `Articles to organize (indexed):

${buildStage1Articles(articles)}

Select up to 3 topics. For each topic, list which article indices belong, and for every (article, topic) pair return a rating and a 2–4 sentence summary.`;

  const { object: stage1 } = await generateObject({
    model: 'anthropic/claude-haiku-4-5',
    schema: stage1Schema,
    system: {
      role: 'system',
      content: stage1CachedSystem,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt: stage1Prompt,
    temperature: 0.2,
    abortSignal: signal,
  });

  // Stage 2 (Sonnet): verbatim quote extraction on the deduped selected set.
  // Running quotes through Sonnet protects on-air accuracy; running it on
  // only the selected articles (not all candidates) keeps total cost below
  // a single-pass Sonnet call.
  const selectedIndices = Array.from(
    new Set(
      stage1.topics
        .flatMap((t) => t.articleIndices)
        .filter((idx) => idx >= 0 && idx < articles.length),
    ),
  );

  const quotesByIndex = new Map<number, string[]>();
  if (selectedIndices.length > 0) {
    try {
      const { object: stage2 } = await generateObject({
        model: 'anthropic/claude-sonnet-4-6',
        schema: stage2Schema,
        system: {
          role: 'system',
          content: STAGE2_SYSTEM_PROMPT,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        prompt: `Articles selected for the script:

${buildStage2Articles(articles, selectedIndices)}

For each article above, pull up to 5 verbatim quotes the script writer could use as soundbites or attributed claims. Copy the source text exactly. Return an empty quotes array if an article has no quotable material.`,
        temperature: 0,
        abortSignal: signal,
      });
      for (const aq of stage2.articleQuotes) {
        if (aq.articleIndex >= 0 && aq.articleIndex < articles.length) {
          quotesByIndex.set(aq.articleIndex, aq.quotes);
        }
      }
    } catch (err) {
      // A caller-initiated cancel must propagate — don't mask it as a
      // (degraded-but-successful) distill missing its quotes.
      if (signal?.aborted) throw err;
      // Quote-extraction failure shouldn't block the script — the writer can
      // still work from summaries. Log so the gap is visible in observability.
      console.warn(
        JSON.stringify({ event: 'orchestrator.distill.quote_stage_error', err: String(err) }),
      );
    }
  }

  const topics: TopicWithSources[] = stage1.topics.slice(0, 3).map((t) => {
    const ratingByIdx = new Map(t.ratings.map((r) => [r.articleIndex, r]));
    const rated: RatedArticle[] = t.articleIndices
      .filter((idx) => idx >= 0 && idx < articles.length)
      .flatMap((idx): RatedArticle[] => {
        const r = ratingByIdx.get(idx);
        // Drop articles the model listed but didn't rate — defaulting to zeros
        // would silently rank them last, which masks the schema mismatch.
        if (!r) return [];
        return [{
          article: articles[idx],
          relevance: r.relevance,
          credibility: r.credibility,
          completeness: r.completeness,
          avgScore: Math.round((r.relevance + r.credibility + r.completeness) / 3),
          summary: r.summary,
          keyQuotes: quotesByIndex.get(idx) ?? [],
        }];
      })
      .sort((a, b) => b.avgScore - a.avgScore);

    return {
      topic: t.topic,
      description: t.description,
      articles: rated,
    };
  });

  return { topics, rationale: stage1.rationale };
}
