import { z } from 'zod';

import {
  discoverXPosts,
  inAcceptableRange,
} from '@/lib/orchestrator/source-gathering';
import { ensureOrchestratorTables, loadRun } from '@/lib/orchestrator/state';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// Grounded Gemini search scoped to the 15 approved X handles, with the same
// retry-on-empty loop discovery uses — narrower than the old all-outlet pull,
// but still a model call that can retry, so give it the full budget.
export const maxDuration = 300;

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
    const hits = await discoverXPosts(run.today, req.signal);
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
