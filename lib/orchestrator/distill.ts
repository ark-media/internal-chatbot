import { generateObject } from 'ai';
import { z } from 'zod';

import type { Article, DistillResult, RatedArticle, TopicWithSources } from './types';

const distillSchema = z.object({
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
            }),
          )
          .describe('One rating per article in articleIndices, same length and order'),
      }),
    )
    .describe('Top 3 most newsworthy topics, ordered by interest (most newsworthy first)'),
  rationale: z.string().describe('1–3 sentences on why these topics were chosen over alternatives'),
});

const SYSTEM_PROMPT = `You are the news editor for *Ark News Daily*, a 6–10 minute daily briefing on Israel, Jews, and the Middle East. You group raw articles into newsworthy topics and rate sources.

Your selection principles (from the show's editorial guidance):
- Pick stories with broader significance — new developments, policy shifts, direct impact on the audience.
- Avoid "same story, no new angle" repetitions.
- Prefer topics where multiple credible sources are reporting.
- One article can map to multiple topics if relevant.

Rate every (article, topic) pair on three axes 0–100:
- relevance: does the article directly address this topic?
- credibility: is the outlet reputable for this kind of coverage? Mainstream wires and the major Israeli/US/Hebrew outlets score high; tabloids and unverified accounts score low.
- completeness: does the article add new info, or just repeat earlier coverage?

Return the top 3 topics ordered by newsworthiness (primary), source quality (secondary), completeness (tertiary). Return fewer than 3 only if the source pool genuinely doesn't support it.`;

function buildArticleSummary(articles: Article[]): string {
  return articles
    .map((a, i) => {
      const flag = a.isFlagged ? ' [outside-window]' : '';
      const err = a.fetchError ? ' [fetch-failed]' : '';
      const excerpt = a.content.slice(0, 1200).replace(/\s+/g, ' ').trim();
      return `[${i}] ${a.source} — ${a.title} (${a.publicationDate ?? 'no date'})${flag}${err}\n${excerpt}`;
    })
    .join('\n\n');
}

export async function distillTopics(
  articles: Article[],
  exampleScripts: string,
): Promise<DistillResult> {
  if (articles.length === 0) {
    return { topics: [], rationale: 'No articles available to distill.' };
  }

  const prompt = `Tone reference (recent Ark News Daily scripts — match this register when judging newsworthiness):

${exampleScripts.slice(0, 8000)}

Articles to organize (indexed):

${buildArticleSummary(articles)}

Select up to 3 topics. For each topic, list which article indices belong, and rate every (article, topic) pair.`;

  const { object } = await generateObject({
    model: 'anthropic/claude-sonnet-4-6',
    schema: distillSchema,
    system: {
      role: 'system',
      content: SYSTEM_PROMPT,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.2,
  });

  const topics: TopicWithSources[] = object.topics.slice(0, 3).map((t) => {
    const ratingByIdx = new Map(t.ratings.map((r) => [r.articleIndex, r]));
    const rated: RatedArticle[] = t.articleIndices
      .filter((idx) => idx >= 0 && idx < articles.length)
      .map((idx) => {
        const r = ratingByIdx.get(idx);
        const relevance = r?.relevance ?? 0;
        const credibility = r?.credibility ?? 0;
        const completeness = r?.completeness ?? 0;
        return {
          article: articles[idx],
          relevance,
          credibility,
          completeness,
          avgScore: Math.round((relevance + credibility + completeness) / 3),
        };
      })
      .sort((a, b) => b.avgScore - a.avgScore);

    return {
      topic: t.topic,
      description: t.description,
      articles: rated,
    };
  });

  return { topics, rationale: object.rationale };
}
