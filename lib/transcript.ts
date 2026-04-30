import { sql } from '@/lib/db';

// Defensive ceiling — real episodes are well under this. Caps the worst-case
// HTML payload and DOM size if a malformed ingest ever produces a runaway turn count.
export const TRANSCRIPT_TURN_LIMIT = 5000;

export type TranscriptEpisode = {
  episode_id: string;
  title: string;
  date: string | null;
  show: string;
  drive_url: string | null;
};

export type TranscriptTurn = {
  turn_id: number;
  turn_index: number;
  section: string | null;
  speaker: string;
  text: string;
};

export type ChunkRange = {
  chunk_id: number;
  episode_id: string;
  start_turn_id: number;
  end_turn_id: number;
};

export async function getEpisodeMeta(
  episodeId: string,
): Promise<TranscriptEpisode | null> {
  const rows = (await sql`
    SELECT e.episode_id,
           e.title,
           to_char(e.date, 'YYYY-MM-DD') AS date,
           s.name AS show,
           e.drive_url
    FROM episodes e
    JOIN shows s ON s.show_id = e.show_id
    WHERE e.episode_id = ${episodeId}
    LIMIT 1
  `) as unknown as TranscriptEpisode[];
  return rows[0] ?? null;
}

// turn_id is SERIAL and inserted in turn_index order, so highlight membership
// (turn_id ∈ [chunk.start_turn_id, chunk.end_turn_id]) is sound.
export async function getEpisodeTurns(
  episodeId: string,
): Promise<TranscriptTurn[]> {
  const rows = (await sql`
    SELECT t.turn_id,
           t.turn_index,
           t.section,
           sp.canonical_name AS speaker,
           t.text
    FROM turns t
    JOIN speakers sp ON sp.speaker_id = t.speaker_id
    WHERE t.episode_id = ${episodeId}
    ORDER BY t.turn_index ASC
    LIMIT ${TRANSCRIPT_TURN_LIMIT}
  `) as unknown as TranscriptTurn[];
  return rows;
}

export async function getChunkRange(chunkId: number): Promise<ChunkRange | null> {
  const rows = (await sql`
    SELECT chunk_id, episode_id, start_turn_id, end_turn_id
    FROM chunks
    WHERE chunk_id = ${chunkId}
    LIMIT 1
  `) as unknown as ChunkRange[];
  return rows[0] ?? null;
}
