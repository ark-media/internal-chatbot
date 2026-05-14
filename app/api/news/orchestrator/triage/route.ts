import { z } from 'zod';

import { extractUrlToArticle } from '@/lib/orchestrator/source-gathering';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRunIfUnchanged,
} from '@/lib/orchestrator/state';
import {
  reorderArticlesByUrl,
  type OrchestratorRun,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// `reorder`/`remove` are pure array mutations; `add` does one Tavily extract.
// All finish well inside this budget.
export const maxDuration = 60;

// All three actions mutate `run.articles` — that array *is* the triage list.
// `reorder` carries the full URL list in the writer's working order; `remove`
// drops one URL; `add` extracts a writer-chosen search hit and appends it.
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
  z.object({
    action: z.literal('add'),
    chatId: z.string().min(1),
    url: z.string().url(),
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
  // grouped, the article pool is frozen behind the topic structure — the UI
  // pushes edits through /topics, /attach, /refetch instead.
  if (run.stage !== 'triage') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  let articles = run.articles;
  if (body.action === 'reorder') {
    articles = reorderArticlesByUrl(run.articles, body.order);
  } else if (body.action === 'remove') {
    articles = run.articles.filter((a) => a.url !== body.url);
  } else {
    // add — extract the writer-chosen search hit, deduped by URL like every
    // other path that appends to the pool.
    if (run.articles.some((a) => a.url === body.url)) {
      return Response.json({
        stage: 'triage',
        articleCount: run.articles.length,
        note: 'already_added',
      });
    }
    const article = await extractUrlToArticle(body.url, run.today);
    articles = [...run.articles, article];
  }

  const updated: OrchestratorRun = {
    ...run,
    articles,
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

  return Response.json({ stage: 'triage', articleCount: articles.length });
}
