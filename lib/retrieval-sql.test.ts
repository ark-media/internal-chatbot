import { describe, expect, it } from 'vitest';
import { sql } from './db';
import { __sqlFragments } from './retrieval';

const {
  CHUNK_COLS,
  CHUNK_FROM,
  TURN_COLS,
  TURN_FROM,
  CHUNK_EPISODE_COL,
  TURN_EPISODE_COL,
  corpusScope,
  chunkScope,
  turnScope,
} = __sqlFragments;

const SCOPE = {
  showIds: [1, 2],
  showGroupIds: [7],
  episodeIds: ['ep-a', 'ep-b'],
  since: '2025-01-01',
  until: '2026-01-01',
};

// A neon tagged template is lazy: it only touches the network when something
// calls `.then`/`.catch`/`.finally`. Reaching into `.queryData` renders the
// query the driver *would* send without sending it, so these are pure unit
// tests with no DB. Never `await` a value built here.
type Rendered = { query: string; params: unknown[] };

function render(q: unknown): Rendered {
  const queryData = (q as { queryData: { toParameterizedQuery(): Rendered } })
    .queryData;
  return queryData.toParameterizedQuery();
}

// Postgres does not care about run of whitespace; the fragments are indented
// for the call site that reads best, so compare on collapsed whitespace.
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

describe('retrieval SQL fragments', () => {
  it.each([
    ['CHUNK_COLS', CHUNK_COLS],
    ['CHUNK_FROM', CHUNK_FROM],
    ['TURN_COLS', TURN_COLS],
    ['TURN_FROM', TURN_FROM],
  ])('%s binds no parameters', (_name, fragment) => {
    expect(render(fragment).params).toEqual([]);
  });

  it('composing a fragment yields the same SQL as inlining it', () => {
    const composed = render(sql`SELECT ${CHUNK_COLS} ${CHUNK_FROM} WHERE TRUE`);
    const inlined = render(sql`SELECT c.chunk_id, c.episode_id, c.chunk_index,
             sh.show_id, sh.name AS show_name,
             e.title, e.date::text AS date, e.drive_url,
             c.section, c.text, c.start_turn_id, c.end_turn_id
        FROM chunks c
        JOIN episodes e ON e.episode_id = c.episode_id
        JOIN shows sh ON sh.show_id = e.show_id
       WHERE TRUE`);

    expect(norm(composed.query)).toBe(norm(inlined.query));
    expect(composed.params).toEqual([]);
  });

  it('composing TURN fragments yields the same SQL as inlining them', () => {
    const composed = render(sql`SELECT ${TURN_COLS} ${TURN_FROM} WHERE TRUE`);
    const inlined = render(sql`SELECT t.turn_id, t.turn_index, t.episode_id, t.section, t.text, t.speaker_id,
           e.title AS episode_title, e.date::text AS date, e.drive_url,
           sh.show_id, sh.name AS show_name,
           sp.canonical_name AS speaker_name
      FROM turns t
      JOIN episodes e ON e.episode_id = t.episode_id
      JOIN shows sh ON sh.show_id = e.show_id
      JOIN speakers sp ON sp.speaker_id = t.speaker_id
     WHERE TRUE`);

    expect(norm(composed.query)).toBe(norm(inlined.query));
    expect(composed.params).toEqual([]);
  });

  // The guard that matters for Wave 3's shared scope filter: a fragment sitting
  // between two bound values must not disturb `$n` numbering on either side.
  it('keeps $n numbering sequential across an interpolated fragment', () => {
    const { query, params } = render(
      sql`SELECT ${CHUNK_COLS} ${CHUNK_FROM}
           WHERE c.episode_id = ${'ep-1'}
             AND sh.show_id = ANY(${[1, 2]}::int[])`,
    );

    expect(query).toContain('$1');
    expect(query).toContain('$2');
    expect(query).not.toContain('$3');
    expect(params).toEqual(['ep-1', [1, 2]]);
  });

  // A parameterised fragment would renumber correctly but makes call sites
  // impossible to read at a glance. Pin the zero-param contract so nobody
  // quietly adds one.
  it('renumbers correctly even when a fragment itself binds values', () => {
    const scoped = sql`sh.show_id = ANY(${[7]}::int[])`;
    const { query, params } = render(
      sql`SELECT 1 WHERE c.episode_id = ${'ep-1'} AND ${scoped} AND e.date >= ${'2026-01-01'}`,
    );

    expect(params).toEqual(['ep-1', [7], '2026-01-01']);
    expect(query).toContain('$1');
    expect(query).toContain('$2');
    expect(query).toContain('$3');
  });
});

// These DO bind values, so composition order matters. The whole point of the
// shared scope filter is that vector search, keyword search and the three
// dossier queries can't drift apart — when they do, the same question quietly
// returns different rows depending on which path served it.
describe('corpus scope filter', () => {
  it.each([
    ['CHUNK_EPISODE_COL', CHUNK_EPISODE_COL, 'c.episode_id'],
    ['TURN_EPISODE_COL', TURN_EPISODE_COL, 't.episode_id'],
  ])('%s is a zero-parameter identifier fragment', (_name, frag, expected) => {
    const { query, params } = render(frag);
    expect(norm(query)).toBe(expected);
    // Critical: these are interpolated as SQL, not bound. If one ever carried a
    // parameter it would mean a caller-supplied identifier — an injection path.
    expect(params).toEqual([]);
  });

  it('emits the five scope predicates, additively', () => {
    const { query, params } = render(
      sql`SELECT 1 FROM chunks c WHERE TRUE${corpusScope(SCOPE, CHUNK_EPISODE_COL)}`,
    );

    // Additive: must start with AND so it can follow any existing predicate.
    expect(norm(query)).toContain('WHERE TRUE AND (');
    expect(norm(query)).toContain('sh.show_id = ANY(');
    expect(norm(query)).toContain('sh.group_id = ANY(');
    expect(norm(query)).toContain('c.episode_id = ANY(');
    expect(norm(query)).toContain('e.date >= ');
    expect(norm(query)).toContain('e.date <= ');
    // Each predicate binds its value twice (the IS NULL guard and the compare).
    expect(params).toEqual([
      [1, 2], [1, 2],
      [7], [7],
      ['ep-a', 'ep-b'], ['ep-a', 'ep-b'],
      '2025-01-01', '2025-01-01',
      '2026-01-01', '2026-01-01',
    ]);
  });

  it('switches the episode column with the fragment it is given', () => {
    const chunk = render(sql`WHERE TRUE${corpusScope(SCOPE, CHUNK_EPISODE_COL)}`);
    const turn = render(sql`WHERE TRUE${corpusScope(SCOPE, TURN_EPISODE_COL)}`);

    expect(chunk.query).toContain('c.episode_id = ANY(');
    expect(chunk.query).not.toContain('t.episode_id = ANY(');
    expect(turn.query).toContain('t.episode_id = ANY(');
    expect(turn.query).not.toContain('c.episode_id = ANY(');
    // Only the column differs — same predicates, same bound values.
    expect(turn.params).toEqual(chunk.params);
  });

  it('chunkScope appends the speaker-overlap EXISTS after the shared five', () => {
    const { query, params } = render(
      sql`WHERE TRUE${chunkScope(SCOPE, [42])}`,
    );
    const n = norm(query);

    expect(n.indexOf('c.episode_id = ANY(')).toBeLessThan(n.indexOf('EXISTS ('));
    expect(n).toContain('t.turn_id BETWEEN c.start_turn_id AND c.end_turn_id');
    expect(params.slice(-2)).toEqual([[42], [42]]);
  });

  it('turnScope appends the topic predicate after the shared five', () => {
    const { query, params } = render(
      sql`WHERE TRUE${turnScope(SCOPE, 'hostages')}`,
    );
    const n = norm(query);

    expect(n.indexOf('t.episode_id = ANY(')).toBeLessThan(n.indexOf('t.tsv @@'));
    expect(n).toContain("websearch_to_tsquery('english',");
    expect(params.slice(-2)).toEqual(['hostages', 'hostages']);
  });

  it('passes nulls straight through so the IS NULL guards short-circuit', () => {
    const empty = {
      showIds: null,
      showGroupIds: null,
      episodeIds: null,
      since: null,
      until: null,
    };
    const { params } = render(sql`WHERE TRUE${turnScope(empty, null)}`);

    expect(params).toEqual(new Array(12).fill(null));
  });
});
