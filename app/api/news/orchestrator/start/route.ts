import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { distillTopics } from '@/lib/orchestrator/distill';
import { gatherSources } from '@/lib/orchestrator/source-gathering';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import type { OrchestratorRun } from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.object({
  chatId: z.string().min(1),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).default('America/New_York'),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-start:${ip}`);
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

  const { chatId, today, timezone } = body;
  const started = Date.now();

  // If a run already exists for this chat, allow re-running but reset state.
  // The orchestrator is intentionally single-shot per chat for now.
  const initial: OrchestratorRun = {
    chatId,
    stage: 'gathering',
    today,
    timezone,
    articles: [],
    distill: null,
    approvedTopics: null,
    finalScript: null,
    iterations: 0,
    errorMessage: null,
    updatedAt: new Date().toISOString(),
  };
  await saveRun(initial);

  try {
    const [articles, exampleScripts] = await Promise.all([
      gatherSources({ today, timezone }),
      getNewsExamples(),
    ]);

    if (articles.length === 0) {
      const errored: OrchestratorRun = {
        ...initial,
        stage: 'error',
        errorMessage:
          'No articles found for the acceptable date range. Try again or seed manually.',
        updatedAt: new Date().toISOString(),
      };
      await saveRun(errored);
      return Response.json(
        { stage: 'error', errorMessage: errored.errorMessage },
        { status: 200 },
      );
    }

    const distill = await distillTopics(articles, exampleScripts);

    const run: OrchestratorRun = {
      ...initial,
      stage: 'checkpoint',
      articles,
      distill,
      updatedAt: new Date().toISOString(),
    };
    await saveRun(run);

    console.log(
      JSON.stringify({
        event: 'orchestrator.start.complete',
        chatId,
        ms: Date.now() - started,
        articleCount: articles.length,
        topicCount: distill.topics.length,
      }),
    );

    return Response.json({
      stage: 'checkpoint',
      distill,
      articleCount: articles.length,
    });
  } catch (err) {
    const errored = await loadRun(chatId);
    if (errored) {
      await saveRun({
        ...errored,
        stage: 'error',
        errorMessage: String(err).slice(0, 500),
        updatedAt: new Date().toISOString(),
      });
    }
    console.error(JSON.stringify({ event: 'orchestrator.start.error', chatId, err: String(err) }));
    return Response.json(
      { stage: 'error', errorMessage: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
