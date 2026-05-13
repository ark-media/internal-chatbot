import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateObject } from 'ai';
import { z } from 'zod';

import { sql } from './db';
import { listSpeakers, type SpeakerSummary } from './retrieval';

export type RouteIntent = 'lookup' | 'dossier' | 'disambiguate' | 'out_of_scope';

export type RoutedQuery = {
  intent: RouteIntent;
  showIds: number[];
  showGroupIds: number[];
  speakerIds: number[];
  since: string | null;
  until: string | null;
  subqueries: string[];
  topic: string | null;
  disambiguation?: { name: string; candidates: SpeakerSummary[] };
  rationale: string | null;
};

// -- Router context (cached in-process) --------------------------------------

type RouterContext = {
  shows: Array<{
    showId: number;
    name: string;
    groupId: number | null;
    groupName: string | null;
  }>;
  showGroups: Array<{ groupId: number; name: string; members: string[] }>;
  topSpeakers: Array<{
    speakerId: number;
    canonicalName: string;
    aliases: string[];
  }>;
};

const CONTEXT_TTL_MS = 5 * 60 * 1000;
let contextCache: { data: RouterContext; fetchedAt: number } | null = null;

async function getRouterContext(): Promise<RouterContext> {
  const now = Date.now();
  if (contextCache && now - contextCache.fetchedAt < CONTEXT_TTL_MS) {
    return contextCache.data;
  }
  const [showRows, groupRows, speakerRows] = (await Promise.all([
    sql`
      SELECT sh.show_id, sh.name, sh.group_id, sg.name AS group_name
        FROM shows sh
        LEFT JOIN show_groups sg ON sg.group_id = sh.group_id
    ORDER BY sh.name
    `,
    sql`
      SELECT sg.group_id, sg.name,
             COALESCE(
               array_agg(sh.name ORDER BY sh.name) FILTER (WHERE sh.name IS NOT NULL),
               ARRAY[]::text[]
             ) AS members
        FROM show_groups sg
        LEFT JOIN shows sh ON sh.group_id = sg.group_id
    GROUP BY sg.group_id, sg.name
    ORDER BY sg.name
    `,
    sql`
      SELECT sp.speaker_id, sp.canonical_name,
             COALESCE(
               array_agg(a.alias_display ORDER BY a.alias_display)
                 FILTER (WHERE LOWER(a.alias_display) <> LOWER(sp.canonical_name)),
               ARRAY[]::text[]
             ) AS aliases
        FROM speakers sp
        LEFT JOIN speaker_aliases a ON a.speaker_id = sp.speaker_id
       WHERE sp.review_status = 'canonical'
         AND sp.include_in_content = TRUE
    GROUP BY sp.speaker_id, sp.canonical_name
    ORDER BY sp.canonical_name
    `,
  ])) as unknown as [
    Array<{ show_id: number; name: string; group_id: number | null; group_name: string | null }>,
    Array<{ group_id: number; name: string; members: string[] }>,
    Array<{ speaker_id: number; canonical_name: string; aliases: string[] }>,
  ];

  const data: RouterContext = {
    shows: showRows.map((r) => ({
      showId: r.show_id,
      name: r.name,
      groupId: r.group_id,
      groupName: r.group_name,
    })),
    showGroups: groupRows.map((r) => ({
      groupId: r.group_id,
      name: r.name,
      members: r.members,
    })),
    topSpeakers: speakerRows.map((r) => ({
      speakerId: r.speaker_id,
      canonicalName: r.canonical_name,
      aliases: r.aliases,
    })),
  };
  contextCache = { data, fetchedAt: now };
  return data;
}

// -- LLM schema --------------------------------------------------------------

const routerSchema = z.object({
  intent: z
    .enum(['lookup', 'dossier', 'disambiguate', 'out_of_scope'])
    .describe(
      'lookup = single/multi-fact question, use RAG. dossier = compile everything a named speaker said (comparisons, contradictions, positions over time). disambiguate = user referenced a person ambiguously and we cannot tell which. out_of_scope = unrelated to the podcast corpus.',
    ),
  showHints: z
    .array(z.string())
    .describe(
      'Show names the question is about (exact from the known list). Empty if no show is specified.',
    ),
  showGroupHints: z
    .array(z.string())
    .describe(
      'Show group names the question is about (exact from the known list). Use when a question spans sibling shows (e.g. Call me Back family).',
    ),
  speakerHints: z
    .array(z.string())
    .describe(
      'Person name(s) mentioned in the question. Use canonical spelling from the known list when possible; otherwise the user-provided spelling.',
    ),
  since: z
    .string()
    .nullable()
    .describe('Lower-bound date YYYY-MM-DD. Resolve relative dates against `today`.'),
  until: z.string().nullable().describe('Upper-bound date YYYY-MM-DD.'),
  subqueries: z
    .array(z.string())
    .describe(
      'For lookup intent: 1-3 retrieval queries (first MUST be a faithful paraphrase). For dossier: a single paraphrase. For out_of_scope or disambiguate: a single entry echoing the user question. Never return an empty array.',
    ),
  topic: z
    .string()
    .nullable()
    .describe(
      'For dossier intent: optional FTS filter on the turns (e.g. "Iran nuclear", "AI regulation"). Null otherwise.',
    ),
  rationale: z
    .string()
    .nullable()
    .describe('One short sentence explaining the route choice. For debugging.'),
});

// -- Router prompt -----------------------------------------------------------

let overviewsCache: string | null = null;
function loadShowOverviews(): string {
  if (overviewsCache !== null) return overviewsCache;
  try {
    overviewsCache = readFileSync(join(process.cwd(), 'data', 'shows.md'), 'utf8');
  } catch {
    overviewsCache = '';
  }
  return overviewsCache;
}

function buildSystemPrompt(ctx: RouterContext, today: string): string {
  const showList = ctx.shows
    .map(
      (s) =>
        `- ${s.name}${s.groupName ? ` (group: ${s.groupName})` : ''}`,
    )
    .join('\n');
  const groupList =
    ctx.showGroups.length > 0
      ? ctx.showGroups
          .map((g) => `- ${g.name}: ${g.members.join(', ')}`)
          .join('\n')
      : '(none)';
  const speakerList = ctx.topSpeakers
    .map(
      (s) =>
        `- ${s.canonicalName}${s.aliases.length ? ` (aka ${s.aliases.join(', ')})` : ''}`,
    )
    .join('\n');
  const overviews = loadShowOverviews();

  return `You route questions over the Ark Media podcast archive. Today is ${today}.

# Known shows
${showList || '(none)'}

# Show groups
${groupList}

# Known speakers (canonical names)
${speakerList || '(none)'}

${overviews}

# Intents
- lookup: user wants specific facts, excerpts, OR archive-level aggregates (who are the top/most frequent guests on a show, how many times a person appeared, episode counts, guest lists). Use subqueries for hybrid retrieval even on aggregate questions — a downstream tool (topGuests / countGuestAppearances) will handle the aggregation, and noisy subqueries are harmless.
- dossier: user wants to compile everything a named speaker has said (e.g. "what has X said about Y", "has Z contradicted themselves", "summarize W's positions"). Requires at least one speakerHint.
- disambiguate: the user referenced a speaker whose name matches multiple known canonicals, OR the question targets a speaker but is underspecified (e.g. "Segal" could be multiple people). Fill speakerHints with the ambiguous name.
- out_of_scope: the question is clearly unrelated to Ark Media, its shows, its people, or its archive (e.g. "what's the weather", "write me a poem"). Questions ABOUT the archive's structure — guests, hosts, frequency, rankings, counts, episode listings — are NEVER out_of_scope; route them as lookup.

# Rules
- Prefer showGroupHints over showHints when the question spans a family (e.g. Dan Senor across Call me Back + Inside Call me Back).
- Speaker names: use canonical spelling from the list when the user's wording matches. If not a clear match, leave the user's spelling.
- Date filters: only set when the user asked about a time window. Do not set for generic recency words like "recently" unless the user gave a concrete hint.
- Intent dossier implies the question is about one speaker's body of content across multiple episodes/shows — not a one-off fact lookup.`;
}

// -- Resolve hints → IDs ------------------------------------------------------

function resolveShowIds(hints: string[], ctx: RouterContext): number[] {
  const byLower = new Map(ctx.shows.map((s) => [s.name.toLowerCase(), s.showId]));
  const out = new Set<number>();
  for (const h of hints) {
    const id = byLower.get(h.toLowerCase());
    if (id != null) out.add(id);
  }
  return Array.from(out);
}

function resolveShowGroupIds(hints: string[], ctx: RouterContext): number[] {
  const byLower = new Map(
    ctx.showGroups.map((g) => [g.name.toLowerCase(), g.groupId]),
  );
  const out = new Set<number>();
  for (const h of hints) {
    const id = byLower.get(h.toLowerCase());
    if (id != null) out.add(id);
  }
  return Array.from(out);
}

async function resolveSpeakerHints(
  hints: string[],
): Promise<
  | { kind: 'ok'; speakerIds: number[] }
  | { kind: 'ambiguous'; name: string; candidates: SpeakerSummary[] }
  | { kind: 'empty' }
> {
  if (hints.length === 0) return { kind: 'empty' };
  const speakerIds: number[] = [];
  for (const name of hints) {
    const matches = await listSpeakers({
      nameLike: name,
      includeUnreviewed: false,
      limit: 5,
    });
    if (matches.length === 0) {
      // ignore silently — name unknown to corpus, no ID to filter on
      continue;
    }
    if (matches.length === 1) {
      speakerIds.push(matches[0].speakerId);
      continue;
    }
    // Prefer an exact canonical match if one of the candidates has it.
    const exact = matches.find(
      (m) => m.canonicalName.toLowerCase() === name.toLowerCase(),
    );
    if (exact) {
      speakerIds.push(exact.speakerId);
      continue;
    }
    return { kind: 'ambiguous', name, candidates: matches };
  }
  return { kind: 'ok', speakerIds };
}

// -- routeQuery --------------------------------------------------------------

export async function routeQuery(
  userText: string,
  today: string,
): Promise<RoutedQuery> {
  const ctx = await getRouterContext();

  const { object } = await generateObject({
    model: 'anthropic/claude-haiku-4-5',
    schema: routerSchema,
    system: {
      role: 'system',
      content: buildSystemPrompt(ctx, today),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt: userText,
    temperature: 0,
  });

  const showIds = resolveShowIds(object.showHints, ctx);
  const showGroupIds = resolveShowGroupIds(object.showGroupHints, ctx);
  const speakerRes = await resolveSpeakerHints(object.speakerHints);

  // Defensive: enforce the 1–3 subquery constraint in code (schema can't encode it for Anthropic).
  const subqueries =
    object.subqueries.length === 0
      ? [userText]
      : object.subqueries.slice(0, 3);

  let intent: RouteIntent = object.intent;
  let speakerIds: number[] = [];
  let disambiguation: RoutedQuery['disambiguation'];

  if (speakerRes.kind === 'ambiguous') {
    intent = 'disambiguate';
    disambiguation = {
      name: speakerRes.name,
      candidates: speakerRes.candidates,
    };
  } else if (speakerRes.kind === 'ok') {
    speakerIds = speakerRes.speakerIds;
  }

  // A dossier with zero resolved speakers can't be built — fall back to lookup.
  if (intent === 'dossier' && speakerIds.length === 0 && !disambiguation) {
    intent = 'lookup';
  }

  return {
    intent,
    showIds,
    showGroupIds,
    speakerIds,
    since: object.since,
    until: object.until,
    subqueries,
    topic: object.topic,
    disambiguation,
    rationale: object.rationale,
  };
}
