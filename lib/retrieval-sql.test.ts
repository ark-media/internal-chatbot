import { describe, expect, it } from 'vitest';
import { sql } from './db';
import { __sqlFragments } from './retrieval';

const { CHUNK_COLS, CHUNK_FROM, TURN_COLS, TURN_FROM } = __sqlFragments;

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
