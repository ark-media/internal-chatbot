import { z } from 'zod';

import {
  inAcceptableRange,
  keywordSearch,
} from '@/lib/orchestrator/source-gathering';
import { ensureOrchestratorTables, loadRun } from '@/lib/orchestrator/state';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// One Tavily /search call, no extraction — fast.
export const maxDuration = 60;

const bodySchema = z.object({
  chatId: z.string().min(1),
  query: z.string().trim().min(2).max(200),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-search:${ip}`);
  if (!ok) return new Response('Rate limit exceeded', { status: 429 });

  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return new Response('Forbidden', { status: 403 });
      }
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return Response.json({ error: 'invalid_body', detail: String(err) }, { status: 400 });
  }

  const run = await loadRun(body.chatId);
  if (!run) return Response.json({ error: 'run_not_found' }, { status: 404 });
  // Keyword search is a triage-stage tool — the writer adds hits to the raw
  // article pool, which only exists before grouping.
  if (run.stage !== 'triage') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  try {
    const hits = await keywordSearch(body.query, req.signal);
    // Flag freshness against the run's date so the search panel shows the
    // same "older story" badge the triage list does.
    const flagged = hits.map((h) => ({
      ...h,
      isFlagged: !inAcceptableRange(run.today, h.publicationDate),
    }));
    return Response.json({ hits: flagged });
  } catch (err) {
    if (req.signal.aborted) {
      return new Response('client closed request', { status: 499 });
    }
    console.error(
      JSON.stringify({ event: 'orchestrator.search.error', chatId: body.chatId, err: String(err) }),
    );
    return Response.json(
      { error: 'search_failed', detail: String(err).slice(0, 300) },
      { status: 500 },
    );
  }
}
