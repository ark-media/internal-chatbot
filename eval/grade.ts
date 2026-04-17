/**
 * Evaluate the chatbot across three query classes:
 *
 *   lookup  — hybrid RAG recall/MRR on expected episodes.
 *             File: eval/questions.jsonl
 *             Row:  { id, question, expected_episode_ids[], notes? }
 *
 *   dossier — completeness of getDossier for a named speaker.
 *             File: eval/dossier.jsonl
 *             Row:  { id, speaker_name, expected_min_episodes, filters?{showIds?,since?,until?}, notes? }
 *             Metric: episode-count recall vs expected_min_episodes.
 *
 *   refusal — router correctly flags out-of-scope questions.
 *             File: eval/refusal.jsonl
 *             Row:  { id, question, notes? }
 *             Metric: share of questions routed to out_of_scope.
 *
 * Usage:
 *   pnpm eval:grade                  # default bucket=lookup
 *   BUCKET=dossier pnpm eval:grade
 *   BUCKET=refusal pnpm eval:grade
 *   BUCKET=lookup pnpm eval:grade some/other.jsonl
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(__dirname, '..', '.env.local') });

import {
  getDossier,
  listSpeakers,
  lookupCorpus,
  type CorpusFilters,
} from '../lib/retrieval';
import { routeQuery } from '../lib/router';

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

async function main() {
  const bucket = process.env.BUCKET ?? 'lookup';
  const defaultPaths: Record<string, string> = {
    lookup: 'eval/questions.jsonl',
    dossier: 'eval/dossier.jsonl',
    refusal: 'eval/refusal.jsonl',
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
    default:
      console.error(`unknown BUCKET=${bucket} (use lookup|dossier|refusal)`);
      process.exit(2);
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
