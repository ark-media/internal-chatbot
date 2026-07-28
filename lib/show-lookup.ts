import { sql } from './db';

// Resolving a show or show-group name typed by a person (or produced by the
// model) had four implementations: two in the chat route's tools and two in
// eval/grade.ts. They must agree on *what matches* — when they don't, an eval
// scopes its questions to a different show than the route would have, and the
// results stop describing production.
//
// The matching rule: exact case-insensitive match first, then substring, and
// alphabetical within each group.

export type NameMatch = { id: number; name: string };

export type ResolveResult =
  | { ok: true; id: number; name: string }
  | { ok: false; error: string; note: string; candidates?: string[] };

// Fixed identifier fragments — never caller-supplied, so interpolating them as
// SQL cannot inject. Same technique as the episode-column fragments in
// retrieval.ts; `retrieval-sql.test.ts` explains why it's safe.
type Source = {
  table: unknown;
  idCol: unknown;
  /** "show" / "show group" — used in the not-found note. */
  singular: string;
  /** "shows" / "show groups" — used in the ambiguous note. */
  plural: string;
  /** "Known shows" / "Known groups" — the label before the name list. */
  knownLabel: string;
  /** Rendered when the corpus has none at all. Differs between the two; kept
   *  as-is because these strings are fed to the model verbatim. */
  emptyList: string;
  /** Suffix for the machine-readable error code: unknown_/ambiguous_ + this. */
  errorSuffix: string;
};

const SHOWS: Source = {
  table: sql`shows`,
  idCol: sql`show_id`,
  singular: 'show',
  plural: 'shows',
  knownLabel: 'Known shows',
  emptyList: '',
  errorSuffix: 'show',
};

const GROUPS: Source = {
  table: sql`show_groups`,
  idCol: sql`group_id`,
  singular: 'show group',
  plural: 'show groups',
  knownLabel: 'Known groups',
  emptyList: '(none)',
  errorSuffix: 'group',
};

async function matchByName(src: Source, name: string): Promise<NameMatch[]> {
  return (await sql`
    SELECT ${src.idCol} AS id, name FROM ${src.table}
     WHERE LOWER(name) = LOWER(${name})
        OR LOWER(name) LIKE '%' || LOWER(${name}) || '%'
  ORDER BY (LOWER(name) = LOWER(${name})) DESC, name
  `) as unknown as NameMatch[];
}

async function allNames(src: Source): Promise<string[]> {
  const rows = (await sql`
    SELECT name FROM ${src.table} ORDER BY name
  `) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// Full resolution for the chat route's tools: on failure the `note` is handed
// to the model as tool-error text, so it has to read as an instruction.
async function resolve(src: Source, name: string): Promise<ResolveResult> {
  const rows = await matchByName(src, name);

  if (rows.length === 0) {
    const known = await allNames(src);
    return {
      ok: false,
      error: `unknown_${src.errorSuffix}`,
      note: `No ${src.singular} matching "${name}". ${src.knownLabel}: ${known.join(', ') || src.emptyList}.`,
    };
  }

  // An exact hit wins outright, however many substring matches came with it.
  // Only a substring match with rivals is genuinely ambiguous.
  const exact = rows[0].name.toLowerCase() === name.toLowerCase() ? rows[0] : null;
  if (!exact && rows.length > 1) {
    return {
      ok: false,
      error: `ambiguous_${src.errorSuffix}`,
      note: `"${name}" matches multiple ${src.plural}. Ask the user which they meant.`,
      candidates: rows.map((r) => r.name),
    };
  }

  const pick = exact ?? rows[0];
  return { ok: true, id: pick.id, name: pick.name };
}

export const resolveShow = (name: string) => resolve(SHOWS, name);
export const resolveShowGroup = (name: string) => resolve(GROUPS, name);

// Best-guess id only, for callers with no one to disambiguate with (eval).
export async function lookupShowId(name: string): Promise<number | null> {
  return (await matchByName(SHOWS, name))[0]?.id ?? null;
}

export async function lookupShowGroupId(name: string): Promise<number | null> {
  return (await matchByName(GROUPS, name))[0]?.id ?? null;
}
