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
  // Non-null only when bookend mode was used AND a middle gap exists
  // (totalCount > 2*bookendHalf). headCount + tailCount === turns.length.
  // Sequential mode and fully-loaded bookend results both report null.
  bookend: { headCount: number; tailCount: number } | null;
};

export type DossierOptions = {
  speakerId: number;
  filters?: Omit<CorpusFilters, 'speakerIds'>;
  topic?: string;
  limit?: number;
  offset?: number;
  // When set, return the first N + last N turns chronologically in a single
  // query (ignores limit/offset). Used by the chat pre-load so recent material
  // is always represented for high-volume guests; the model paginates the
  // middle gap via the dossier tool with offset.
  bookendHalf?: number;
};

export type SpeakerSummary = {
  speakerId: number;
  canonicalName: string;
  reviewStatus: string;
  turnCount: number;
  episodeCount: number;
  shows: string[];
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

export type TopGuestEpisode = {
  episodeId: string;
  title: string;
  date: string | null;
  driveUrl: string | null;
};

export type TopGuestRow = {
  rank: number;
  speakerId: number;
  speakerName: string;
  episodeCount: number;
  firstDate: string | null;
  lastDate: string | null;
  episodes: TopGuestEpisode[];
};

// -- Shared SQL fragments -----------------------------------------------------
//
// Neon tagged templates compose: interpolating a `sql` fragment recurses into
// it and appends its text, renumbering `$n` against the outer param array.
// These fragments bind no parameters, so composing one appends its text and
// nothing else — the query reaching Postgres is unchanged apart from
// whitespace. `retrieval-sql.test.ts` pins that.
//
// Fragments exist so a projection stays in lockstep across the queries that
// feed the same row type. Do not add parameters to them: a fragment that binds
// values is far harder to reason about at the call sites.

// Column list + FROM/JOIN for anything returning a `ChunkRow`. Callers supply
// the two score columns, which differ per query, between the two.
const CHUNK_COLS = sql`c.chunk_id, c.episode_id, c.chunk_index,
             sh.show_id, sh.name AS show_name,
             e.title, e.date::text AS date, e.drive_url,
             c.section, c.text, c.start_turn_id, c.end_turn_id`;

const CHUNK_FROM = sql`FROM chunks c
        JOIN episodes e ON e.episode_id = c.episode_id
        JOIN shows sh ON sh.show_id = e.show_id`;

// Column list + FROM/JOIN for anything returning a `DossierRow`. The bookend
// query appends window functions after the columns, so the two are separate.
const TURN_COLS = sql`t.turn_id, t.turn_index, t.episode_id, t.section, t.text, t.speaker_id,
           e.title AS episode_title, e.date::text AS date, e.drive_url,
           sh.show_id, sh.name AS show_name,
           sp.canonical_name AS speaker_name`;

const TURN_FROM = sql`FROM turns t
      JOIN episodes e ON e.episode_id = t.episode_id
      JOIN shows sh ON sh.show_id = e.show_id
      JOIN speakers sp ON sp.speaker_id = t.speaker_id`;

export const __sqlFragments = { CHUNK_COLS, CHUNK_FROM, TURN_COLS, TURN_FROM };

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
      SELECT ${CHUNK_COLS},
             1 - (c.embedding <=> ${vec}::vector) AS vec_score,
             NULL::real AS fts_score
        ${CHUNK_FROM}
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
      SELECT ${CHUNK_COLS},
             NULL::real AS vec_score,
             ts_rank_cd(c.tsv, websearch_to_tsquery('english', ${ftsQuery})) AS fts_score
        ${CHUNK_FROM}
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

  // Voyage normally returns indices in [0, docs.length); guard so a malformed
  // response can't crash the entire route on `ranked[index].row` access.
  const top: RetrievedChunk[] = [];
  for (const { index, relevance_score } of reranked) {
    const r = ranked[index];
    if (!r) continue;
    top.push(toRetrievedChunk(r.row, relevance_score));
  }

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
    SELECT ${CHUNK_COLS},
           NULL::real AS vec_score, NULL::real AS fts_score
      ${CHUNK_FROM}
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

function rowToDossierTurn(r: DossierRow): DossierTurn {
  return {
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
  };
}

export async function getDossier(opts: DossierOptions): Promise<DossierPage> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const bookendHalf = opts.bookendHalf != null ? Math.max(1, Math.min(opts.bookendHalf, 250)) : null;
  // Bookend mode runs its own CTE that ignores limit/offset; reject the
  // combination explicitly so a future caller passing both gets a clear
  // error instead of silently dropped pagination.
  if (bookendHalf !== null && (opts.limit != null || opts.offset != null)) {
    throw new Error('getDossier: bookendHalf is mutually exclusive with limit/offset');
  }
  const f = opts.filters ?? {};

  const showIds = f.showIds?.length ? f.showIds : null;
  const showGroupIds = f.showGroupIds?.length ? f.showGroupIds : null;
  const episodeIds = f.episodeIds?.length ? f.episodeIds : null;
  const since = f.since ?? null;
  const until = f.until ?? null;
  const topic = opts.topic?.trim() || null;

  // Bookend mode: single CTE that selects first N + last N chronologically.
  // When totalCount <= 2N, the WHERE clause matches every row (rn <= N OR
  // rn > total-N covers everything), so small dossiers naturally fall through
  // to "complete dossier" without a special case.
  //
  // Cost: ROW_NUMBER + COUNT(*) OVER force the planner to materialize the full
  // filtered rowset before slicing. Fine for typical guests (50–300 turns);
  // not appropriate for hosts (10K+ turns). Callers should restrict bookend
  // mode to non-host speakers.
  if (bookendHalf !== null) {
    const rows = (await sql`
      WITH ordered AS (
        SELECT ${TURN_COLS},
               ROW_NUMBER() OVER (ORDER BY e.date ASC NULLS LAST, t.episode_id, t.turn_index) AS rn,
               (COUNT(*) OVER ())::int AS total_cnt
          ${TURN_FROM}
         WHERE t.speaker_id = ${opts.speakerId}
           AND (${showIds}::int[] IS NULL OR sh.show_id = ANY(${showIds}::int[]))
           AND (${showGroupIds}::int[] IS NULL OR sh.group_id = ANY(${showGroupIds}::int[]))
           AND (${episodeIds}::text[] IS NULL OR t.episode_id = ANY(${episodeIds}::text[]))
           AND (${since}::date IS NULL OR e.date >= ${since}::date)
           AND (${until}::date IS NULL OR e.date <= ${until}::date)
           AND (${topic}::text IS NULL OR t.tsv @@ websearch_to_tsquery('english', ${topic}::text))
      )
      SELECT * FROM ordered
       WHERE rn <= ${bookendHalf} OR rn > total_cnt - ${bookendHalf}
    ORDER BY rn
    `) as unknown as Array<DossierRow & { total_cnt: number }>;

    const totalCount = rows[0]?.total_cnt ?? 0;
    // The WHERE clause `rn <= N OR rn > total - N` returns all rows when
    // total <= 2N (the two predicates fully cover the range). Bookend split
    // is only meaningful when a real middle gap exists.
    const hasMiddleGap = totalCount > 2 * bookendHalf;
    return {
      turns: rows.map(rowToDossierTurn),
      totalCount,
      hasMore: rows.length < totalCount,
      bookend: hasMiddleGap
        ? { headCount: bookendHalf, tailCount: bookendHalf }
        : null,
    };
  }

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
    return { turns: [], totalCount: 0, hasMore: false, bookend: null };
  }

  const rows = (await sql`
    SELECT ${TURN_COLS}
      ${TURN_FROM}
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
    turns: rows.map(rowToDossierTurn),
    totalCount,
    hasMore: offset + rows.length < totalCount,
    bookend: null,
  };
}

// Round-robin merge of ranked chunk lists from N parallel subqueries. Iterates
// rank-first (rank 0 of subq 0, rank 0 of subq 1, …, rank 1 of subq 0, …) so
// each subquery's top hit gets a slot before any subquery's runner-ups.
// Dedupes by chunkId across subqueries; ties on first-occurrence keep their
// original subquery's slot. Used by the chat preload merge.
export function roundRobinMergeChunks(
  results: RetrievedChunk[][],
  limit: number,
): RetrievedChunk[] {
  const merged = new Map<number, RetrievedChunk>();
  const maxLen = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < maxLen && merged.size < limit; i++) {
    for (const arr of results) {
      if (merged.size >= limit) break;
      const c = arr[i];
      if (c && !merged.has(c.chunkId)) merged.set(c.chunkId, c);
    }
  }
  return Array.from(merged.values());
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
    scoped_turns AS (
      SELECT t.speaker_id, t.text, e.episode_id, e.title, e.date, e.drive_url
        FROM turns t
        JOIN episodes e ON e.episode_id = t.episode_id
                       AND e.show_id IN (SELECT show_id FROM relevant_shows)
       WHERE (${since}::date IS NULL OR e.date >= ${since}::date)
         AND (${until}::date IS NULL OR e.date <= ${until}::date)
    ),
    episode_char_totals AS (
      SELECT episode_id, SUM(LENGTH(text))::float AS total_chars
        FROM scoped_turns
       GROUP BY episode_id
    ),
    -- Require a speaker to hold >=5% of an episode's transcript to count as a
    -- guest of that episode. Filters out cold-open clips, voicemail cameos,
    -- and brief memorial soundbites that would otherwise inflate guest counts.
    speaker_episodes AS (
      SELECT st.speaker_id,
             st.episode_id,
             st.title,
             st.date,
             st.drive_url
        FROM scoped_turns st
        JOIN episode_char_totals ect ON ect.episode_id = st.episode_id
       GROUP BY st.speaker_id, st.episode_id, st.title, st.date, st.drive_url, ect.total_chars
      HAVING SUM(LENGTH(st.text))::float / NULLIF(ect.total_chars, 0) >= 0.05
    ),
    agg AS (
      SELECT sp.speaker_id,
             sp.canonical_name,
             COUNT(*)::int AS episode_count,
             MIN(se.date)::text AS first_date,
             MAX(se.date)::text AS last_date
        FROM speaker_episodes se
        JOIN speakers sp ON sp.speaker_id = se.speaker_id
       WHERE sp.include_in_content = TRUE
         AND sp.review_status <> 'unreviewed'
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
             first_date,
             last_date,
             DENSE_RANK() OVER (ORDER BY episode_count DESC)::int AS rank
        FROM agg
    ),
    cutoff AS (
      SELECT COALESCE(
               (SELECT rank FROM ranked
                 ORDER BY rank ASC, canonical_name ASC
                 LIMIT 1 OFFSET ${limit - 1}),
               (SELECT MAX(rank) FROM ranked)
             ) AS max_rank
    )
    SELECT r.speaker_id, r.canonical_name, r.episode_count,
           r.first_date, r.last_date, r.rank,
           COALESCE(
             (SELECT jsonb_agg(jsonb_build_object(
                       'episode_id', se.episode_id,
                       'title', se.title,
                       'date', se.date::text,
                       'drive_url', se.drive_url
                     ) ORDER BY se.date DESC NULLS LAST, se.episode_id)
                FROM speaker_episodes se
               WHERE se.speaker_id = r.speaker_id),
             '[]'::jsonb
           ) AS episodes
      FROM ranked r, cutoff c
     WHERE r.rank <= c.max_rank
  ORDER BY r.rank ASC, r.canonical_name ASC
  `) as unknown as Array<{
    speaker_id: number;
    canonical_name: string;
    episode_count: number;
    first_date: string | null;
    last_date: string | null;
    rank: number;
    episodes: Array<{
      episode_id: string;
      title: string;
      date: string | null;
      drive_url: string | null;
    }>;
  }>;

  return rows.map((r) => ({
    rank: r.rank,
    speakerId: r.speaker_id,
    speakerName: r.canonical_name,
    episodeCount: r.episode_count,
    firstDate: r.first_date,
    lastDate: r.last_date,
    episodes: r.episodes.map((ep) => ({
      episodeId: ep.episode_id,
      title: ep.title,
      date: ep.date,
      driveUrl: ep.drive_url,
    })),
  }));
}
