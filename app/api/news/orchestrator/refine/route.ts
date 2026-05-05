import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import {
  buildCachedSystemContent,
  refineScript,
} from '@/lib/orchestrator/script-craft';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import { loadStyleProfile } from '@/lib/orchestrator/style-memory';
import { deriveApprovedTopics } from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.object({
  chatId: z.string().min(1),
  instruction: z.string().min(1).max(2000),
});

// Number of recent edits to surface in the user prompt as a "do not undo"
// hint. Small enough to stay cheap, large enough to give the model context
// across a typical refinement session.
const RECENT_EDITS_WINDOW = 3;

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-refine:${ip}`);
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
  if (run.stage !== 'complete' || !run.finalScript || !run.distill) {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  // Rebuild approved topics from the *current* distill rather than the
  // snapshot taken at /generate time. This way, any articles that the
  // writer attached or refetched after the script was completed flow
  // into the refine prompt — otherwise the model would be told to
  // incorporate sources it can't actually see.
  const approvedTopics = deriveApprovedTopics(
    run.distill.topics,
    run.approvedTopicIndices,
  );
  if (approvedTopics.length === 0) {
    return Response.json(
      { error: 'no_topics_approved', detail: 'No approved topics with sources are available — regenerate the script first.' },
      { status: 409 },
    );
  }

  const started = Date.now();

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

    const recentEdits = run.refineHistory
      .slice(-RECENT_EDITS_WINDOW)
      .map((e) => ({ instruction: e.instruction, version: e.version }));

    const newScript = await refineScript({
      cachedSystemContent,
      previousScript: run.finalScript.fullText,
      instruction: body.instruction,
      recentEdits,
    });

    const newVersion = run.refineHistory.length + 1;
    const updatedVersions = [...run.scriptVersions, run.finalScript];
    const updatedHistory = [
      ...run.refineHistory,
      {
        instruction: body.instruction,
        at: new Date().toISOString(),
        version: newVersion,
      },
    ];

    await saveRun({
      ...run,
      // Keep the refreshed snapshot in sync with what we actually used so
      // subsequent loads see the post-attach/post-refetch article set.
      approvedTopics,
      finalScript: newScript,
      scriptVersions: updatedVersions,
      refineHistory: updatedHistory,
      updatedAt: new Date().toISOString(),
    });

    console.log(
      JSON.stringify({
        event: 'orchestrator.refine.complete',
        chatId: body.chatId,
        ms: Date.now() - started,
        version: newVersion,
        wordCount: newScript.metadata.wordCount,
      }),
    );

    return Response.json({
      script: newScript,
      version: newVersion,
      refineHistory: updatedHistory,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'orchestrator.refine.error', err: String(err) }),
    );
    return Response.json(
      { error: 'refine_failed', detail: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
