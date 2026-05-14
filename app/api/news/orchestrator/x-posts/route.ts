import { z } from 'zod';

import { inAcceptableRange } from '@/lib/orchestrator/source-gathering';
import { ensureOrchestratorTables, loadRun } from '@/lib/orchestrator/state';
import { checkRateLimit } from '@/lib/rate-limit';
import { discoverXPostsViaApi, isXApiConfigured } from '@/lib/x-api';

export const runtime = 'nodejs';
// The X API path is a handful of fast HTTP calls — one handle→id lookup plus
// the per-handle timeline reads, fanned out in parallel — not a retrying model
// call, so 60s is ample.
export const maxDuration = 60;

const bodySchema = z.object({
  chatId: z.string().min(1),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-x-posts:${ip}`);
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

  // X API credentials aren't wired up yet. The triage UI hides this behind a
  // disabled "Coming soon" button, but guard here too — a direct call should
  // fail cleanly with a known shape, not throw deep in `discoverXPostsViaApi`.
  if (!isXApiConfigured()) {
    return Response.json(
      {
        error: 'not_configured',
        detail: 'Pulling X posts is coming soon — the X API is not configured yet.',
      },
      { status: 503 },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return Response.json({ error: 'invalid_body', detail: String(err) }, { status: 400 });
  }

  const run = await loadRun(body.chatId);
  if (!run) return Response.json({ error: 'run_not_found' }, { status: 404 });
  // Pulling X posts is a triage-stage tool — the writer adds hits to the raw
  // article pool, which only exists before grouping.
  if (run.stage !== 'triage') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  try {
    const hits = await discoverXPostsViaApi(run.today, req.signal);
    // Flag freshness against the run's date so X hits show the same "older
    // story" badge the triage list and keyword search do.
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
      JSON.stringify({ event: 'orchestrator.x_posts.error', chatId: body.chatId, err: String(err) }),
    );
    return Response.json(
      { error: 'x_posts_failed', detail: String(err).slice(0, 300) },
      { status: 500 },
    );
  }
}
