import { NextResponse } from 'next/server';
import {
  getChunkRange,
  getEpisodeMeta,
  getEpisodeTurns,
  TRANSCRIPT_TURN_LIMIT,
} from '@/lib/transcript';

export const runtime = 'nodejs';

type Params = { params: Promise<{ episode_id: string }> };

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(request: Request, { params }: Params) {
  const { episode_id: rawEpisodeId } = await params;
  const episode_id = safeDecode(rawEpisodeId);

  const url = new URL(request.url);
  const turnParam = parsePositiveInt(url.searchParams.get('turn'));
  const chunkParam = parsePositiveInt(url.searchParams.get('chunk'));

  const [episode, turns] = await Promise.all([
    getEpisodeMeta(episode_id),
    getEpisodeTurns(episode_id),
  ]);
  if (!episode) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let highlight: { start: number; end: number } | null = null;
  let scrollTarget: number | null = null;

  if (turnParam != null) {
    const belongs = turns.some((t) => t.turn_id === turnParam);
    if (belongs) {
      highlight = { start: turnParam, end: turnParam };
      scrollTarget = turnParam;
    }
  } else if (chunkParam != null) {
    const range = await getChunkRange(chunkParam);
    if (range && range.episode_id === episode_id) {
      highlight = { start: range.start_turn_id, end: range.end_turn_id };
      scrollTarget = range.start_turn_id;
    }
  }

  return NextResponse.json({
    episode,
    turns,
    highlight,
    scrollTarget,
    truncated: turns.length === TRANSCRIPT_TURN_LIMIT,
  });
}
