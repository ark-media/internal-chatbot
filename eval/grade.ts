/**
 * Evaluate the chatbot across four query classes:
 *
 *   lookup    — hybrid RAG recall/MRR on expected episodes.
 *               File: eval/questions.jsonl
 *               Row:  { id, question, expected_episode_ids[], notes? }
 *
 *   dossier   — completeness of getDossier for a named speaker.
 *               File: eval/dossier.jsonl
 *               Row:  { id, speaker_name, expected_min_episodes, filters?{showIds?,since?,until?}, notes? }
 *               Metric: episode-count recall vs expected_min_episodes.
 *
 *   refusal   — router correctly flags out-of-scope questions.
 *               File: eval/refusal.jsonl
 *               Row:  { id, question, notes? }
 *               Metric: share of questions routed to out_of_scope.
 *
 *   aggregate — DB-level correctness of countGuestAppearancesOnShow and listTopGuests.
 *               File: eval/aggregate.jsonl
 *               Rows: two kinds, discriminated by `kind`:
 *                 { id, kind:"countAppearances", speaker, show, expected_min_count, notes? }
 *                 { id, kind:"topGuests", show?|showGroup?, since?, until?, limit?,
 *                   expected_top:[{name, min_episodes}], notes? }
 *               Note: this tests the aggregation functions directly, not the model.
 *               Prompt drift (e.g. model re-emitting a markdown table instead of letting
 *               the UI render it) must be caught by manual review or a model-level eval.
 *
 *   clipdist  — model-level: are SOT/quote clips distributed through a block
 *               rather than clustered at the top/bottom or stacked adjacent?
 *               File: eval/clip-distribution.jsonl
 *               Row:  { id, topic, description, clips:[{speaker,text}] (>=2), notes? }
 *               Generates via the real craftScript() path RUNS times per fixture
 *               (default 5) since generation is stochastic; reports a pass rate.
 *               Behavioral eval — TARGET is deliberately below the 0.9 gates.
 *
 *   translate — model-level: given a Hebrew/mixed C-block draft and a request to
 *               translate + adapt it, does the CHAT path produce a fully-English,
 *               show-voice, fact-corrected script? File: eval/translate-adapt.jsonl
 *               Row:  { id, userPrompt, goldBlock?,
 *                       factChecks?:[{claim,draftValue,correctValue}], notes? }
 *               Runs the real two-turn chat flow (readback → confirm → draft)
 *               RUNS times (default 3) WITH live web search + corpus tools wired
 *               in, so the writer can fact-check the draft's figures. An LLM judge
 *               then grades each draft. Gated metrics: fully-English rate
 *               (TARGET, default 0.9) AND facts-corrected rate (FACTS_TARGET,
 *               default 0.66, behavioral — depends on live search). Adapted-to-
 *               voice rate is reported as a secondary, ungated signal.
 *               Needs TAVILY_API_KEY for web search; DATABASE_URL for the corpus
 *               tool + search cache.
 *
 * Usage:
 *   pnpm eval:grade                  # default bucket=lookup
 *   BUCKET=dossier pnpm eval:grade
 *   BUCKET=refusal pnpm eval:grade
 *   BUCKET=aggregate pnpm eval:grade
 *   BUCKET=clipdist RUNS=5 pnpm eval:grade
 *   BUCKET=translate RUNS=3 pnpm eval:grade          # FACTS_TARGET=… to tune fact gate
 *   BUCKET=newschat RUNS=3 pnpm eval:grade           # NEWS_CHAT_MODEL=… to A/B the writer
 *   BUCKET=lookup pnpm eval:grade some/other.jsonl
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(__dirname, '..', '.env.local') });

import { generateObject, generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

import {
  countGuestAppearancesOnShow,
  getDossier,
  listSpeakers,
  listTopGuests,
  lookupCorpus,
  type CorpusFilters,
} from '../lib/retrieval';
import { routeQuery } from '../lib/router';
import { lookupShowGroupId, lookupShowId } from '../lib/show-lookup';
import {
  buildCachedSystemContent,
  craftScript,
} from '../lib/orchestrator/script-craft';
import {
  getNewsExamples,
  newsContextForDate,
  newsSystemPrompt,
} from '../lib/news-prompt';
import { webSearch } from '../lib/web-search';
import { ensureEnglish } from '../lib/translate';
import {
  cacheKey,
  ensureTable,
  getCached,
  setCached,
} from '../lib/tool-cache';
import type { TopicWithSources } from '../lib/orchestrator/types';

type LookupQ = {
  id: string;
  question: string;
  expected_episode_ids: string[];
  notes?: string;
};

type DossierQ = {
  id: string;
  speaker_name: string;
  expected_min_episodes: number;
  filters?: Pick<CorpusFilters, 'showIds' | 'showGroupIds' | 'since' | 'until'>;
  notes?: string;
};

type RefusalQ = { id: string; question: string; notes?: string };

type AggregateQ =
  | {
      id: string;
      kind: 'countAppearances';
      speaker: string;
      show: string;
      expected_min_count: number;
      notes?: string;
    }
  | {
      id: string;
      kind: 'topGuests';
      show?: string;
      showGroup?: string;
      since?: string;
      until?: string;
      limit?: number;
      expected_top: Array<{ name: string; min_episodes: number }>;
      notes?: string;
    };

type ClipDistQ = {
  id: string;
  topic: string;
  description: string;
  clips: { speaker: string; text: string }[];
  notes?: string;
};

type TranslateAdaptQ = {
  id: string;
  // The writer's chat-mode message: a draft (often Hebrew or mixed) plus the
  // instruction to translate + adapt it to the show language.
  userPrompt: string;
  // Optional human-finalised English version, shown to the judge as the target
  // register/facts. Not matched word-for-word (it may be truncated).
  goldBlock?: string;
  // Ground-truth corrections: figures the draft got wrong that the model —
  // now armed with live web search — should fix (or flag) rather than repeat.
  // The judge is told the draft value and the fact-checked value for each.
  factChecks?: { claim: string; draftValue: string; correctValue: string }[];
  notes?: string;
};

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    console.error(`eval file not found: ${path}`);
    process.exit(1);
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

async function gradeLookup(path: string): Promise<boolean> {
  const questions = loadJsonl<LookupQ>(path);
  console.log(`lookup: ${questions.length} questions from ${path}\n`);

  let recallHits = 0;
  let mrrSum = 0;

  for (const q of questions) {
    const chunks = await lookupCorpus({ query: q.question, finalK: 8 });
    const rankedEpisodes: string[] = [];
    for (const c of chunks) {
      if (!rankedEpisodes.includes(c.episodeId)) rankedEpisodes.push(c.episodeId);
    }
    const hitIndex = rankedEpisodes.findIndex((eid) =>
      q.expected_episode_ids.includes(eid),
    );
    const hit = hitIndex >= 0;
    const rr = hit ? 1 / (hitIndex + 1) : 0;
    if (hit) recallHits += 1;
    mrrSum += rr;

    console.log(
      `[${hit ? 'HIT ' : 'MISS'}] ${q.id} rr=${rr.toFixed(3)} — ${q.question}`,
    );
    console.log(
      `        expected: ${q.expected_episode_ids.join(', ')}\n        ranked:   ${rankedEpisodes.slice(0, 5).join(', ')}${rankedEpisodes.length > 5 ? ', ...' : ''}`,
    );
  }

  const n = questions.length;
  const recall = n === 0 ? 0 : recallHits / n;
  const mrr = n === 0 ? 0 : mrrSum / n;
  console.log(`\n---\nquestions: ${n}`);
  console.log(`Recall@8: ${recall.toFixed(3)} (target >= 0.85)`);
  console.log(`MRR:      ${mrr.toFixed(3)} (target >= 0.60)`);
  const pass = recall >= 0.85 && mrr >= 0.6;
  console.log(pass ? 'PASS' : 'BELOW TARGET');
  return pass;
}

async function gradeDossier(path: string): Promise<boolean> {
  const questions = loadJsonl<DossierQ>(path);
  console.log(`dossier: ${questions.length} questions from ${path}\n`);

  let passed = 0;
  let completenessSum = 0;

  for (const q of questions) {
    const matches = await listSpeakers({
      nameLike: q.speaker_name,
      includeUnreviewed: false,
      limit: 1,
    });
    if (matches.length === 0) {
      console.log(`[MISS] ${q.id} — speaker "${q.speaker_name}" not found`);
      continue;
    }
    const speakerId = matches[0].speakerId;
    const page = await getDossier({
      speakerId,
      filters: q.filters ?? {},
      limit: 500,
    });
    const uniqueEpisodes = new Set(page.turns.map((t) => t.episodeId)).size;
    const completeness =
      q.expected_min_episodes > 0
        ? Math.min(1, uniqueEpisodes / q.expected_min_episodes)
        : 1;
    const pass = uniqueEpisodes >= q.expected_min_episodes;
    if (pass) passed += 1;
    completenessSum += completeness;

    console.log(
      `[${pass ? 'PASS' : 'FAIL'}] ${q.id} — ${q.speaker_name}: got ${uniqueEpisodes} episodes, expected >= ${q.expected_min_episodes} (completeness ${completeness.toFixed(2)})`,
    );
  }

  const n = questions.length;
  const passRate = n === 0 ? 0 : passed / n;
  const avgCompleteness = n === 0 ? 0 : completenessSum / n;
  console.log(`\n---\nquestions: ${n}`);
  console.log(`Pass rate:      ${passRate.toFixed(3)} (target >= 0.85)`);
  console.log(`Avg completeness: ${avgCompleteness.toFixed(3)}`);
  return passRate >= 0.85;
}

async function gradeRefusal(path: string): Promise<boolean> {
  const questions = loadJsonl<RefusalQ>(path);
  console.log(`refusal: ${questions.length} questions from ${path}\n`);

  const today = new Date().toISOString().slice(0, 10);
  let refused = 0;

  for (const q of questions) {
    const routed = await routeQuery(q.question, today);
    const isRefusal = routed.intent === 'out_of_scope';
    if (isRefusal) refused += 1;
    console.log(
      `[${isRefusal ? 'REFUSED' : 'ROUTED '}] ${q.id} (intent=${routed.intent}) — ${q.question}`,
    );
  }

  const n = questions.length;
  const refusalRate = n === 0 ? 0 : refused / n;
  console.log(`\n---\nquestions: ${n}`);
  console.log(`Refusal rate: ${refusalRate.toFixed(3)} (target >= 0.90)`);
  return refusalRate >= 0.9;
}


async function gradeAggregate(path: string): Promise<boolean> {
  const questions = loadJsonl<AggregateQ>(path);
  console.log(`aggregate: ${questions.length} questions from ${path}\n`);

  let passed = 0;

  for (const q of questions) {
    if (q.kind === 'countAppearances') {
      const speakers = await listSpeakers({
        nameLike: q.speaker,
        includeUnreviewed: false,
        limit: 5,
      });
      const match =
        speakers.find(
          (s) => s.canonicalName.toLowerCase() === q.speaker.toLowerCase(),
        ) ?? speakers[0];
      if (!match) {
        console.log(`[MISS] ${q.id} — speaker not found: ${q.speaker}`);
        continue;
      }
      const showId = await lookupShowId(q.show);
      if (!showId) {
        console.log(`[MISS] ${q.id} — show not found: ${q.show}`);
        continue;
      }
      const result = await countGuestAppearancesOnShow({
        speakerId: match.speakerId,
        showId,
      });
      if (result.kind === 'host') {
        console.log(
          `[FAIL] ${q.id} — ${q.speaker} is a host of ${q.show}, not a guest`,
        );
        continue;
      }
      const pass = result.count >= q.expected_min_count;
      if (pass) passed += 1;
      console.log(
        `[${pass ? 'PASS' : 'FAIL'}] ${q.id} — ${q.speaker} on ${q.show}: got ${result.count}, expected >= ${q.expected_min_count}`,
      );
      continue;
    }

    // topGuests
    let showIds: number[] | undefined;
    let showGroupIds: number[] | undefined;
    if (q.show) {
      const sid = await lookupShowId(q.show);
      if (!sid) {
        console.log(`[MISS] ${q.id} — show not found: ${q.show}`);
        continue;
      }
      showIds = [sid];
    }
    if (q.showGroup) {
      const gid = await lookupShowGroupId(q.showGroup);
      if (!gid) {
        console.log(`[MISS] ${q.id} — showGroup not found: ${q.showGroup}`);
        continue;
      }
      showGroupIds = [gid];
    }
    const limit = q.limit ?? 10;
    const rows = await listTopGuests({
      filters: { showIds, showGroupIds, since: q.since, until: q.until },
      limit,
    });
    const byName = new Map(rows.map((r) => [r.speakerName.toLowerCase(), r]));
    const failures: string[] = [];
    for (const exp of q.expected_top) {
      const row = byName.get(exp.name.toLowerCase());
      if (!row) {
        failures.push(`missing "${exp.name}"`);
        continue;
      }
      if (row.episodeCount < exp.min_episodes) {
        failures.push(
          `${exp.name} got ${row.episodeCount}, expected >= ${exp.min_episodes}`,
        );
      }
    }
    const scope = q.show ?? q.showGroup ?? 'corpus';
    if (failures.length === 0) {
      passed += 1;
      console.log(`[PASS] ${q.id} — topGuests scope=${scope} limit=${limit}`);
    } else {
      console.log(
        `[FAIL] ${q.id} — topGuests scope=${scope} limit=${limit}: ${failures.join('; ')}`,
      );
    }
  }

  const n = questions.length;
  const passRate = n === 0 ? 0 : passed / n;
  console.log(`\n---\nquestions: ${n}`);
  console.log(`Pass rate: ${passRate.toFixed(3)} (target >= 0.90)`);
  return passRate >= 0.9;
}

// -- clipdist: SOT/quote placement across the script body -------------------
//
// The unit test in lib/news-prompt.test.ts proves the "distribute clips evenly"
// rule is PRESENT in the prompt. It cannot prove the temperature-0.5 model
// OBEYS it — that's what this bucket measures.

// A clip renders as a SPEAKER label line ("NETANYAHU:" / "SPEAKER_01:") on its
// own, followed by the quote. We locate the label lines — but NOT the "HOST:"
// narrator label that opens every block (per the Output Format), which is not a
// clip and would otherwise pin a phantom clip at position 0 of every block.
function isSpeakerLabel(line: string): boolean {
  const t = line.trim();
  if (/^HOST:\s*$/.test(t)) return false;
  return /^[A-Z][A-Z0-9 ._'-]*:\s*$/.test(t);
}

// Reduce the script to the ordered list of body paragraphs — everything from
// the first [A BLOCK] up to the SOURCES divider, with the [X BLOCK] markers
// removed. We score distribution over the WHOLE body, not a single block: the
// property we care about ("clips don't all converge at the start or end, and
// aren't stacked adjacent") is a body-level property. Scoring only the densest
// block wrongly failed the healthy case where the model spreads one clip per
// block across the story.
function scriptBodyParagraphs(script: string): string[] {
  const firstBlock = script.search(/\[[A-D] BLOCK\]/);
  if (firstBlock < 0) return [];
  let body = script.slice(firstBlock);
  // Cut the SOURCES list (heading or a bare divider before it) so its lines
  // can't be mistaken for clips.
  const sourcesCut = body.search(/\n[\s>*#]*[-*_]{3,}\s*\n|\n[#\s>*]*sources\b/i);
  if (sourcesCut >= 0) body = body.slice(0, sourcesCut);
  body = body.replace(/\[[A-D] BLOCK\]/g, '');
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

type ClipScore = {
  clipCount: number;
  positions: number[]; // normalized [0,1] paragraph index of each clip
  adjacent: boolean; // any two clips back-to-back with no narration between
  clustered: boolean; // all clips in the first or all in the last 40% of body
  spread: number; // max - min normalized position
};

function scoreScript(script: string): ClipScore {
  const paras = scriptBodyParagraphs(script);
  const clipIdx: number[] = [];
  paras.forEach((p, i) => {
    if (isSpeakerLabel(p.split('\n')[0])) clipIdx.push(i);
  });

  const n = paras.length;
  const positions = clipIdx.map((i) => (n <= 1 ? 0 : i / (n - 1)));
  let adjacent = false;
  for (let k = 1; k < clipIdx.length; k++) {
    if (clipIdx[k] - clipIdx[k - 1] === 1) adjacent = true;
  }
  const clustered =
    positions.length >= 2 &&
    (positions.every((p) => p <= 0.4) || positions.every((p) => p >= 0.6));
  const spread =
    positions.length >= 2 ? Math.max(...positions) - Math.min(...positions) : 0;

  return { clipCount: clipIdx.length, positions, adjacent, clustered, spread };
}

// Tri-state: a run with <2 emitted SOT blocks can't test distribution (the
// model chose inline attribution or emitted a single clip), so it's excluded
// from the pass-rate denominator rather than counted as a failure.
type ClipVerdict = 'pass' | 'fail' | 'inconclusive';

function clipVerdict(score: ClipScore): ClipVerdict {
  if (score.clipCount < 2) return 'inconclusive';
  return !score.adjacent && !score.clustered && score.spread >= 0.3
    ? 'pass'
    : 'fail';
}

function clipFixtureToTopic(fx: ClipDistQ): TopicWithSources {
  return {
    topic: fx.topic,
    description: fx.description,
    articles: [
      {
        article: {
          title: fx.topic,
          url: 'https://example.com/story',
          publicationDate: null,
          source: 'Wire',
          content: '',
          isFlagged: false,
        },
        relevance: 90,
        credibility: 90,
        completeness: 90,
        avgScore: 90,
        provenance: 'manual',
        summary: fx.description,
        // keyQuotes is exactly how SOT clips reach the writer: "SPEAKER: text".
        keyQuotes: fx.clips.map((c) => `${c.speaker}: ${c.text}`),
      },
    ],
  };
}

async function gradeClipDistribution(path: string): Promise<boolean> {
  const fixtures = loadJsonl<ClipDistQ>(path);
  const runs = Number(process.env.RUNS ?? 5);
  const today = process.env.TODAY ?? new Date().toISOString().slice(0, 10);
  // Behavioral eval on a stochastic model — don't expect the perfection of the
  // deterministic buckets. Calibrated on 2026-07-01 (temp 0.5) via a same-prompt
  // A/B: the production writer is now claude-sonnet-5, which passed 20/20 with
  // clips reaching the back half and C-block close (spread 0.41-0.71); the prior
  // claude-sonnet-4-6 default managed 14/20 (~0.70), front-loading clips into the
  // first half. TARGET is a regression FLOOR under the current default's observed
  // rate — it should pass at status quo and only fire if placement regresses
  // (e.g. a prompt edit or a model change that reintroduces front-loading).
  // Override with TARGET=… env when A/B-ing a different SCRIPT_WRITER_MODEL.
  const target = Number(process.env.TARGET ?? 0.8);
  console.log(
    `clipdist: ${fixtures.length} fixtures × ${runs} runs from ${path}\n`,
  );

  const examples = await getNewsExamples();
  let scored = 0; // pass + fail (the denominator)
  let passed = 0;
  let inconclusive = 0;
  let errored = 0; // generation threw (e.g. gateway timeout) — excluded, reported

  for (const fx of fixtures) {
    const cachedSystemContent = buildCachedSystemContent({
      topics: [clipFixtureToTopic(fx)],
      exampleScripts: examples,
      today,
    });

    for (let r = 0; r < runs; r++) {
      let fullText: string;
      try {
        ({ fullText } = await craftScript({ cachedSystemContent }));
      } catch (err) {
        // A provider stall (e.g. gateway UND_ERR_HEADERS_TIMEOUT) shouldn't
        // abort the whole bucket — tally it and move on so slower/less-reliable
        // models still yield a pass-rate over the runs that did complete.
        errored += 1;
        console.log(
          `[ERROR       ] ${fx.id} run=${r + 1}/${runs} — ${String((err as Error)?.message ?? err).split('\n')[0]}`,
        );
        continue;
      }
      const s = scoreScript(fullText);
      const verdict = clipVerdict(s);
      if (verdict === 'inconclusive') inconclusive += 1;
      else {
        scored += 1;
        if (verdict === 'pass') passed += 1;
      }
      console.log(
        `[${verdict.toUpperCase().padEnd(12)}] ${fx.id} run=${r + 1}/${runs} ` +
          `clips=${s.clipCount} adjacent=${s.adjacent} ` +
          `clustered=${s.clustered} spread=${s.spread.toFixed(2)} ` +
          `pos=[${s.positions.map((p) => p.toFixed(2)).join(', ')}]`,
      );
    }
  }

  const passRate = scored === 0 ? 0 : passed / scored;
  console.log(
    `\n---\nscored runs: ${scored} (inconclusive, excluded: ${inconclusive}; errored, excluded: ${errored})`,
  );
  console.log(`Pass rate: ${passRate.toFixed(3)} (target >= ${target})`);
  if (scored === 0) {
    console.log('No scorable runs — every generation used inline quotes. Inconclusive.');
    return false;
  }
  return passRate >= target;
}

// -- translate: chat-mode Hebrew→English translate-and-adapt --------------
//
// The writer pastes a C-block draft written mostly in Hebrew (with an English
// SOT clip and song cues) and asks the assistant to translate it to English and
// adapt it to the Ark News Daily show voice. This exercises the real CHAT path,
// which gates script-writing on a first-turn understanding readback (see
// news-prompt.ts "First Turn: Gather, Then Confirm Understanding"). So we run
// two turns: turn 1 draws the readback, turn 2 confirms and draws the script.
// An LLM judge then grades the drafted script. Behavioral eval — stochastic.

// Model for the simulated chat turns. Mirrors the news route default
// (DEFAULT_MODEL_ID); env-overridable so an eval can A/B a different model.
const NEWS_CHAT_MODEL =
  process.env.NEWS_CHAT_MODEL ?? 'anthropic/claude-sonnet-5';
// Temperature preset the news chat surface starts at ('standard' = 0.5). Keep
// in sync with NEWS_DEFAULT_TEMPERATURE_PRESET in lib/temperature.ts.
const NEWS_CHAT_TEMPERATURE = 0.5;
// Judge runs cold and deterministic; a separate model id so it can be pinned.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'anthropic/claude-sonnet-5';

// Diagnostic only (the judge is authoritative for the verdict): count Hebrew-
// block codepoints so a run that leaks raw Hebrew is visible at a glance.
function hebrewCharCount(s: string): number {
  return (s.match(/[֐-׿]/g) ?? []).length;
}

// Reconstruct the chat-path context the news route prepends: a user turn with
// the date context + reference examples, and the assistant's canned ack. See
// app/api/news/route.ts (contextMessages).
async function buildChatContext(
  today: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const examples = await getNewsExamples();
  return [
    {
      role: 'user',
      content: `${newsContextForDate(today)}\n\n== Reference Examples ==\n\n${examples}`,
    },
    {
      role: 'assistant',
      content:
        'I understand the date context and writing style. Ready to create the news script.',
    },
  ];
}

// Eval-local rebuild of the chat path's tools (they live inline and unexported
// in app/api/news/route.ts, which we don't want to import into an eval). Reuses
// the same underlying libs and cache so behavior — and cost — track production.
// webSearch is what lets the writer fact-check the draft's rough figures;
// searchCorpus anchors voice. fetchArticle is omitted: the draft carries no
// article URLs to extract (only a YouTube song cue and a podcast link), so
// verification flows through webSearch.
function buildFactCheckTools(arkNewsDailyShowId: number | null) {
  return {
    webSearch: tool({
      description:
        'Web search (Tavily) for recent news, context, and breaking developments. Use to verify facts and figures. Returns up to 6 results with title, URL, snippet, and publish date.',
      inputSchema: z.object({
        query: z.string().describe('Search query with specific keywords from the story.'),
        daysBack: z.number().int().min(1).max(365).optional(),
      }),
      execute: async (input) => {
        const key = cacheKey('websearch', { query: input.query, daysBack: input.daysBack });
        const cached = await getCached(key, 6);
        if (cached) return cached;
        const res = await webSearch(input.query, { maxResults: 6, daysBack: input.daysBack });
        const response = res.ok
          ? {
              results: await Promise.all(
                res.results.map(async (r) => ({
                  title: await ensureEnglish(r.title),
                  url: r.url,
                  snippet: await ensureEnglish(r.snippet),
                  published: r.publishedDate ?? null,
                })),
              ),
            }
          : { results: [], note: res.note };
        await setCached(key, response);
        return response;
      },
    }),
    searchCorpus: tool({
      description:
        "Search Ark News Daily's own transcript archive for prior scripts and style examples. Returns up to 4 matching script excerpts.",
      inputSchema: z.object({ query: z.string() }),
      execute: async (input) => {
        const chunks = await lookupCorpus({
          query: input.query,
          filters: arkNewsDailyShowId ? { showIds: [arkNewsDailyShowId] } : undefined,
          finalK: 4,
        });
        return chunks.length === 0
          ? { chunks: [], note: 'No matching scripts found.' }
          : {
              chunks: chunks.map((c) => ({
                show: c.showName,
                title: c.title,
                date: c.date,
                excerpt: c.text,
              })),
            };
      },
    }),
  };
}

type FactCheckTools = ReturnType<typeof buildFactCheckTools>;

// Two-turn chat generation: turn 1 yields the understanding readback (the
// gate), turn 2 confirms it and yields the adapted script. Tools are wired so
// the writer can fact-check the draft's figures live, exactly as the real chat
// route does. Returns the turn-2 script (the only thing the judge scores).
async function draftAdaptedScript(
  userPrompt: string,
  today: string,
  tools: FactCheckTools,
  confirmMessage = 'Yes, your understanding is correct. Please write the adapted C block in English now.',
): Promise<{ readback: string; script: string }> {
  const system = {
    role: 'system' as const,
    content: newsSystemPrompt('chat'),
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };
  const context = await buildChatContext(today);

  const turn1 = await generateText({
    model: NEWS_CHAT_MODEL,
    system,
    messages: [...context, { role: 'user', content: userPrompt }],
    tools,
    stopWhen: stepCountIs(8),
    temperature: NEWS_CHAT_TEMPERATURE,
  });
  // Turn 1 can end on a tool call and return no assistant text; a subsequent
  // empty content block is rejected by the API ('text content blocks must be
  // non-empty'). Fall back to a minimal non-empty ack so turn 2 still runs.
  const readback = turn1.text.trim() || '(Understood — ready to write.)';

  const turn2 = await generateText({
    model: NEWS_CHAT_MODEL,
    system,
    messages: [
      ...context,
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: readback },
      {
        role: 'user',
        content: confirmMessage,
      },
    ],
    tools,
    stopWhen: stepCountIs(8),
    temperature: NEWS_CHAT_TEMPERATURE,
  });

  return { readback, script: turn2.text.trim() };
}

// From-scratch generation for the `newschat` bucket. The two-turn readback
// dance draftAdaptedScript uses is a chat-UX gate, not the thing we grade — and
// for research-heavy topics it's fragile: the writer spends its step budget on
// web searches and never reaches the script, or asks the producer another
// question instead of writing. So we collapse to ONE turn that explicitly tells
// the writer to research-then-write and emit only the finished script, with a
// larger step budget so tool calls don't starve the writing. Same system
// prompt, context, tools, and temperature as the real chat path.
async function draftNewsScript(
  userPrompt: string,
  today: string,
  tools: FactCheckTools,
): Promise<{ script: string }> {
  const system = {
    role: 'system' as const,
    content: newsSystemPrompt('chat'),
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };
  const context = await buildChatContext(today);
  const directive =
    `${userPrompt}\n\n` +
    'Write the complete, final on-air Ark News Daily script now. First use the ' +
    'web-search and archive tools to ground your figures, then output ONLY the ' +
    'finished script — sonic ID, HOST narration, the A/B/C blocks, any ' +
    'SOT clips, and the sources list. Do not ask for confirmation and do not ' +
    'include a readback, planning notes, or any commentary outside the script.';

  const res = await generateText({
    model: NEWS_CHAT_MODEL,
    system,
    messages: [...context, { role: 'user', content: directive }],
    tools,
    // Larger than the two-turn path's 8: one turn now does research AND writing.
    stopWhen: stepCountIs(16),
    temperature: NEWS_CHAT_TEMPERATURE,
  });
  return { script: res.text.trim() };
}

const judgeSchema = z.object({
  fullyEnglish: z
    .boolean()
    .describe(
      'True only if the script body is entirely in English with no untranslated Hebrew words or phrases left in. Proper nouns, the anthem title, and the slogan may stay as given, but any Hebrew sentence or clause left in the prose makes this false.',
    ),
  idiomaticEnglish: z
    .boolean()
    .describe(
      'True if the English reads as natural, native prose, NOT a stiff word-for-word transliteration of the Hebrew source.',
    ),
  adaptedToShowVoice: z
    .boolean()
    .describe(
      'True if the output is adapted to the Ark News Daily C-block register (warm, conversational close that sets up the SOT clip and song cues instead of dropping them in cold), rather than a raw literal translation.',
    ),
  factsCorrected: z
    .boolean()
    .describe(
      "True if, for EVERY listed fact-check, the output does NOT assert the draft's unsupported value as plain fact — it instead uses a figure within the correct value's stated range/sources (real-world figures vary by source, so a credible sourced figure in range counts; exact match is NOT required) or flags the figure for verification. If the output repeats a wrong draft figure as bald fact, this is false. If no fact-checks are listed, true.",
    ),
  factsDetail: z
    .string()
    .describe(
      'For each listed fact-check, state what value the output used and whether that counts as corrected, still-wrong, or flagged.',
    ),
  reasoning: z
    .string()
    .describe('2-4 sentences justifying the verdict, citing specifics from the output.'),
});

async function judgeAdaptation(
  script: string,
  fx: TranslateAdaptQ,
): Promise<z.infer<typeof judgeSchema>> {
  const goldRef = fx.goldBlock
    ? `\n\nFor reference, a human-finalised English version of this C block (the target register and facts — the output need NOT match it word-for-word, and this gold copy is truncated):\n\n${fx.goldBlock}`
    : '';
  const factRef =
    fx.factChecks && fx.factChecks.length > 0
      ? `\n\nFact-checks to apply. For each, the draft the writer pasted contained the DRAFT value, but the correct (fact-checked) value is CORRECT. A good output should not assert the draft value as fact:\n${fx.factChecks
          .map(
            (f) => `- ${f.claim}: draft="${f.draftValue}" correct="${f.correctValue}"`,
          )
          .join('\n')}`
      : '';
  const { object } = await generateObject({
    model: JUDGE_MODEL,
    schema: judgeSchema,
    system: {
      role: 'system',
      content:
        "You grade a script-writing assistant for the audio news show Ark News Daily. The writer pasted a C-block draft written mostly in Hebrew (with an English soundbite and two song cues) and asked the assistant to TRANSLATE it to English and ADAPT it to the show voice. The assistant had live web search to verify figures. Grade strictly on translation completeness and adaptation quality. For fact-correction, the goal is that the assistant does NOT parrot the draft's unsupported figures — it should replace them with a credibly sourced figure (within the range noted in the fact-check, since real-world numbers legitimately vary by source) or flag them. Do NOT punish a well-sourced figure just because it differs from one specific value. Be demanding on the essentials: any Hebrew left untranslated in the body means fullyEnglish is false; repeating a draft's wrong figure as bald on-air fact means factsCorrected is false.",
    },
    prompt: `Assistant output to grade:\n\n${script}${goldRef}${factRef}`,
    temperature: 0,
  });
  return object;
}

async function gradeTranslateAdapt(path: string): Promise<boolean> {
  const fixtures = loadJsonl<TranslateAdaptQ>(path);
  const runs = Number(process.env.RUNS ?? 3);
  const today = process.env.TODAY ?? new Date().toISOString().slice(0, 10);
  // Fully translating a Hebrew draft to English is near-deterministic behavior,
  // so this floor sits with the deterministic buckets at 0.9 rather than the
  // clipdist behavioral floor. Override with TARGET=… when experimenting.
  const target = Number(process.env.TARGET ?? 0.9);
  // Fact-correction depends on live web search actually surfacing the right
  // figures, so it's a behavioral floor below the English gate. Override with
  // FACTS_TARGET=… when experimenting.
  const factsTarget = Number(process.env.FACTS_TARGET ?? 0.66);
  console.log(
    `translate: ${fixtures.length} fixtures × ${runs} runs from ${path}\n`,
  );

  // The web-search tool caches through lib/tool-cache (Postgres); make sure the
  // table exists before the first tool call.
  await ensureTable();
  const arkNewsDailyShowId = await lookupShowId('Ark News Daily');
  const tools = buildFactCheckTools(arkNewsDailyShowId);

  let scored = 0;
  let englishPass = 0;
  let adaptPass = 0;
  let factsPass = 0;
  let errored = 0; // generation threw (e.g. gateway timeout) — excluded, reported

  for (const fx of fixtures) {
    for (let r = 0; r < runs; r++) {
      let script: string;
      try {
        ({ script } = await draftAdaptedScript(fx.userPrompt, today, tools));
      } catch (err) {
        // Don't let a provider stall (gateway UND_ERR_HEADERS_TIMEOUT) abort the
        // bucket — tally and continue so completed runs still yield rates.
        errored += 1;
        console.log(
          `[ERROR  ] ${fx.id} run=${r + 1}/${runs} — ${String((err as Error)?.message ?? err).split('\n')[0]}`,
        );
        continue;
      }
      const heb = hebrewCharCount(script);
      const v = await judgeAdaptation(script, fx);
      scored += 1;
      if (v.fullyEnglish) englishPass += 1;
      // Secondary signal: a genuine adaptation is both idiomatic and in-voice.
      if (v.idiomaticEnglish && v.adaptedToShowVoice) adaptPass += 1;
      if (v.factsCorrected) factsPass += 1;
      console.log(
        `[${(v.fullyEnglish ? 'ENGLISH' : 'HEBREW').padEnd(7)}] ${fx.id} ` +
          `run=${r + 1}/${runs} hebChars=${heb} ` +
          `idiomatic=${v.idiomaticEnglish} showVoice=${v.adaptedToShowVoice} ` +
          `factsCorrected=${v.factsCorrected}`,
      );
      console.log(`        ${v.reasoning}`);
      console.log(`        facts: ${v.factsDetail}`);
    }
  }

  const englishRate = scored === 0 ? 0 : englishPass / scored;
  const adaptRate = scored === 0 ? 0 : adaptPass / scored;
  const factsRate = scored === 0 ? 0 : factsPass / scored;
  console.log(`\n---\nscored runs: ${scored} (errored, excluded: ${errored})`);
  console.log(
    `Fully-English rate:      ${englishRate.toFixed(3)} (target >= ${target})`,
  );
  console.log(
    `Facts-corrected rate:    ${factsRate.toFixed(3)} (target >= ${factsTarget})`,
  );
  console.log(
    `Adapted-to-voice rate:   ${adaptRate.toFixed(3)} (secondary, not gated)`,
  );
  const pass = englishRate >= target && factsRate >= factsTarget;
  console.log(pass ? 'PASS' : 'BELOW TARGET');
  return pass;
}

// -- newschat: from-scratch script generation via the news CHAT path ---------
//
// Unlike `translate` (which adapts a pasted draft) this measures the chat UI's
// core job: given a producer's topic request, does the writer PRODUCE a
// broadcast-ready Ark News Daily script? Runs the exact chat path
// (newsSystemPrompt('chat') → readback → confirm → script) with the same web-
// search + corpus tools wired in, RUNS times per fixture (default 3) since
// generation is stochastic. Grades the RAW first-pass writer output — the
// reflect editor pass (lib/orchestrator) is deliberately NOT run, so this
// isolates the writer model for a clean A/B (set NEWS_CHAT_MODEL to compare).
// The judge (JUDGE_MODEL, pinned Claude) scores four dimensions; each has its
// own env-overridable target and the run passes only if all four clear.

type NewsChatQ = { id: string; userPrompt: string; date?: string; notes?: string };

const newsChatJudgeSchema = z.object({
  structureFormat: z
    .boolean()
    .describe(
      'True if the output is a broadcast-ready script in the show format: block structure (e.g. [A BLOCK]/[B BLOCK]/[C BLOCK] with HOST: narration), any soundbites rendered as SPEAKER-labelled SOT clips, and a sensible on-air length. False if it is an outline, a chat reply, a bare list, or otherwise not a readable script a host could voice.',
    ),
  factuallyGrounded: z
    .boolean()
    .describe(
      'True if factual claims and figures are grounded — the writer used the web-search/corpus tools and cites/sources its numbers, OR hedges/attributes rather than asserting invented specifics. False if it states unsupported figures as bald fact or fabricates events, quotes, or sources.',
    ),
  showVoice: z
    .boolean()
    .describe(
      "True if it reads in the Ark News Daily register: warm and conversational, clips set up (not cold-dropped) and distributed through the body, natural host transitions. False if it's stiff wire-copy, listy, or tonally off.",
    ),
  fullyEnglishClean: z
    .boolean()
    .describe(
      'True ONLY if the script body is entirely English broadcast copy with NO leftover non-English fragments AND no meta/reasoning/chain-of-thought leakage (no "let me…", planning notes, or self-talk) — it must be the finished script, not the model thinking out loud. False if any of that leaks in.',
    ),
  reasoning: z
    .string()
    .describe('2-4 sentences justifying the four verdicts, citing specifics from the output.'),
});

async function judgeNewsScript(
  script: string,
): Promise<z.infer<typeof newsChatJudgeSchema>> {
  const { object } = await generateObject({
    model: JUDGE_MODEL,
    schema: newsChatJudgeSchema,
    system: {
      role: 'system',
      content:
        "You grade the RAW first-pass output of a script-writing assistant for the audio news show Ark News Daily. A producer asked it to write a full script on a topic; the assistant had live web search and the show's transcript archive as tools. Grade strictly and independently on the four dimensions. Be demanding: an outline or a chat-style reply is NOT structureFormat; unsupported invented figures asserted as fact fail factuallyGrounded; any chain-of-thought/planning self-talk or non-English fragment left in the body fails fullyEnglishClean.",
    },
    prompt: `Assistant output to grade:\n\n${script}`,
    temperature: 0,
  });
  return object;
}

async function gradeNewsChat(path: string): Promise<boolean> {
  const fixtures = loadJsonl<NewsChatQ>(path);
  const runs = Number(process.env.RUNS ?? 3);
  const today = process.env.TODAY ?? new Date().toISOString().slice(0, 10);
  // Structure, voice and clean-output are near-deterministic for a capable
  // writer, so they floor high; factual grounding depends on live search so it
  // sits lower (behavioral). All four are env-overridable when A/B-ing a model.
  const structureTarget = Number(process.env.STRUCTURE_TARGET ?? 0.8);
  const factsTarget = Number(process.env.FACTS_TARGET ?? 0.66);
  const voiceTarget = Number(process.env.VOICE_TARGET ?? 0.8);
  const cleanTarget = Number(process.env.CLEAN_TARGET ?? 0.9);
  console.log(
    `newschat: ${fixtures.length} fixtures × ${runs} runs from ${path}\n`,
  );

  await ensureTable();
  const arkNewsDailyShowId = await lookupShowId('Ark News Daily');
  const tools = buildFactCheckTools(arkNewsDailyShowId);

  let scored = 0;
  let errored = 0; // generation threw (e.g. gateway timeout) — excluded, reported
  let structurePass = 0;
  let factsPass = 0;
  let voicePass = 0;
  let cleanPass = 0;

  for (const fx of fixtures) {
    for (let r = 0; r < runs; r++) {
      let script: string;
      try {
        ({ script } = await draftNewsScript(fx.userPrompt, fx.date ?? today, tools));
      } catch (err) {
        errored += 1;
        console.log(
          `[ERROR    ] ${fx.id} run=${r + 1}/${runs} — ${String((err as Error)?.message ?? err).split('\n')[0]}`,
        );
        continue;
      }
      // An empty draft (writer ended on a tool call / produced no text) is a
      // non-result, not a 0/4 quality signal — tally as errored and skip.
      if (!script) {
        errored += 1;
        console.log(`[ERROR    ] ${fx.id} run=${r + 1}/${runs} — empty draft (no script text)`);
        continue;
      }
      const v = await judgeNewsScript(script);
      scored += 1;
      if (v.structureFormat) structurePass += 1;
      if (v.factuallyGrounded) factsPass += 1;
      if (v.showVoice) voicePass += 1;
      if (v.fullyEnglishClean) cleanPass += 1;
      console.log(
        `[${(v.structureFormat && v.factuallyGrounded && v.showVoice && v.fullyEnglishClean ? 'PASS' : 'FAIL').padEnd(5)}] ${fx.id} ` +
          `run=${r + 1}/${runs} structure=${v.structureFormat} facts=${v.factuallyGrounded} ` +
          `voice=${v.showVoice} clean=${v.fullyEnglishClean}`,
      );
      console.log(`        ${v.reasoning}`);
    }
  }

  const rate = (n: number) => (scored === 0 ? 0 : n / scored);
  const structureRate = rate(structurePass);
  const factsRate = rate(factsPass);
  const voiceRate = rate(voicePass);
  const cleanRate = rate(cleanPass);
  console.log(`\n---\nscored runs: ${scored} (errored, excluded: ${errored})`);
  console.log(`Structure & format rate: ${structureRate.toFixed(3)} (target >= ${structureTarget})`);
  console.log(`Factually-grounded rate: ${factsRate.toFixed(3)} (target >= ${factsTarget})`);
  console.log(`Show-voice rate:         ${voiceRate.toFixed(3)} (target >= ${voiceTarget})`);
  console.log(`Fully-English/clean rate:${cleanRate.toFixed(3)} (target >= ${cleanTarget})`);
  const pass =
    structureRate >= structureTarget &&
    factsRate >= factsTarget &&
    voiceRate >= voiceTarget &&
    cleanRate >= cleanTarget;
  console.log(pass ? 'PASS' : 'BELOW TARGET');
  return pass;
}

// One row per bucket: its default question file and its grader. `BUCKET` keys
// straight into this, so a new bucket is one line — and the usage string is
// generated from the keys rather than hand-maintained alongside them (it used
// to be a third place listing every bucket name, kept in sync by hand).
// Insertion order is the order shown in that usage string.
const BUCKETS: Record<
  string,
  { path: string; grade: (path: string) => Promise<boolean> }
> = {
  lookup: { path: 'eval/questions.jsonl', grade: gradeLookup },
  dossier: { path: 'eval/dossier.jsonl', grade: gradeDossier },
  refusal: { path: 'eval/refusal.jsonl', grade: gradeRefusal },
  aggregate: { path: 'eval/aggregate.jsonl', grade: gradeAggregate },
  clipdist: { path: 'eval/clip-distribution.jsonl', grade: gradeClipDistribution },
  translate: { path: 'eval/translate-adapt.jsonl', grade: gradeTranslateAdapt },
  newschat: { path: 'eval/news-chat.jsonl', grade: gradeNewsChat },
};

async function main() {
  const bucket = process.env.BUCKET ?? 'lookup';
  const entry = BUCKETS[bucket];
  if (!entry) {
    console.error(
      `unknown BUCKET=${bucket} (use ${Object.keys(BUCKETS).join('|')})`,
    );
    process.exit(2);
  }

  // An explicit argv path overrides the bucket's default question file.
  const pass = await entry.grade(resolve(process.argv[2] ?? entry.path));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
