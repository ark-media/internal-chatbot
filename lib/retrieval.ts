import { sql } from './db';
import { embedQuery, rerank } from './voyage-http';
import { expandQueryWithKnownNames } from './knowledge-base';

// -- Types --------------------------------------------------------------------

export type CorpusFilters = {
  showIds?: number[];
  showGroupIds?: number[];
  speakerIds?: number[];
  episodeIds?: string[];
  since?: string;
  until?: string;
};

export type RetrievedChunk = {
  chunkId: number;
  episodeId: string;
  chunkIndex: number;
  showId: number;
  showName: string;
  title: string;
  date: string | null;
  section: string | null;
  driveUrl: string | null;
  text: string;
  startTurnId: number;
  endTurnId: number;
  score: number;
  neighbor?: boolean;
};

export type LookupOptions = {
  query: string;
  filters?: CorpusFilters;
  candidates?: number;
  finalK?: number;
  expandNeighbors?: boolean;
};

export type DossierTurn = {
  turnId: number;
  turnIndex: number;
  episodeId: string;
  episodeTitle: string;
  showId: number;
  showName: string;
  date: string | null;
  driveUrl: string | null;
  section: string | null;
  speakerId: number;
  speakerName: string;
  text: string;
};

export type DossierPage = {
  turns: DossierTurn[];
  totalCount: number;
  hasMore: boolean;
};

export type DossierOptions = {
  speakerId: number;
  filters?: Omit<CorpusFilters, 'speakerIds'>;
  topic?: string;
  limit?: number;
  offset?: number;
};

export type SpeakerSummary = {
  speakerId: number;
  canonicalName: string;
  reviewStatus: string;
  turnCount: number;
  episodeCount: number;
  shows: string[];
};

export type AppearanceCount = {
  episodeCount: number;
  turnCount: number;
  firstDate: string | null;
  lastDate: string | null;
  byShow: Array<{ showName: string; episodeCount: number; turnCount: number }>;
};

export type GuestAppearanceEpisode = {
  episodeId: string;
  title: string;
  date: string | null;
  driveUrl: string | null;
  matchedBy: 'turns' | 'title' | 'both';
  turnCount: number;
};

export type GuestAppearanceResult =
  | { kind: 'host'; speakerName: string; showName: string }
  | {
      kind: 'count';
      speakerName: string;
      showName: string;
      count: number;
      episodes: GuestAppearanceEpisode[];
    };

export type TopGuestRow = {
  rank: number;
  speakerId: number;
  speakerName: string;
  episodeCount: number;
  turnCount: number;
  firstDate: string | null;
  lastDate: string | null;
};

export type EpisodeDetail = {
  episodeId: string;
  showId: number;
  showName: string;
  title: string;
  date: string | null;
  driveUrl: string | null;
  turns: Array<{
    turnId: number;
    turnIndex: number;
    speakerId: number;
    speakerName: string;
    section: string | null;
    text: string;
  }>;
};

// -- Helpers ------------------------------------------------------------------

type ChunkRow = {
  chunk_id: number;
  episode_id: string;
  chunk_index: number;
  show_id: number;
  show_name: string;
  title: string;
  date: string | null;
  section: string | null;
  drive_url: string | null;
  text: string;
  start_turn_id: number;
  end_turn_id: number;
  vec_score: number | null;
  fts_score: number | null;
};

function toVec(values: number[]): string {
  return '[' + values.map((v) => v.toFixed(7)).join(',') + ']';
}

function toRetrievedChunk(
  row: ChunkRow,
  score: number,
  neighbor = false,
): RetrievedChunk {
  return {
    chunkId: row.chunk_id,
    episodeId: row.episode_id,
    chunkIndex: row.chunk_index,
    showId: row.show_id,
    showName: row.show_name,
    title: row.title,
    date: row.date,
    section: row.section,
    driveUrl: row.drive_url,
    text: row.text,
    startTurnId: row.start_turn_id,
    endTurnId: row.end_turn_id,
    score,
    ...(neighbor ? { neighbor: true } : {}),
  };
}

function rrf(
  vec: ChunkRow[],
  fts: ChunkRow[],
  k = 60,
): Map<number, { row: ChunkRow; score: number }> {
  const merged = new Map<number, { row: ChunkRow; score: number }>();
  vec.forEach((row, i) => {
    merged.set(row.chunk_id, { row, score: 1 / (k + i + 1) });
  });
  fts.forEach((row, i) => {
    const add = 1 / (k + i + 1);
    const existing = merged.get(row.chunk_id);
    if (existing) existing.score += add;
    else merged.set(row.chunk_id, { row, score: add });
  });
  return merged;
}

// -- lookupCorpus: hybrid RAG over chunks ------------------------------------

export async function lookupCorpus(
  opts: LookupOptions,
): Promise<RetrievedChunk[]> {
  const candidates = opts.candidates ?? 40;
  const finalK = opts.finalK ?? 8;
  const f = opts.filters ?? {};

  const expandedNames = expandQueryWithKnownNames(opts.query);
  const ftsQuery = [opts.query, ...expandedNames].join(' ');

  const showIds = f.showIds?.length ? f.showIds : null;
  const showGroupIds = f.showGroupIds?.length ? f.showGroupIds : null;
  const speakerIds = f.speakerIds?.length ? f.speakerIds : null;
  const episodeIds = f.episodeIds?.length ? f.episodeIds : null;
  const since = f.since ?? null;
  const until = f.until ?? null;

  const embedding = await embedQuery(opts.query);
  const vec = toVec(embedding);

  const [vecRows, ftsRows] = (await Promise.all([
    sql`
      SELECT c.chunk_id, c.episode_id, c.chunk_index,
             sh.show_id, sh.name AS show_name,
             e.title, e.date::text AS date, e.drive_url,
             c.section, c.text, c.start_turn_id, c.end_turn_id,
             1 - (c.embedding <=> ${vec}::vector) AS vec_score,
             NULL::real AS fts_score
        FROM chunks c
        JOIN episodes e ON e.episode_id = c.episode_id
        JOIN shows sh ON sh.show_id = e.show_id
       WHERE (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
         AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
         AND (${episodeIds}::text[] IS NULL OR c.episode_id = ANY(${episodeIds}::text[]))
         AND (${since}::date IS NULL OR e.date >= ${since}::date)
         AND (${until}::date IS NULL OR e.date <= ${until}::date)
         AND (${speakerIds}::int[] IS NULL OR EXISTS (
               SELECT 1 FROM turns t
                WHERE t.episode_id = c.episode_id
                  AND t.turn_id BETWEEN c.start_turn_id AND c.end_turn_id
                  AND t.speaker_id = ANY(${speakerIds}::int[])
             ))
    ORDER BY c.embedding <=> ${vec}::vector
       LIMIT ${candidates}
    `,
    sql`
      SELECT c.chunk_id, c.episode_id, c.chunk_index,
             sh.show_id, sh.name AS show_name,
             e.title, e.date::text AS date, e.drive_url,
             c.section, c.text, c.start_turn_id, c.end_turn_id,
             NULL::real AS vec_score,
             ts_rank_cd(c.tsv, websearch_to_tsquery('english', ${ftsQuery})) AS fts_score
        FROM chunks c
        JOIN episodes e ON e.episode_id = c.episode_id
        JOIN shows sh ON sh.show_id = e.show_id
       WHERE c.tsv @@ websearch_to_tsquery('english', ${ftsQuery})
         AND (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
         AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
         AND (${episodeIds}::text[] IS NULL OR c.episode_id = ANY(${episodeIds}::text[]))
         AND (${since}::date IS NULL OR e.date >= ${since}::date)
         AND (${until}::date IS NULL OR e.date <= ${until}::date)
         AND (${speakerIds}::int[] IS NULL OR EXISTS (
               SELECT 1 FROM turns t
                WHERE t.episode_id = c.episode_id
                  AND t.turn_id BETWEEN c.start_turn_id AND c.end_turn_id
                  AND t.speaker_id = ANY(${speakerIds}::int[])
             ))
    ORDER BY fts_score DESC NULLS LAST
       LIMIT ${candidates}
    `,
  ])) as unknown as [ChunkRow[], ChunkRow[]];

  const merged = rrf(vecRows, ftsRows);
  const ranked = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(finalK * 3, 20));

  if (ranked.length === 0) return [];

  const docs = ranked.map(
    ({ row }) =>
      `[Show: ${row.show_name}] [Title: ${row.title}] [Date: ${row.date ?? 'unknown'}]\n${row.text}`,
  );
  const reranked = await rerank(opts.query, docs, finalK);

  const top = reranked.map(({ index, relevance_score }) =>
    toRetrievedChunk(ranked[index].row, relevance_score),
  );

  if (opts.expandNeighbors === false || top.length === 0) return top;

  const neighbors = await fetchNeighbors(top);
  if (neighbors.length === 0) return top;

  const out: RetrievedChunk[] = [];
  const seen = new Set<number>();
  for (const hit of top) {
    if (seen.has(hit.chunkId)) continue;
    out.push(hit);
    seen.add(hit.chunkId);
    for (const n of neighbors) {
      if (n.episodeId !== hit.episodeId) continue;
      if (Math.abs(n.chunkIndex - hit.chunkIndex) !== 1) continue;
      if (seen.has(n.chunkId)) continue;
      out.push(n);
      seen.add(n.chunkId);
    }
  }
  return out;
}

async function fetchNeighbors(top: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  const episodeIds: string[] = [];
  const chunkIndexes: number[] = [];
  const seen = new Set<string>();
  for (const hit of top) {
    for (const delta of [-1, 1]) {
      const idx = hit.chunkIndex + delta;
      if (idx < 0) continue;
      const key = `${hit.episodeId}#${idx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      episodeIds.push(hit.episodeId);
      chunkIndexes.push(idx);
    }
  }
  if (episodeIds.length === 0) return [];

  const rows = (await sql`
    SELECT c.chunk_id, c.episode_id, c.chunk_index,
           sh.show_id, sh.name AS show_name,
           e.title, e.date::text AS date, e.drive_url,
           c.section, c.text, c.start_turn_id, c.end_turn_id,
           NULL::real AS vec_score, NULL::real AS fts_score
      FROM chunks c
      JOIN episodes e ON e.episode_id = c.episode_id
      JOIN shows sh ON sh.show_id = e.show_id
      JOIN unnest(${episodeIds}::text[], ${chunkIndexes}::int[]) AS q(episode_id, chunk_index)
        ON q.episode_id = c.episode_id AND q.chunk_index = c.chunk_index
  `) as unknown as ChunkRow[];

  return rows.map((row) => toRetrievedChunk(row, 0, true));
}

// -- getDossier: chronological turns by speaker ------------------------------

type DossierRow = {
  turn_id: number;
  turn_index: number;
  episode_id: string;
  episode_title: string;
  show_id: number;
  show_name: string;
  date: string | null;
  drive_url: string | null;
  section: string | null;
  speaker_id: number;
  speaker_name: string;
  text: string;
};

export async function getDossier(opts: DossierOptions): Promise<DossierPage> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const f = opts.filters ?? {};

  const showIds = f.showIds?.length ? f.showIds : null;
  const showGroupIds = f.showGroupIds?.length ? f.showGroupIds : null;
  const episodeIds = f.episodeIds?.length ? f.episodeIds : null;
  const since = f.since ?? null;
  const until = f.until ?? null;
  const topic = opts.topic?.trim() || null;

  const countRows = (await sql`
    SELECT COUNT(*)::int AS c
      FROM turns t
      JOIN episodes e ON e.episode_id = t.episode_id
      JOIN shows sh ON sh.show_id = e.show_id
     WHERE t.speaker_id = ${opts.speakerId}
       AND (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
       AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
       AND (${episodeIds}::text[] IS NULL OR t.episode_id = ANY(${episodeIds}::text[]))
       AND (${since}::date IS NULL OR e.date >= ${since}::date)
       AND (${until}::date IS NULL OR e.date <= ${until}::date)
       AND (${topic}::text IS NULL OR t.tsv @@ websearch_to_tsquery('english', ${topic}::text))
  `) as unknown as Array<{ c: number }>;
  const totalCount = countRows[0]?.c ?? 0;

  if (totalCount === 0) {
    return { turns: [], totalCount: 0, hasMore: false };
  }

  const rows = (await sql`
    SELECT t.turn_id, t.turn_index, t.episode_id, t.section, t.text, t.speaker_id,
           e.title AS episode_title, e.date::text AS date, e.drive_url,
           sh.show_id, sh.name AS show_name,
           sp.canonical_name AS speaker_name
      FROM turns t
      JOIN episodes e ON e.episode_id = t.episode_id
      JOIN shows sh ON sh.show_id = e.show_id
      JOIN speakers sp ON sp.speaker_id = t.speaker_id
     WHERE t.speaker_id = ${opts.speakerId}
       AND (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
       AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
       AND (${episodeIds}::text[] IS NULL OR t.episode_id = ANY(${episodeIds}::text[]))
       AND (${since}::date IS NULL OR e.date >= ${since}::date)
       AND (${until}::date IS NULL OR e.date <= ${until}::date)
       AND (${topic}::text IS NULL OR t.tsv @@ websearch_to_tsquery('english', ${topic}::text))
  ORDER BY e.date ASC NULLS LAST, t.episode_id, t.turn_index
     LIMIT ${limit} OFFSET ${offset}
  `) as unknown as DossierRow[];

  return {
    turns: rows.map((r) => ({
      turnId: r.turn_id,
      turnIndex: r.turn_index,
      episodeId: r.episode_id,
      episodeTitle: r.episode_title,
      showId: r.show_id,
      showName: r.show_name,
      date: r.date,
      driveUrl: r.drive_url,
      section: r.section,
      speakerId: r.speaker_id,
      speakerName: r.speaker_name,
      text: r.text,
    })),
    totalCount,
    hasMore: offset + rows.length < totalCount,
  };
}

// -- listSpeakers: disambiguation helper -------------------------------------

export async function listSpeakers(opts: {
  nameLike?: string;
  showIds?: number[];
  showGroupIds?: number[];
  includeUnreviewed?: boolean;
  limit?: number;
}): Promise<SpeakerSummary[]> {
  const nameLike = opts.nameLike?.trim();
  const pattern = nameLike ? `%${nameLike.toLowerCase()}%` : null;
  const showIds = opts.showIds?.length ? opts.showIds : null;
  const showGroupIds = opts.showGroupIds?.length ? opts.showGroupIds : null;
  const includeUnreviewed = opts.includeUnreviewed ?? false;
  const limit = Math.min(opts.limit ?? 25, 100);

  const rows = (await sql`
    SELECT sp.speaker_id, sp.canonical_name, sp.review_status,
           COUNT(DISTINCT t.turn_id)::int AS turn_count,
           COUNT(DISTINCT t.episode_id)::int AS episode_count,
           COALESCE(
             array_agg(DISTINCT sh.name ORDER BY sh.name)
               FILTER (WHERE sh.name IS NOT NULL),
             ARRAY[]::text[]
           ) AS shows
      FROM speakers sp
      LEFT JOIN turns t ON t.speaker_id = sp.speaker_id
      LEFT JOIN episodes e ON e.episode_id = t.episode_id
      LEFT JOIN shows sh ON sh.show_id = e.show_id
     WHERE sp.include_in_content = TRUE
       AND (${includeUnreviewed}::bool OR sp.review_status <> 'unreviewed')
       AND (${pattern}::text IS NULL OR EXISTS (
             SELECT 1 FROM speaker_aliases a
              WHERE a.speaker_id = sp.speaker_id
                AND a.alias_lower LIKE ${pattern}::text
           ))
       AND (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
       AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
  GROUP BY sp.speaker_id
  ORDER BY turn_count DESC, sp.canonical_name ASC
     LIMIT ${limit}
  `) as unknown as Array<{
    speaker_id: number;
    canonical_name: string;
    review_status: string;
    turn_count: number;
    episode_count: number;
    shows: string[];
  }>;

  return rows.map((r) => ({
    speakerId: r.speaker_id,
    canonicalName: r.canonical_name,
    reviewStatus: r.review_status,
    turnCount: r.turn_count,
    episodeCount: r.episode_count,
    shows: r.shows,
  }));
}

// -- countAppearances: aggregation -------------------------------------------

export async function countAppearances(opts: {
  speakerId: number;
  filters?: Omit<CorpusFilters, 'speakerIds'>;
}): Promise<AppearanceCount> {
  const f = opts.filters ?? {};
  const showIds = f.showIds?.length ? f.showIds : null;
  const showGroupIds = f.showGroupIds?.length ? f.showGroupIds : null;
  const episodeIds = f.episodeIds?.length ? f.episodeIds : null;
  const since = f.since ?? null;
  const until = f.until ?? null;

  const [totalsArr, byShowArr] = (await Promise.all([
    sql`
      SELECT COUNT(DISTINCT t.episode_id)::int AS episode_count,
             COUNT(*)::int AS turn_count,
             MIN(e.date)::text AS first_date,
             MAX(e.date)::text AS last_date
        FROM turns t
        JOIN episodes e ON e.episode_id = t.episode_id
        JOIN shows sh ON sh.show_id = e.show_id
       WHERE t.speaker_id = ${opts.speakerId}
         AND (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
         AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
         AND (${episodeIds}::text[] IS NULL OR t.episode_id = ANY(${episodeIds}::text[]))
         AND (${since}::date IS NULL OR e.date >= ${since}::date)
         AND (${until}::date IS NULL OR e.date <= ${until}::date)
    `,
    sql`
      SELECT sh.name AS show_name,
             COUNT(DISTINCT t.episode_id)::int AS episode_count,
             COUNT(*)::int AS turn_count
        FROM turns t
        JOIN episodes e ON e.episode_id = t.episode_id
        JOIN shows sh ON sh.show_id = e.show_id
       WHERE t.speaker_id = ${opts.speakerId}
         AND (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
         AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
         AND (${episodeIds}::text[] IS NULL OR t.episode_id = ANY(${episodeIds}::text[]))
         AND (${since}::date IS NULL OR e.date >= ${since}::date)
         AND (${until}::date IS NULL OR e.date <= ${until}::date)
    GROUP BY sh.name
    ORDER BY episode_count DESC, sh.name ASC
    `,
  ])) as unknown as [
    Array<{
      episode_count: number;
      turn_count: number;
      first_date: string | null;
      last_date: string | null;
    }>,
    Array<{ show_name: string; episode_count: number; turn_count: number }>,
  ];

  const totals = totalsArr[0] ?? {
    episode_count: 0,
    turn_count: 0,
    first_date: null,
    last_date: null,
  };

  return {
    episodeCount: totals.episode_count,
    turnCount: totals.turn_count,
    firstDate: totals.first_date,
    lastDate: totals.last_date,
    byShow: byShowArr.map((r) => ({
      showName: r.show_name,
      episodeCount: r.episode_count,
      turnCount: r.turn_count,
    })),
  };
}

// -- countGuestAppearancesOnShow: episode count by speaker + title match ----

export async function countGuestAppearancesOnShow(opts: {
  speakerId: number;
  showId: number;
}): Promise<GuestAppearanceResult> {
  const [metaRows, aliasRows, hostRows] = (await Promise.all([
    sql`
      SELECT sp.canonical_name AS speaker_name, sh.name AS show_name
        FROM speakers sp, shows sh
       WHERE sp.speaker_id = ${opts.speakerId}
         AND sh.show_id = ${opts.showId}
    `,
    sql`
      SELECT alias_display
        FROM speaker_aliases
       WHERE speaker_id = ${opts.speakerId}
    `,
    sql`
      SELECT 1 AS one FROM show_hosts
       WHERE show_id = ${opts.showId}
         AND speaker_id = ${opts.speakerId}
    `,
  ])) as unknown as [
    Array<{ speaker_name: string; show_name: string }>,
    Array<{ alias_display: string }>,
    Array<{ one: number }>,
  ];

  const meta = metaRows[0];
  if (!meta) {
    throw new Error(
      `Unknown speaker_id=${opts.speakerId} or show_id=${opts.showId}`,
    );
  }

  if (hostRows.length > 0) {
    return { kind: 'host', speakerName: meta.speaker_name, showName: meta.show_name };
  }

  // Only use multi-word aliases for title matching; bare first/last names cause
  // cross-speaker false positives (e.g. "with Nadav" matching any Nadav).
  const aliasSet = new Set<string>(
    aliasRows.map((r) => r.alias_display.toLowerCase()),
  );
  aliasSet.add(meta.speaker_name.toLowerCase());
  const titlePatterns = Array.from(aliasSet)
    .filter((a) => a.trim().split(/\s+/).length >= 2)
    .map((a) => `%with ${a}%`);
  const noTitleMatch = titlePatterns.length === 0;

  const rows = (await sql`
    WITH ep AS (
      SELECT e.episode_id, e.title, e.date::text AS date, e.drive_url,
             (SELECT COUNT(*)::int FROM turns t
               WHERE t.episode_id = e.episode_id
                 AND t.speaker_id = ${opts.speakerId}) AS turn_count,
             CASE WHEN ${noTitleMatch}::bool THEN FALSE
                  ELSE LOWER(e.title) LIKE ANY(${titlePatterns}::text[])
             END AS by_title
        FROM episodes e
       WHERE e.show_id = ${opts.showId}
    )
    SELECT episode_id, title, date, drive_url, turn_count, by_title
      FROM ep
     WHERE turn_count > 0 OR by_title
  ORDER BY date DESC NULLS LAST, episode_id
  `) as unknown as Array<{
    episode_id: string;
    title: string;
    date: string | null;
    drive_url: string | null;
    turn_count: number;
    by_title: boolean;
  }>;

  const episodes: GuestAppearanceEpisode[] = rows.map((r) => ({
    episodeId: r.episode_id,
    title: r.title,
    date: r.date,
    driveUrl: r.drive_url,
    turnCount: r.turn_count,
    matchedBy:
      r.turn_count > 0 && r.by_title
        ? 'both'
        : r.turn_count > 0
          ? 'turns'
          : 'title',
  }));

  return {
    kind: 'count',
    speakerName: meta.speaker_name,
    showName: meta.show_name,
    count: episodes.length,
    episodes,
  };
}

// -- getEpisode: full episode detail -----------------------------------------

export async function getEpisode(
  episodeId: string,
): Promise<EpisodeDetail | null> {
  const [epRows, turnRows] = (await Promise.all([
    sql`
      SELECT e.episode_id, e.title, e.date::text AS date, e.drive_url,
             sh.show_id, sh.name AS show_name
        FROM episodes e
        JOIN shows sh ON sh.show_id = e.show_id
       WHERE e.episode_id = ${episodeId}
    `,
    sql`
      SELECT t.turn_id, t.turn_index, t.section, t.text,
             t.speaker_id, sp.canonical_name AS speaker_name
        FROM turns t
        JOIN speakers sp ON sp.speaker_id = t.speaker_id
       WHERE t.episode_id = ${episodeId}
    ORDER BY t.turn_index
    `,
  ])) as unknown as [
    Array<{
      episode_id: string;
      title: string;
      date: string | null;
      drive_url: string | null;
      show_id: number;
      show_name: string;
    }>,
    Array<{
      turn_id: number;
      turn_index: number;
      section: string | null;
      text: string;
      speaker_id: number;
      speaker_name: string;
    }>,
  ];

  const ep = epRows[0];
  if (!ep) return null;

  return {
    episodeId: ep.episode_id,
    showId: ep.show_id,
    showName: ep.show_name,
    title: ep.title,
    date: ep.date,
    driveUrl: ep.drive_url,
    turns: turnRows.map((r) => ({
      turnId: r.turn_id,
      turnIndex: r.turn_index,
      speakerId: r.speaker_id,
      speakerName: r.speaker_name,
      section: r.section,
      text: r.text,
    })),
  };
}

// -- listTopGuests: rank recurring guests by episode count -------------------

export async function listTopGuests(opts: {
  filters?: Pick<CorpusFilters, 'showIds' | 'showGroupIds' | 'since' | 'until'>;
  limit?: number;
}): Promise<TopGuestRow[]> {
  const f = opts.filters ?? {};
  const showIds = f.showIds?.length ? f.showIds : null;
  const showGroupIds = f.showGroupIds?.length ? f.showGroupIds : null;
  const since = f.since ?? null;
  const until = f.until ?? null;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  const rows = (await sql`
    WITH relevant_shows AS (
      SELECT show_id
        FROM shows
       WHERE (${showIds}::int[] IS NULL OR show_id = ANY(${showIds}::int[]))
         AND (${showGroupIds}::int[] IS NULL OR group_id = ANY(${showGroupIds}::int[]))
    ),
    agg AS (
      SELECT sp.speaker_id,
             sp.canonical_name,
             COUNT(DISTINCT t.episode_id)::int AS episode_count,
             COUNT(*)::int AS turn_count,
             MIN(e.date)::text AS first_date,
             MAX(e.date)::text AS last_date
        FROM turns t
        JOIN episodes e ON e.episode_id = t.episode_id
                       AND e.show_id IN (SELECT show_id FROM relevant_shows)
        JOIN speakers sp ON sp.speaker_id = t.speaker_id
       WHERE sp.include_in_content = TRUE
         AND sp.review_status <> 'unreviewed'
         AND (${since}::date IS NULL OR e.date >= ${since}::date)
         AND (${until}::date IS NULL OR e.date <= ${until}::date)
         AND NOT EXISTS (
               SELECT 1 FROM show_hosts h
                WHERE h.speaker_id = sp.speaker_id
                  AND h.show_id IN (SELECT show_id FROM relevant_shows)
             )
    GROUP BY sp.speaker_id, sp.canonical_name
    ),
    ranked AS (
      SELECT speaker_id,
             canonical_name,
             episode_count,
             turn_count,
             first_date,
             last_date,
             DENSE_RANK() OVER (ORDER BY episode_count DESC)::int AS rank
        FROM agg
    )
    SELECT speaker_id, canonical_name, episode_count, turn_count,
           first_date, last_date, rank
      FROM ranked
     WHERE rank <= COALESCE(
             (SELECT rank FROM ranked
               ORDER BY rank ASC, turn_count DESC, canonical_name ASC
               LIMIT 1 OFFSET ${limit - 1}),
             (SELECT MAX(rank) FROM ranked)
           )
  ORDER BY rank ASC, turn_count DESC, canonical_name ASC
  `) as unknown as Array<{
    speaker_id: number;
    canonical_name: string;
    episode_count: number;
    turn_count: number;
    first_date: string | null;
    last_date: string | null;
    rank: number;
  }>;

  return rows.map((r) => ({
    rank: r.rank,
    speakerId: r.speaker_id,
    speakerName: r.canonical_name,
    episodeCount: r.episode_count,
    turnCount: r.turn_count,
    firstDate: r.first_date,
    lastDate: r.last_date,
  }));
}
