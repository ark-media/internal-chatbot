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
 * Usage:
 *   pnpm eval:grade                  # default bucket=lookup
 *   BUCKET=dossier pnpm eval:grade
 *   BUCKET=refusal pnpm eval:grade
 *   BUCKET=aggregate pnpm eval:grade
 *   BUCKET=lookup pnpm eval:grade some/other.jsonl
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(__dirname, '..', '.env.local') });

import {
  countGuestAppearancesOnShow,
  getDossier,
  listSpeakers,
  listTopGuests,
  lookupCorpus,
  type CorpusFilters,
} from '../lib/retrieval';
import { routeQuery } from '../lib/router';
import { sql } from '../lib/db';

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

async function resolveShowId(name: string): Promise<number | null> {
  const rows = (await sql`
    SELECT show_id FROM shows
     WHERE LOWER(name) = LOWER(${name})
        OR LOWER(name) LIKE '%' || LOWER(${name}) || '%'
  ORDER BY (LOWER(name) = LOWER(${name})) DESC, name
     LIMIT 1
  `) as unknown as Array<{ show_id: number }>;
  return rows[0]?.show_id ?? null;
}

async function resolveShowGroupId(name: string): Promise<number | null> {
  const rows = (await sql`
    SELECT group_id FROM show_groups
     WHERE LOWER(name) = LOWER(${name})
        OR LOWER(name) LIKE '%' || LOWER(${name}) || '%'
  ORDER BY (LOWER(name) = LOWER(${name})) DESC, name
     LIMIT 1
  `) as unknown as Array<{ group_id: number }>;
  return rows[0]?.group_id ?? null;
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
      const showId = await resolveShowId(q.show);
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
      const sid = await resolveShowId(q.show);
      if (!sid) {
        console.log(`[MISS] ${q.id} — show not found: ${q.show}`);
        continue;
      }
      showIds = [sid];
    }
    if (q.showGroup) {
      const gid = await resolveShowGroupId(q.showGroup);
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

async function main() {
  const bucket = process.env.BUCKET ?? 'lookup';
  const defaultPaths: Record<string, string> = {
    lookup: 'eval/questions.jsonl',
    dossier: 'eval/dossier.jsonl',
    refusal: 'eval/refusal.jsonl',
    aggregate: 'eval/aggregate.jsonl',
  };
  const path = resolve(process.argv[2] ?? defaultPaths[bucket] ?? 'eval/questions.jsonl');

  let pass = false;
  switch (bucket) {
    case 'lookup':
      pass = await gradeLookup(path);
      break;
    case 'dossier':
      pass = await gradeDossier(path);
      break;
    case 'refusal':
      pass = await gradeRefusal(path);
      break;
    case 'aggregate':
      pass = await gradeAggregate(path);
      break;
    default:
      console.error(
        `unknown BUCKET=${bucket} (use lookup|dossier|refusal|aggregate)`,
      );
      process.exit(2);
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
