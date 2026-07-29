import { sql } from './db';

// A compact "what recently aired" digest for the news chat's cached context
// block. Ark News Daily titles name the day's stories ("Iran, AIPAC, and the
// online antisemitism surge"), so air date + title is enough for the model to
// spot repeats and skip re-explaining; searchCorpus has the full transcript
// when it needs the detail. Returns '' when the show id is unknown, the query
// fails, or nothing has aired, so callers can simply omit the section.
//
// Cache note: this string sits inside the byte-stable context prefix of the
// news chat. It changes only when a new episode lands in `episodes` (the
// ingest runs once each morning), which is the same cadence as the date
// context — at most one prefix invalidation per day.
export async function recentEpisodesDigest(
  showId: number | null,
  limit = 7,
): Promise<string> {
  if (showId === null) return '';
  try {
    const rows = (await sql`
      SELECT e.date::text AS date, e.title
        FROM episodes e
       WHERE e.show_id = ${showId}
       ORDER BY e.date DESC, e.title
       LIMIT ${limit}
    `) as unknown as Array<{ date: string; title: string }>;
    if (rows.length === 0) return '';

    return [
      '== Recently Aired Ark News Daily Episodes ==',
      '',
      'Newest first; dates are air dates. Use this for continuity: do not pitch a story a recent episode already covered unless there is a new angle or development, skip re-explaining context the show already explained this week, and prefer follow-up framing where it fits. Use searchCorpus to read how any of these episodes actually told a story.',
      '',
      ...rows.map((r) => `- ${r.date} — ${r.title}`),
    ].join('\n');
  } catch {
    return '';
  }
}
