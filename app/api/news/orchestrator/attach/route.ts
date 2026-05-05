import { z } from 'zod';

import { extractUrlToArticle } from '@/lib/orchestrator/source-gathering';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import {
  deriveApprovedTopics,
  type OrchestratorRun,
  type RatedArticle,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.object({
  chatId: z.string().min(1),
  topicIndex: z.number().int().min(0),
  urls: z.array(z.string().url()).min(1).max(10),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-attach:${ip}`);
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
  if (run.stage === 'gathering' || run.stage === 'crafting') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }
  if (!run.distill) {
    return Response.json({ error: 'no_topics_yet' }, { status: 409 });
  }
  if (body.topicIndex >= run.distill.topics.length) {
    return Response.json({ error: 'invalid_topic_index' }, { status: 400 });
  }

  const existingUrls = new Set(run.articles.map((a) => a.url));
  const fresh = body.urls.filter((u) => !existingUrls.has(u));
  if (fresh.length === 0) {
    return Response.json({
      stage: run.stage,
      distill: run.distill,
      addedCount: 0,
      note: 'all_urls_already_attached',
    });
  }

  const articles = await Promise.all(
    fresh.map((u) => extractUrlToArticle(u, run.today)),
  );

  const augmented: RatedArticle[] = articles.map((article) => ({
    article,
    relevance: 60,
    credibility: 60,
    completeness: 60,
    avgScore: 60,
    provenance: 'manual',
  }));

  const updatedTopics = run.distill.topics.map((t, i) =>
    i === body.topicIndex ? { ...t, articles: [...t.articles, ...augmented] } : t,
  );

  // Don't flip stage or clear finalScript here — attaching a URL during
  // post-script edits keeps the prior draft visible until the writer
  // explicitly regenerates. But we DO refresh `approvedTopics` so that the
  // refine route (which reads from the snapshot) picks up the new sources.
  const updatedDistill = { ...run.distill, topics: updatedTopics };
  const updated: OrchestratorRun = {
    ...run,
    articles: [...run.articles, ...articles],
    distill: updatedDistill,
    approvedTopics: run.approvedTopicIndices
      ? deriveApprovedTopics(updatedDistill.topics, run.approvedTopicIndices)
      : run.approvedTopics,
    updatedAt: new Date().toISOString(),
  };
  await saveRun(updated);

  return Response.json({
    stage: updated.stage,
    distill: updated.distill,
    addedCount: articles.length,
  });
}
