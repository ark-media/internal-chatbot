import { z } from 'zod';

import { isApprovedSource } from '@/lib/news-sources';
import { inAcceptableRange } from '@/lib/orchestrator/source-gathering';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRunIfUnchanged,
} from '@/lib/orchestrator/state';
import {
  reorderByUrl,
  type Candidate,
  type OrchestratorRun,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// All three actions are pure array mutations on the JSONB blob — no model
// calls, no fetches (extraction is deferred to /group) — so they're fast.
export const maxDuration = 60;

// All three actions mutate `run.candidates` — that array *is* the triage list.
// `reorder` carries the full URL list in the writer's working order; `remove`
// drops one URL; `add` appends a writer-chosen search hit. None of them
// extract — verification and Tavily extraction wait for /group.
const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reorder'),
    chatId: z.string().min(1),
    order: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal('remove'),
    chatId: z.string().min(1),
    url: z.string().min(1),
  }),
  // Discard a whole theme group in one write — the URLs of every candidate
  // under that group. Same effect as N `remove`s, but one CAS so the writer
  // can't lose a race mid-cluster.
  z.object({
    action: z.literal('removeMany'),
    chatId: z.string().min(1),
    urls: z.array(z.string().min(1)).min(1).max(200),
  }),
  z.object({
    action: z.literal('add'),
    chatId: z.string().min(1),
    candidate: z.object({
      title: z.string().min(1).max(500),
      url: z.string().url(),
      source: z.string().min(1).max(200),
      publicationDate: z.string().min(1).max(40).nullable(),
    }),
  }),
]);

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-triage:${ip}`);
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
  // Triage actions only make sense while the run sits in `triage`. Once
  // grouped, the candidate list is frozen behind the topic structure — the UI
  // pushes edits through /topics, /attach, /refetch instead.
  if (run.stage !== 'triage') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  let candidates = run.candidates;
  let extraCandidates = run.extraCandidates;
  if (body.action === 'reorder') {
    candidates = reorderByUrl(run.candidates, body.order);
  } else if (body.action === 'remove') {
    candidates = run.candidates.filter((c) => c.url !== body.url);
  } else if (body.action === 'removeMany') {
    const drop = new Set(body.urls);
    candidates = run.candidates.filter((c) => !drop.has(c.url));
  } else {
    // add — append a writer-chosen search hit, deduped by URL. No extraction:
    // verification + Tavily extract happen at /group with every other
    // candidate. Freshness is re-flagged server-side against the run's date.
    //
    // Re-check the source here even though /search only ever surfaces approved
    // hits — this route is independently reachable, and `gatherCandidates` and
    // `keywordSearch` both apply the same backstop. Keeps the "approved
    // outlets only" invariant true no matter how a candidate enters the pool.
    if (!isApprovedSource(body.candidate.url)) {
      return Response.json(
        { error: 'not_approved', detail: 'URL is not from an approved outlet.' },
        { status: 422 },
      );
    }
    if (run.candidates.some((c) => c.url === body.candidate.url)) {
      return Response.json({
        stage: 'triage',
        candidateCount: run.candidates.length,
        note: 'already_added',
      });
    }
    const added: Candidate = {
      title: body.candidate.title,
      url: body.candidate.url,
      source: body.candidate.source,
      publicationDate: body.candidate.publicationDate,
      isFlagged: !inAcceptableRange(run.today, body.candidate.publicationDate),
    };
    candidates = [...run.candidates, added];
    // Promote from the "See more" overflow pile if it lived there. Without
    // this the same candidate would render in both lists until the next page
    // load: the UI shows extras straight from `run.extraCandidates`.
    if (extraCandidates?.some((c) => c.url === added.url)) {
      extraCandidates = extraCandidates.filter((c) => c.url !== added.url);
    }
  }

  const updated: OrchestratorRun = {
    ...run,
    candidates,
    extraCandidates,
    updatedAt: new Date().toISOString(),
  };

  // Optimistic lock: another tab (or a fast double-action) editing the same
  // run loses the race and gets a 409 so the UI re-fetches the truth.
  const saved = await saveRunIfUnchanged(updated, run.updatedAt);
  if (!saved) {
    return Response.json(
      { error: 'stale_state', detail: 'Run was updated by another request. Reload and retry.' },
      { status: 409 },
    );
  }

  return Response.json({ stage: 'triage', candidateCount: candidates.length });
}
