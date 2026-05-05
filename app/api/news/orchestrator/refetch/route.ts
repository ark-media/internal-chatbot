import { z } from 'zod';

import { gatherSources } from '@/lib/orchestrator/source-gathering';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import type { Article, RatedArticle } from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.object({
  chatId: z.string().min(1),
  topicIndex: z.number().int().min(0),
  guidance: z.string().min(1).max(500),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-refetch:${ip}`);
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
  if (run.stage !== 'checkpoint' || !run.distill) {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }
  if (body.topicIndex >= run.distill.topics.length) {
    return Response.json({ error: 'invalid_topic_index' }, { status: 400 });
  }

  const targetTopic = run.distill.topics[body.topicIndex];
  const started = Date.now();

  try {
    const newArticles = await gatherSources({
      today: run.today,
      timezone: run.timezone,
      extraGuidance: `Specifically find more articles on this topic: "${targetTopic.topic}". ${targetTopic.description}\n\nWriter guidance: ${body.guidance}`,
      maxArticles: 8,
    });

    // Dedupe against existing articles by URL.
    const existingUrls = new Set(run.articles.map((a) => a.url));
    const fresh = newArticles.filter((a) => !existingUrls.has(a.url));

    // Merge into the topic with default mid-range scores; writer can re-run
    // distill if they want re-rating. Per spec: no new distill pass on refetch.
    const augmented: RatedArticle[] = fresh.map((article: Article) => ({
      article,
      relevance: 60,
      credibility: 60,
      completeness: 60,
      avgScore: 60,
    }));

    const updatedTopics = run.distill.topics.map((t, i) =>
      i === body.topicIndex
        ? { ...t, articles: [...t.articles, ...augmented] }
        : t,
    );

    const merged = {
      ...run,
      articles: [...run.articles, ...fresh],
      distill: { ...run.distill, topics: updatedTopics },
      updatedAt: new Date().toISOString(),
    };
    await saveRun(merged);

    console.log(
      JSON.stringify({
        event: 'orchestrator.refetch.complete',
        chatId: body.chatId,
        topicIndex: body.topicIndex,
        ms: Date.now() - started,
        addedCount: fresh.length,
      }),
    );

    return Response.json({
      stage: 'checkpoint',
      distill: merged.distill,
      addedCount: fresh.length,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'orchestrator.refetch.error', err: String(err) }),
    );
    return Response.json({ error: 'refetch_failed', detail: String(err).slice(0, 300) }, { status: 500 });
  }
}
