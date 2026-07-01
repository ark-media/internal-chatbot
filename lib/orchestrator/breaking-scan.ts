// Breaking-news scan for Ark News Daily. During the 4–6pm pre-record window a
// writer uploads a finalized script and asks whether anything has broken since
// they locked it. This module runs the deterministic pipeline behind that
// scan: resolve the recency cutoff, discover post-lock candidates from the
// approved outlet set, then push them through the three gates (hard-exclusion,
// novelty-vs-coverage, significance) and route the survivors to Swap / Update /
// Can't-ignore suggestion tiers.
//
// The scan is an exception detector tuned against false alarms: a bad flag at
// 5:45pm that reopens a locked script is costly, so the bar is deliberately
// high and every gate is enforced against a schema, not prose.

import { generateObject } from 'ai';
import { z } from 'zod';

import {
  discoverCandidates,
  discoverXPosts,
  extractCandidates,
  substitutePaywallMirrors,
} from './source-gathering';
import { isApprovedSource } from '../news-sources';
import { parseScriptCoverage, type ScriptCoverage } from '../news-script';
import type { Article, Candidate } from './types';

// Model for the constrained gate classifiers. Sonnet is the accuracy floor for
// the editorial judgment these gates encode (occurrence-vs-information,
// narrative-reversal materiality); the cheap Haiku clustering pass isn't enough
// here. Kept as one constant so all gates move together.
const GATE_MODEL = 'anthropic/claude-sonnet-4-6';

// A scan candidate: a discovered story reference carrying the annotations the
// gates add as it flows through the pipeline. Starts life as a Candidate (or an
// extracted Article) and accretes gate verdicts downstream.
export type BreakingCandidate = Candidate & {
  // Full extracted body, when the candidate has been through extractCandidates.
  content?: string;
  // Set by filterByCutoff when the publication date is missing or unparseable:
  // the candidate is retained (not dropped) and deferred to Gate-3 judgment.
  dateUncertain?: boolean;
  // For X/Twitter candidates, the posting handle (e.g. "@BarakRavid"), needed
  // for the single-curated-source provisional rule in Gate 3.
  sourceHandle?: string;
  // Gate 0 (hard-exclusion) verdict.
  excluded?: boolean;
  exclusionReason?: string;
  // Gate 2 (novelty-vs-coverage) verdict.
  novelty?: Novelty;
  updatesBlock?: string;
  // Gate 3 (significance + corroboration) verdict.
  corroboration?: Corroboration;
  confidence?: Confidence;
  significance?: Significance;
  onBeat?: boolean;
  // True only for the enumerated global-shock categories — the sole signal that
  // can route an off-beat story to the Can't-ignore tier.
  globalShock?: boolean;
};

export type Novelty = 'NEW' | 'UPDATE' | 'DUPLICATE';
export type Confidence = 'confirmed' | 'provisional';
export type Significance = 'high' | 'medium' | 'low';
export type Corroboration = { independentSources: number; primarySource: string };

// Present a candidate list as a numbered index the classifier can refer back
// to, mirroring the orchestrator's clustering pass. Bodies are omitted — the
// gates classify from headline, outlet, and date.
function numberedCandidates(candidates: BreakingCandidate[]): string {
  return candidates
    .map((c, i) => {
      const date = c.publicationDate ? `, ${toDay(c.publicationDate) ?? c.publicationDate}` : '';
      const handle = c.sourceHandle ? ` via ${c.sourceHandle}` : '';
      return `${i}. [${c.source}${date}${handle}] ${c.title}`;
    })
    .join('\n');
}

// How far before "now" a manual lock-time override is allowed to reach. The
// pre-record window is ~2 hours; 12h is a generous ceiling that still catches
// AM/PM slips and stale-date typos.
const MAX_LOOKBACK_MS = 12 * 60 * 60 * 1000;

// Resolve the recency cutoff for a scan. Defaults to the request time
// (`now`); an explicit `lockedAt` override lets the writer say "I actually
// locked this at 4:15pm". Nonsensical overrides — in the future, or more than
// 12h before now — are rejected rather than silently trusted, since they're
// almost always an AM/PM slip or a wrong date.
export function resolveCutoff({ lockedAt, now }: { lockedAt?: string; now: string }): string {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    throw new Error(`resolveCutoff: invalid \`now\` timestamp: ${now}`);
  }
  if (!lockedAt) return now;

  const lockedMs = Date.parse(lockedAt);
  if (Number.isNaN(lockedMs)) {
    throw new Error(`resolveCutoff: invalid \`lockedAt\` timestamp: ${lockedAt}`);
  }
  if (lockedMs > nowMs) {
    throw new Error(
      'Lock time is in the future. Check AM/PM — the cutoff must be at or before now.',
    );
  }
  if (nowMs - lockedMs > MAX_LOOKBACK_MS) {
    throw new Error(
      'Lock time is more than 12 hours ago. Check the date — a scan cutoff that old is almost certainly a typo.',
    );
  }
  return new Date(lockedMs).toISOString();
}

// Reduce any date string to a comparable YYYY-MM-DD calendar day, or null when
// it can't be parsed. Tavily hands dates back in a few shapes (already-
// normalized YYYY-MM-DD from discovery, RFC-2822-ish from Extract), so accept
// both an ISO-date prefix and anything Date can parse.
function toDay(date: string | null | undefined): string | null {
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

// Extract the posting handle from a canonical X/Twitter status URL
// (/{handle}/status/{id}); null for anything else.
function xHandleOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const isX =
    host === 'x.com' || host === 'twitter.com' ||
    host.endsWith('.x.com') || host.endsWith('.twitter.com');
  if (!isX) return null;
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs.length < 3 || segs[1].toLowerCase() !== 'status') return null;
  return `@${segs[0]}`;
}

// Coarse recency filter. Drops candidates whose publication day is strictly
// before the cutoff day; keeps same-day-or-later candidates (day granularity
// can't prove a same-day story predates the lock, so it's deferred to the
// gates). Candidates with a missing or unparseable date are retained but
// flagged `dateUncertain: true` rather than silently dropped — the design
// intentionally hands undated stories to Gate-3 judgment. Pure and generic so
// it can run on raw candidates and on extracted articles alike.
export function filterByCutoff<T extends { publicationDate: string | null }>(
  candidates: T[],
  cutoff: string,
): Array<T & { dateUncertain?: boolean }> {
  const cutoffDay = toDay(cutoff);
  const out: Array<T & { dateUncertain?: boolean }> = [];
  for (const c of candidates) {
    const day = toDay(c.publicationDate);
    if (day === null) {
      out.push({ ...c, dateUncertain: true });
      continue;
    }
    if (cutoffDay !== null && day < cutoffDay) continue; // strictly before → drop
    out.push(c);
  }
  return out;
}

// Discover post-lock candidates for a scan. Reuses the orchestrator discovery
// stack — `discoverCandidates` (Tavily beat queries, already approval-filtered
// and paywall-mirrored) plus `discoverXPosts` (the curated handles) — swaps any
// residual hard-paywall URLs via `substitutePaywallMirrors`, filters to the
// cutoff, then verifies + extracts survivors with `extractCandidates` (which
// runs `verifyOrRecover` under the hood). Returns approved-source candidates
// only, with X handles preserved and undated stories flagged.
export async function discoverBreakingCandidates(opts: {
  today: string;
  cutoff: string;
  signal?: AbortSignal;
}): Promise<BreakingCandidate[]> {
  const { today, cutoff, signal } = opts;

  const [beat, xPosts] = await Promise.all([
    discoverCandidates(today, '', signal),
    // X discovery is best-effort — a grounded-Gemini outage shouldn't sink the
    // whole scan, which still has the beat outlets.
    discoverXPosts(today, signal).catch(() => [] as Candidate[]),
  ]);

  // Merge + dedupe by URL, remembering which URLs came from an X handle so the
  // handle survives extraction (extractCandidates returns bare Articles).
  const seen = new Set<string>();
  const merged: Candidate[] = [];
  const handleByUrl = new Map<string, string>();
  for (const c of [...beat, ...xPosts]) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    merged.push(c);
    const handle = xHandleOf(c.url);
    if (handle) handleByUrl.set(c.url, handle);
  }

  // Belt-and-suspenders: everything downstream assumes approved sources only.
  const approved = merged.filter((c) => isApprovedSource(c.url));

  // Explicit paywall substitution (idempotent for the already-mirrored beat
  // pool and the paywall-free X posts) and coarse cutoff filter before paying
  // for extraction.
  const mirrored = await substitutePaywallMirrors(approved, signal);
  const withinCutoff = filterByCutoff(mirrored, cutoff);

  // Verify + extract the survivors into full articles (refined dates + body).
  const articles: Article[] = await extractCandidates(withinCutoff, today, signal);

  // Re-apply the cutoff with the refined extraction dates, re-attach handles,
  // and drop anything that somehow left the approved set.
  const refined = filterByCutoff(articles, cutoff).filter((a) => isApprovedSource(a.url));
  return refined.map((a): BreakingCandidate => {
    const handle = handleByUrl.get(a.url) ?? xHandleOf(a.url) ?? undefined;
    return {
      title: a.title,
      url: a.url,
      source: a.source,
      publicationDate: a.publicationDate,
      isFlagged: a.isFlagged,
      content: a.content,
      dateUncertain: a.dateUncertain,
      ...(handle ? { sourceHandle: handle } : {}),
    };
  });
}

// -- Gate 0: hard-exclusion classifier ---------------------------------------
// The first gate, run before any significance work. It suppresses whole
// categories that are never "breaking" for this show: opinion/analysis,
// scheduled events that proceed as scheduled, incremental attrition, routine
// markets/economic data, and recirculated coverage of old events (deduped by
// event, not article date). The rule is defined by OCCURRENCE, not
// INFORMATION: a scheduled event that yields only expected content is
// excluded, but unexpected reversal-grade information the event produces is
// not.

export const exclusionVerdictSchema = z.object({
  index: z.number().int().min(0).describe('Index into the numbered candidate list'),
  excluded: z.boolean().describe('True if the candidate falls in a hard-excluded category'),
  exclusionReason: z
    .string()
    .optional()
    .describe('Short reason when excluded, e.g. "op-ed", "routine market move", "old event re-reported"'),
});

export const exclusionSchema = z.object({
  verdicts: z.array(exclusionVerdictSchema),
});

export type ExclusionResult = z.infer<typeof exclusionSchema>;

const GATE0_SYSTEM = `You are the hard-exclusion gate for a breaking-news scan on Ark News Daily (Israel, Jews, and the Middle East). Tag each candidate excluded=true if and only if it falls into a category that is NEVER breaking news, before any significance judgment:

- Opinion, analysis, op-eds, columns, editorials.
- Scheduled events that proceed AS SCHEDULED and yield only the expected content.
- Incremental attrition or routine tallies with no step-change (e.g. "another day of strikes", a body count ticking up by the usual amount).
- Routine markets / economic data (index moves, currency ticks, scheduled data releases).
- Recirculated coverage of an OLD event — key on the underlying event, not the article's publish date, so a fresh write-up of a months-old event is still excluded.

CRITICAL — occurrence vs. information. The exclusion is defined by the OCCURRENCE, not the INFORMATION the occurrence produces:

- Scheduled-speech resignation: A prime minister gives a long-scheduled Knesset address. If the speech proceeds as planned and says the expected things, EXCLUDE it (scheduled event, proceeding as scheduled). But if, within that scheduled speech, the prime minister unexpectedly announces their resignation, that is reversal-grade new information — KEEP it (excluded=false). The scheduled occurrence is excluded; the surprise information it produces is not.
- Expected verdict: A court delivers a ruling on its scheduled date. If the verdict is the widely-expected outcome, the occurrence is scheduled-as-planned and adds nothing — EXCLUDE. If the verdict is a surprise reversal of what everyone expected, KEEP.

When in doubt about whether something is reversal-grade information, do NOT exclude — later gates will judge significance. Only exclude what is unambiguously in the categories above.`;

// Classify each candidate as hard-excluded or kept. Returns the same
// candidates tagged with `excluded`/`exclusionReason`; unmentioned candidates
// default to kept (excluded=false) so the gate never silently drops a story it
// forgot to rate. Excluded candidates are filtered out by the pipeline before
// later gates run.
export async function classifyExclusions(
  candidates: BreakingCandidate[],
  signal?: AbortSignal,
): Promise<BreakingCandidate[]> {
  if (candidates.length === 0) return [];

  const { object } = await generateObject({
    model: GATE_MODEL,
    schema: exclusionSchema,
    system: GATE0_SYSTEM,
    prompt: `Candidates:\n${numberedCandidates(candidates)}\n\nReturn one verdict per candidate index.`,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    abortSignal: signal,
  });

  return applyExclusions(candidates, object);
}

// Fold a classifier result back onto the candidate list by index. Pure and
// exported so the pipeline and tests can tag without a live model call.
export function applyExclusions(
  candidates: BreakingCandidate[],
  result: ExclusionResult,
): BreakingCandidate[] {
  const byIndex = new Map(result.verdicts.map((v) => [v.index, v]));
  return candidates.map((c, i) => {
    const v = byIndex.get(i);
    if (!v) return { ...c, excluded: false };
    return {
      ...c,
      excluded: v.excluded,
      ...(v.excluded && v.exclusionReason ? { exclusionReason: v.exclusionReason } : {}),
    };
  });
}

// Drop the candidates Gate 0 hard-excluded. Pure; the pipeline calls this
// between Gate 0 and Gate 2 so excluded stories never reach later gates.
export function dropExcluded(candidates: BreakingCandidate[]): BreakingCandidate[] {
  return candidates.filter((c) => !c.excluded);
}

// -- Gate 2: novelty diff against the coverage profile ------------------------
// Compares surviving candidates against the finalized script's coverage
// profile (its A/B/C/D blocks + cited sources) and labels each:
//   NEW       — event/topic absent from the script
//   UPDATE    — a development that overtakes a story already in the script
//   DUPLICATE — already covered, no material change → dropped, never surfaced
// UPDATE only qualifies on narrative reversal or order-of-magnitude change:
// the script's existing line is now wrong, misleading, or overtaken. Any new
// fact is NOT enough.

export const noveltyVerdictSchema = z.object({
  index: z.number().int().min(0).describe('Index into the numbered candidate list'),
  novelty: z.enum(['NEW', 'UPDATE', 'DUPLICATE']),
  updatesBlock: z
    .string()
    .optional()
    .describe('For UPDATE only: the block label (A/B/C/D) whose story this overtakes'),
});

export const noveltySchema = z.object({
  verdicts: z.array(noveltyVerdictSchema),
});

export type NoveltyResult = z.infer<typeof noveltySchema>;

const GATE2_SYSTEM = `You are the novelty gate for a breaking-news scan on Ark News Daily. You are given the coverage profile of a finalized script — its story blocks and the sources it already cites — and a list of newly-discovered candidate stories. Label each candidate against what the script already covers:

- NEW — the event or topic is absent from the script's blocks.
- UPDATE — a development to a story the script ALREADY covers, but only when it overtakes the script's existing line (narrative reversal or order-of-magnitude change). Name the block label (A/B/C/D) it updates in updatesBlock.
- DUPLICATE — the script already covers this and nothing material has changed. These are dropped and never shown to the writer.

UPDATE is a high bar. It requires the change to invalidate, mislead, or overtake the script's existing line — not merely add a new fact. Examples:

- Ceasefire, MATERIAL: The script's A block says a ceasefire is holding. The ceasefire has now COLLAPSED and fighting resumed. That makes the script's line wrong — UPDATE (updatesBlock: "A").
- Ceasefire, IMMATERIAL: The script already covers the ceasefire. The only new development is that the next round of talks has been scheduled. The script's line still stands — DUPLICATE.
- Casualty toll, MATERIAL: The script says a strike killed 12. The toll is now 40-plus AND a senior commander is confirmed among the dead. That is an order-of-magnitude and narrative change — UPDATE.
- Casualty toll, IMMATERIAL: The script says 12 killed; the toll has ticked to 14. The line still stands — DUPLICATE.

When a candidate could be NEW or UPDATE, prefer UPDATE only if it clearly maps to an existing block; otherwise NEW.`;

function renderCoverage(coverage: ScriptCoverage): string {
  const blocks = coverage.blocks
    .map((b) => `[${b.label} BLOCK] ${b.text.replace(/\s+/g, ' ').trim().slice(0, 400)}`)
    .join('\n');
  const sources = coverage.sources.length
    ? coverage.sources.map((s) => `- ${s.title}${s.url ? ` (${s.url})` : ''}`).join('\n')
    : '(none cited)';
  return `Story blocks:\n${blocks || '(no blocks parsed)'}\n\nAlready-cited sources:\n${sources}`;
}

// Classify each candidate NEW / UPDATE / DUPLICATE against the coverage
// profile. Returns the candidates tagged; DUPLICATEs are dropped by the
// pipeline (dropDuplicates) after tagging.
export async function classifyNovelty(
  candidates: BreakingCandidate[],
  coverage: ScriptCoverage,
  signal?: AbortSignal,
): Promise<BreakingCandidate[]> {
  if (candidates.length === 0) return [];

  const { object } = await generateObject({
    model: GATE_MODEL,
    schema: noveltySchema,
    system: GATE2_SYSTEM,
    prompt: `Coverage profile:\n${renderCoverage(coverage)}\n\nCandidates:\n${numberedCandidates(candidates)}\n\nReturn one verdict per candidate index.`,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    abortSignal: signal,
  });

  return applyNovelty(candidates, object);
}

// Fold a novelty result onto the candidate list by index. Unrated candidates
// default to NEW (surface rather than silently drop). Pure and exported for the
// pipeline + tests.
export function applyNovelty(
  candidates: BreakingCandidate[],
  result: NoveltyResult,
): BreakingCandidate[] {
  const byIndex = new Map(result.verdicts.map((v) => [v.index, v]));
  return candidates.map((c, i) => {
    const v = byIndex.get(i);
    const novelty: Novelty = v?.novelty ?? 'NEW';
    return {
      ...c,
      novelty,
      ...(novelty === 'UPDATE' && v?.updatesBlock ? { updatesBlock: v.updatesBlock } : {}),
    };
  });
}

// Drop DUPLICATE candidates so they are never surfaced. Pure; the pipeline runs
// this immediately after classifyNovelty.
export function dropDuplicates(candidates: BreakingCandidate[]): BreakingCandidate[] {
  return candidates.filter((c) => c.novelty !== 'DUPLICATE');
}

// -- Gate 3: significance + corroboration grading ----------------------------
// Grades the significance of the surviving NEW/UPDATE candidates and how well
// each is corroborated. Corroboration counts DISTINCT ORIGINATION, not distinct
// URLs: N outlets all citing one journalist is ONE source. A story needs ≥2
// independently-reporting tier-1 outlets to be firmly significant (confirmed);
// a single curated high-trust X handle (Segal, Ravid, Kadosh, …) counts as
// provisional — enough for an Update flag or a low-confidence Swap, never a
// Can't-ignore. The grader also judges the story against Ark's beat (on-beat vs
// off-beat).

export const significanceVerdictSchema = z.object({
  index: z.number().int().min(0).describe('Index into the numbered candidate list'),
  independentSources: z
    .number()
    .int()
    .min(0)
    .describe('Count of DISTINCT originating sources reporting this story — identify the underlying source, do not count bylines/URLs'),
  primarySource: z
    .string()
    .describe('The underlying origination the reporting traces back to (outlet or journalist)'),
  confidence: z.enum(['confirmed', 'provisional']),
  significance: z.enum(['high', 'medium', 'low']),
  onBeat: z.boolean().describe("True if the story is on Ark's beat: Israel, Jews, and the Middle East"),
  globalShock: z
    .boolean()
    .optional()
    .describe('True ONLY for an enumerated global-shock category: head-of-state death, mass-casualty terror/disaster, war between major powers, or a US election/constitutional shock'),
});

export const significanceSchema = z.object({
  verdicts: z.array(significanceVerdictSchema),
});

export type SignificanceResult = z.infer<typeof significanceSchema>;

const GATE3_SYSTEM = `You are the significance-and-corroboration gate for a breaking-news scan on Ark News Daily (beat: Israel, Jews, and the Middle East).

For each candidate, grade:
- corroboration.independentSources — count DISTINCT ORIGINATION, not distinct URLs. If four outlets all cite the same journalist's scoop, that is ONE independent source, not four. Identify the underlying source the reporting traces back to; do not count bylines.
- primarySource — the underlying origination (the outlet or journalist the story traces to).
- confidence — "confirmed" when ≥2 independently-reporting tier-1 outlets carry it (Reuters, AP, Bloomberg, NYT, WaPo, WSJ, FT, Guardian, BBC, Times of Israel, Haaretz, and the show's other approved outlets). "provisional" when it rests on a single source — especially a single curated X handle — however high-trust.
- significance — high / medium / low editorial weight, judged against Ark's beat and the day's context.
- onBeat — true if the story is on Ark's beat (Israel, Jews, the Middle East), false if it is off-beat (e.g. a global-shock event elsewhere).
- globalShock — true ONLY for one of the enumerated global-shock categories: the death of a head of state, a mass-casualty terror attack or disaster, war breaking out between major powers, or a US election / constitutional shock. Everything else is false, on-beat or not.

A single curated X handle (Amit Segal, Barak Ravid, Doron Kadosh, and the other listed correspondents) is high-trust but still a SINGLE source: grade it provisional. Never grade a single-source story confirmed.`;

// Grade each surviving candidate. Returns the candidates tagged with
// corroboration / confidence / significance / onBeat; pure post-processing
// (collapseCorroboration, single-X-provisional) is applied so deterministic
// rules aren't left to the model alone.
export async function gradeSignificance(
  candidates: BreakingCandidate[],
  signal?: AbortSignal,
): Promise<BreakingCandidate[]> {
  if (candidates.length === 0) return [];

  const { object } = await generateObject({
    model: GATE_MODEL,
    schema: significanceSchema,
    system: GATE3_SYSTEM,
    prompt: `Candidates:\n${numberedCandidates(candidates)}\n\nReturn one verdict per candidate index.`,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    abortSignal: signal,
  });

  return collapseCorroboration(applySignificance(candidates, object));
}

// True when a candidate's story rests on a single curated X handle — an X post
// with no independent corroboration beyond that one handle.
export function restsOnSingleCuratedXSource(c: BreakingCandidate): boolean {
  return Boolean(c.sourceHandle) && (c.corroboration?.independentSources ?? 1) <= 1;
}

// Fold a significance result onto the candidate list by index, then enforce the
// single-curated-X-source provisional rule deterministically (the model is told
// the rule, but a schema can't guarantee it). Pure and exported for the
// pipeline + tests.
export function applySignificance(
  candidates: BreakingCandidate[],
  result: SignificanceResult,
): BreakingCandidate[] {
  const byIndex = new Map(result.verdicts.map((v) => [v.index, v]));
  return candidates.map((c, i) => {
    const v = byIndex.get(i);
    if (!v) return c;
    const tagged: BreakingCandidate = {
      ...c,
      corroboration: { independentSources: v.independentSources, primarySource: v.primarySource },
      confidence: v.confidence,
      significance: v.significance,
      onBeat: v.onBeat,
      globalShock: v.globalShock ?? false,
    };
    // A single curated X handle is provisional no matter what the model said.
    if (restsOnSingleCuratedXSource(tagged)) tagged.confidence = 'provisional';
    return tagged;
  });
}

// Collapse over-counted corroboration: candidates whose reporting traces to the
// SAME primarySource are not independent of each other, so any such group is
// pinned to independentSources:1. Pure; a defensive backstop on top of the
// model's own instruction to count origination rather than bylines.
export function collapseCorroboration(candidates: BreakingCandidate[]): BreakingCandidate[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const key = c.corroboration?.primarySource;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return candidates.map((c) => {
    const key = c.corroboration?.primarySource;
    if (!c.corroboration || !key) return c;
    if ((counts.get(key) ?? 0) > 1) {
      return { ...c, corroboration: { ...c.corroboration, independentSources: 1 } };
    }
    return c;
  });
}

// -- Tier routing → Swap / Update / Can't-ignore -----------------------------
// Routes graded candidates to output tiers, ranks them, and caps the list.
//   Swap        — NEW + on-beat + significant, framed against the weakest block.
//   Update      — a material UPDATE to an in-script story.
//   Can't-ignore — global-shock only (the sole off-beat-eligible tier), and it
//                  requires confidence:'confirmed'.
// Off-beat candidates cannot reach Swap/Update. Provisional (single-source)
// items may appear as Swap/Update but are flagged unconfirmed. Results are
// ordered Can't-ignore > Update > Swap, then by significance/confidence, and
// capped at 5 with suppressedCount reporting the remainder.

export type Tier = "Can't-ignore" | 'Update' | 'Swap';

export type SuggestionSource = { title: string; url: string; handle?: string };

export type Suggestion = {
  tier: Tier;
  headline: string;
  whyItQualifies: string;
  sources: SuggestionSource[];
  confidence: Confidence;
  // Swap: the weakest block it would displace (C by design). Update: the block
  // it overtakes. Absent for Can't-ignore.
  block?: string;
  // True when the item rests on a single (provisional) source.
  flaggedUnconfirmed?: boolean;
};

export type ScanResult = {
  suggestions: Suggestion[];
  suppressedCount: number;
  cutoff: string;
};

// The C block is the shortest, softest close and is the weakest by design — the
// natural slot a Swap candidate would displace. (v1 heuristic; the writer can
// override which block they consider most droppable in a later version.)
const WEAKEST_BLOCK = 'C';
const MAX_SUGGESTIONS = 5;

const SIGNIFICANCE_RANK: Record<Significance, number> = { high: 3, medium: 2, low: 1 };

// Decide the tier a graded candidate routes to, or null when it qualifies for
// none. Can't-ignore is the only tier an off-beat story can reach, and only
// when it is a confirmed global-shock event.
function tierFor(c: BreakingCandidate): Tier | null {
  if (c.globalShock === true && c.confidence === 'confirmed') return "Can't-ignore";
  // Every other tier requires the story to be on Ark's beat.
  if (!c.onBeat) return null;
  if (c.novelty === 'UPDATE') return 'Update';
  if (c.novelty === 'NEW') return 'Swap';
  return null;
}

function whyItQualifies(c: BreakingCandidate, tier: Tier): string {
  const corr = c.corroboration;
  const sourcing = corr
    ? `${corr.independentSources} independent source${corr.independentSources === 1 ? '' : 's'} (${corr.primarySource})`
    : 'sourcing pending';
  if (tier === "Can't-ignore") {
    return `Global-shock event the broadcast can't omit. Confirmed; ${sourcing}.`;
  }
  if (tier === 'Update') {
    return `Overtakes the ${c.updatesBlock ?? '?'} block's story — ${c.significance ?? 'medium'} significance, ${sourcing}.`;
  }
  return `New on-beat story, ${c.significance ?? 'medium'} significance, ${sourcing}.`;
}

function toSuggestion(c: BreakingCandidate, tier: Tier): Suggestion {
  const confidence: Confidence = c.confidence ?? 'provisional';
  const source: SuggestionSource = {
    title: c.source || c.title,
    url: c.url,
    ...(c.sourceHandle ? { handle: c.sourceHandle } : {}),
  };
  const block =
    tier === 'Swap' ? WEAKEST_BLOCK : tier === 'Update' ? c.updatesBlock : undefined;
  return {
    tier,
    headline: c.title,
    whyItQualifies: whyItQualifies(c, tier),
    sources: [source],
    confidence,
    ...(block ? { block } : {}),
    ...(confidence === 'provisional' ? { flaggedUnconfirmed: true } : {}),
  };
}

const TIER_RANK: Record<Tier, number> = { "Can't-ignore": 3, Update: 2, Swap: 1 };

// Route, rank, and cap. `cutoff` is echoed back so the UI can render
// "scanning since [cutoff]" and the empty state. An input with no qualifying
// candidates returns suggestions:[] — the explicit "nothing clears the bar"
// result the UI renders rather than manufacturing a flag.
export function routeTiers(gradedCandidates: BreakingCandidate[], cutoff: string): ScanResult {
  const routed = gradedCandidates
    .map((c) => {
      const tier = tierFor(c);
      return tier ? { c, tier } : null;
    })
    .filter((x): x is { c: BreakingCandidate; tier: Tier } => x !== null);

  routed.sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
    const sa = SIGNIFICANCE_RANK[a.c.significance ?? 'low'];
    const sb = SIGNIFICANCE_RANK[b.c.significance ?? 'low'];
    if (sa !== sb) return sb - sa;
    // Confirmed outranks provisional at equal significance.
    const ca = a.c.confidence === 'confirmed' ? 1 : 0;
    const cb = b.c.confidence === 'confirmed' ? 1 : 0;
    return cb - ca;
  });

  const suggestions = routed.slice(0, MAX_SUGGESTIONS).map(({ c, tier }) => toSuggestion(c, tier));
  const suppressedCount = Math.max(0, routed.length - MAX_SUGGESTIONS);
  return { suggestions, suppressedCount, cutoff };
}

// -- Pipeline: runBreakingScan -----------------------------------------------
// The single entry point behind the scanBreakingNews tool. Parses the coverage
// profile, resolves the cutoff, discovers post-lock candidates, and runs the
// gates in strict order — Gate 0 (exclusion) → Gate 2 (novelty) → Gate 3
// (significance) → tier routing — so excluded and DUPLICATE candidates can
// never reach the returned suggestions. Returns the routeTiers result, which
// echoes the resolved cutoff.

// The gate/discovery functions are injectable so the pipeline can be tested
// end-to-end with stubs, no live model or network calls. Production uses the
// real implementations.
export type BreakingScanDeps = {
  discover: (opts: { today: string; cutoff: string; signal?: AbortSignal }) => Promise<BreakingCandidate[]>;
  classifyExclusions: (candidates: BreakingCandidate[], signal?: AbortSignal) => Promise<BreakingCandidate[]>;
  classifyNovelty: (
    candidates: BreakingCandidate[],
    coverage: ScriptCoverage,
    signal?: AbortSignal,
  ) => Promise<BreakingCandidate[]>;
  gradeSignificance: (candidates: BreakingCandidate[], signal?: AbortSignal) => Promise<BreakingCandidate[]>;
};

const defaultDeps: BreakingScanDeps = {
  discover: discoverBreakingCandidates,
  classifyExclusions,
  classifyNovelty,
  gradeSignificance,
};

export async function runBreakingScan(
  opts: { script: string; lockedAt?: string; today: string; now: string; signal?: AbortSignal },
  deps: BreakingScanDeps = defaultDeps,
): Promise<ScanResult> {
  const { script, lockedAt, today, now, signal } = opts;

  const coverage = parseScriptCoverage(script);
  const cutoff = resolveCutoff({ lockedAt, now });

  const discovered = await deps.discover({ today, cutoff, signal });

  // Gate 0: hard-exclusion. Excluded candidates are dropped before any later
  // gate sees them.
  const kept = dropExcluded(await deps.classifyExclusions(discovered, signal));

  // Gate 2: novelty vs. coverage. DUPLICATEs are dropped and never surfaced.
  const novel = dropDuplicates(await deps.classifyNovelty(kept, coverage, signal));

  // Gate 3: significance + corroboration.
  const graded = await deps.gradeSignificance(novel, signal);

  // Tier routing echoes the resolved cutoff back in the result.
  return routeTiers(graded, cutoff);
}
