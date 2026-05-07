import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { buildReviewerSystemContent, reflectLoop } from '@/lib/orchestrator/reflect';
import { buildCachedSystemContent, craftScript } from '@/lib/orchestrator/script-craft';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
  saveRunIfStage,
} from '@/lib/orchestrator/state';
import { deriveApprovedTopics } from '@/lib/orchestrator/types';
import { loadStyleProfile } from '@/lib/orchestrator/style-memory';
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
  if (!run.distill) {
    return Response.json({ error: 'no_topics', stage: run.stage }, { status: 409 });
  }
  // Allow regenerate from `complete`. Reject only stages where topics aren't
  // ready (gathering) or where another generate is mid-flight (crafting).
  if (run.stage !== 'checkpoint' && run.stage !== 'complete') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  // Filter and validate the approved indices first so we fail fast before
  // claiming the lease. Drop indices that are out of range or point to a
  // topic with zero attached articles.
  const validatedIndices = body.approvedTopicIndices
    .filter((i) => i < run.distill!.topics.length)
    .filter((i) => run.distill!.topics[i].articles.length > 0);
  const approvedTopics = deriveApprovedTopics(run.distill.topics, validatedIndices);

  if (approvedTopics.length === 0) {
    return Response.json(
      { error: 'no_topics_approved', detail: 'Approved topics must have at least one source attached.' },
      { status: 400 },
    );
  }

  const started = Date.now();

  // Atomic CAS on stage. Without this, two concurrent /generate calls would
  // both observe stage='complete' and both flip to 'crafting' — wasting a
  // model call and racing on the final saveRun.
  const claimed = await saveRunIfStage(
    {
      ...run,
      stage: 'crafting',
      approvedTopics,
      approvedTopicIndices: validatedIndices,
      updatedAt: new Date().toISOString(),
    },
    ['checkpoint', 'complete'],
  );
  if (!claimed) {
    return Response.json(
      { error: 'wrong_stage', detail: 'Another generate call is already in progress for this run.' },
      { status: 409 },
    );
  }

  try {
    const [exampleScripts, styleProfile] = await Promise.all([
      getNewsExamples(),
      loadStyleProfile(),
    ]);
    const cachedSystemContent = buildCachedSystemContent({
      topics: approvedTopics,
      exampleScripts,
      today: run.today,
      styleProfile: styleProfile.text,
    });

    // Reviewer content build reads the editorial checklist from disk on cold
    // start; warm calls are cached. Run it in parallel with the writer so the
    // cold-start read overlaps with the Sonnet draft instead of serializing.
    const [cachedReviewerSystemContent, initialScript] = await Promise.all([
      buildReviewerSystemContent({
        exampleScripts,
        styleProfile: styleProfile.text,
      }),
      craftScript({ cachedSystemContent }),
    ]);

    const outcome = await reflectLoop({
      initialScript,
      approvedTopics,
      cachedSystemContent,
      cachedReviewerSystemContent,
    });

    await saveRun({
      ...run,
      stage: 'complete',
      approvedTopics,
      approvedTopicIndices: validatedIndices,
      finalScript: outcome.finalScript,
      // Regenerate wipes the refine history — the prior versions belonged
      // to a different generation and would be misleading to keep.
      scriptVersions: [],
      refineHistory: [],
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
    // If regenerating from a completed run, keep stage='complete' so the
    // prior script stays visible — only first-time generate failures should
    // park the run in 'error'.
    const keepComplete = run.stage === 'complete' && run.finalScript !== null;
    await saveRun({
      ...run,
      stage: keepComplete ? 'complete' : 'error',
      approvedTopics,
      approvedTopicIndices: validatedIndices,
      errorMessage: String(err).slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
    console.error(
      JSON.stringify({ event: 'orchestrator.generate.error', err: String(err) }),
    );
    return Response.json(
      {
        stage: keepComplete ? 'complete' : 'error',
        errorMessage: String(err).slice(0, 500),
      },
      { status: 500 },
    );
  }
}
