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
      lines.push(
        `## ${a.source} — ${a.title}${flag}${err}\nURL: ${a.url}\nDate: ${a.publicationDate ?? 'unknown'}\nScores: rel=${rated.relevance} cred=${rated.credibility} comp=${rated.completeness}\n\n${a.content.slice(0, 4000)}`,
      );
      lines.push('');
    });
  });

  if (extras.length > 0) {
    lines.push('# Additional articles supplied by writer');
    extras.forEach((a) => {
      lines.push(
        `## ${a.source} — ${a.title}\nURL: ${a.url}\nDate: ${a.publicationDate ?? 'unknown'}\n\n${a.content.slice(0, 4000)}`,
      );
      lines.push('');
    });
  }

  return lines.join('\n');
}

function computeMetadata(fullText: string): Script['metadata'] {
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

export async function craftScript(opts: {
  topics: TopicWithSources[];
  additionalArticles?: Article[];
  exampleScripts: string;
  today: string;
  corrections?: ReviewCorrection[];
  previousScript?: string;
}): Promise<Script> {
  const {
    topics,
    additionalArticles = [],
    exampleScripts,
    today,
    corrections = [],
    previousScript,
  } = opts;

  const dateContext = newsContextForDate(today);
  const sourceBlock = buildSourceBlock(topics, additionalArticles);
  const refineBlock = REFINE_INSTRUCTIONS(corrections);
  const previousBlock = previousScript
    ? `\n\n== Previous draft (revise this; do not start from scratch) ==\n\n${previousScript}`
    : '';

  const prompt = `${dateContext}

== Reference Examples ==

${exampleScripts}

== Approved Topics & Sources ==

${sourceBlock}${previousBlock}${refineBlock}

Write the broadcast-ready script now. Follow the Output Format from the system prompt exactly: SONIC ID + intro, [A BLOCK]/[B BLOCK]/[C BLOCK] (and [D BLOCK] if warranted), outro, then "---" then "SOURCES:" with a numbered list. Use superscript footnotes (¹²³…) for every factual claim. Add inline [FLAG: ...] notes for uncertain or weak sourcing. Aim for 1000–1200 words of script body.`;

  const { text } = await generateText({
    model: 'anthropic/claude-sonnet-4-6',
    system: {
      role: 'system',
      content: newsSystemPrompt(),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.3,
  });

  return { fullText: text.trim(), metadata: computeMetadata(text) };
}
