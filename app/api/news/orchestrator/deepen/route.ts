import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { deepenTopic } from '@/lib/orchestrator/deepen';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRunIfUnchanged,
} from '@/lib/orchestrator/state';
import { deriveApprovedTopics } from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.object({
  chatId: z.string().min(1),
  topicIndex: z.number().int().min(0),
  guidance: z.string().max(2000).optional().default(''),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-deepen:${ip}`);
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
  if (run.stage !== 'checkpoint') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }
  if (!run.distill || body.topicIndex >= run.distill.topics.length) {
    return Response.json({ error: 'topic_not_found' }, { status: 409 });
  }
  const topic = run.distill.topics[body.topicIndex];
  if (topic.articles.length === 0) {
    return Response.json({ error: 'no_sources' }, { status: 409 });
  }

  const started = Date.now();
  const expectedUpdatedAt = run.updatedAt;

  try {
    const exampleScripts = await getNewsExamples();
    const { description, quotesByIndex } = await deepenTopic(
      topic,
      body.guidance,
      exampleScripts,
    );

    // Merge: replace the description, append new (deduped) quotes per article.
    const nextTopic = {
      ...topic,
      description,
      articles: topic.articles.map((rated, i) => {
        const extra = quotesByIndex.get(i) ?? [];
        if (extra.length === 0) return rated;
        const existing = new Set(rated.keyQuotes ?? []);
        const merged = [...(rated.keyQuotes ?? [])];
        for (const q of extra) {
          if (!existing.has(q)) {
            merged.push(q);
            existing.add(q);
          }
        }
        return { ...rated, keyQuotes: merged };
      }),
    };

    const topics = run.distill.topics.map((t, i) =>
      i === body.topicIndex ? nextTopic : t,
    );
    const distill = { ...run.distill, topics };
    // Keep the materialized approved snapshot in sync, like /topics + /attach do.
    const approvedTopics = run.approvedTopicIndices
      ? deriveApprovedTopics(topics, run.approvedTopicIndices)
      : run.approvedTopics;

    const saved = await saveRunIfUnchanged(
      {
        ...run,
        distill,
        approvedTopics,
        updatedAt: new Date().toISOString(),
      },
      expectedUpdatedAt,
    );
    if (!saved) {
      return Response.json(
        { error: 'conflict', detail: 'The run changed while deepening. Try again.' },
        { status: 409 },
      );
    }

    console.log(
      JSON.stringify({
        event: 'orchestrator.deepen.complete',
        chatId: body.chatId,
        topicIndex: body.topicIndex,
        ms: Date.now() - started,
      }),
    );

    return Response.json({ stage: 'checkpoint', distill });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'orchestrator.deepen.error', chatId: body.chatId, err: String(err) }),
    );
    return Response.json({ error: 'deepen_failed', detail: String(err).slice(0, 300) }, { status: 500 });
  }
}
