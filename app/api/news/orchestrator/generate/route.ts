import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { reflectLoop } from '@/lib/orchestrator/reflect';
import { craftScript } from '@/lib/orchestrator/script-craft';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.object({
  chatId: z.string().min(1),
  approvedTopicIndices: z.array(z.number().int().min(0)).min(1).max(4),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-generate:${ip}`);
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
  if (!run.distill || run.stage !== 'checkpoint') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  const approvedTopics = body.approvedTopicIndices
    .filter((i) => i < run.distill!.topics.length)
    .map((i) => run.distill!.topics[i]);

  if (approvedTopics.length === 0) {
    return Response.json({ error: 'no_topics_approved' }, { status: 400 });
  }

  const started = Date.now();

  await saveRun({ ...run, stage: 'crafting', approvedTopics, updatedAt: new Date().toISOString() });

  try {
    const exampleScripts = await getNewsExamples();

    const initialScript = await craftScript({
      topics: approvedTopics,
      exampleScripts,
      today: run.today,
    });

    const outcome = await reflectLoop({
      initialScript,
      approvedTopics,
      exampleScripts,
      today: run.today,
    });

    await saveRun({
      ...run,
      stage: 'complete',
      approvedTopics,
      finalScript: outcome.finalScript,
      iterations: outcome.iterations,
      updatedAt: new Date().toISOString(),
    });

    console.log(
      JSON.stringify({
        event: 'orchestrator.generate.complete',
        chatId: body.chatId,
        ms: Date.now() - started,
        iterations: outcome.iterations,
        wordCount: outcome.finalScript.metadata.wordCount,
        history: outcome.history,
      }),
    );

    return Response.json({
      stage: 'complete',
      script: outcome.finalScript,
      iterations: outcome.iterations,
    });
  } catch (err) {
    await saveRun({
      ...run,
      stage: 'error',
      approvedTopics,
      errorMessage: String(err).slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
    console.error(
      JSON.stringify({ event: 'orchestrator.generate.error', err: String(err) }),
    );
    return Response.json(
      { stage: 'error', errorMessage: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
