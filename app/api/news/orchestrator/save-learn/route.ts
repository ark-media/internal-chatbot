// Distills the (initial draft, final draft, refine instructions) tuple from a
// completed orchestrator run into the writer-style profile. The profile is
// then injected into every future script-craft system prompt.
//
// Security note: refine instructions are operator-supplied text that flow
// verbatim into the distill prompt and (post-distillation) into a stored
// system prompt that the script-craft agent sees on every run. Treat this as
// a stored prompt-injection vector and review the profile after each save —
// the team is small and trusted today, but a malicious or careless refine
// could shift the writer's behavior across all subsequent runs.
import { z } from 'zod';

import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import {
  distillStylePreferences,
  loadStyleProfile,
  saveStyleProfile,
  shouldSkipDistillation,
} from '@/lib/orchestrator/style-memory';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.object({ chatId: z.string().min(1) });

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-save-learn:${ip}`);
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
    return Response.json(
      { error: 'invalid_body', detail: String(err) },
      { status: 400 },
    );
  }

  const run = await loadRun(body.chatId);
  if (!run) return Response.json({ error: 'run_not_found' }, { status: 404 });
  if (run.stage !== 'complete' || !run.finalScript) {
    return Response.json(
      { error: 'wrong_stage', stage: run.stage },
      { status: 409 },
    );
  }
  if (run.scriptVersions.length === 0) {
    return Response.json(
      {
        error: 'no_refines',
        detail:
          'Nothing to learn from — refine the script at least once before saving.',
      },
      { status: 409 },
    );
  }

  const currentVersion = run.refineHistory.length;

  // Idempotency guard. The button can be re-clicked across reloads or in a
  // second tab — without this check, each click triggers another paid Sonnet
  // distillation against the same inputs.
  if (
    shouldSkipDistillation({
      refineHistoryLength: currentVersion,
      lastDistilledVersion: run.lastDistilledVersion,
    })
  ) {
    const existing = await loadStyleProfile();
    return Response.json({
      profile: existing.text,
      runsDistilled: existing.runsDistilled,
      lastDistilledVersion: currentVersion,
      cached: true,
    });
  }

  const started = Date.now();

  try {
    const currentProfile = await loadStyleProfile();
    // scriptVersions[0] is the initial AI draft. The current finalScript is
    // the writer-accepted result. Everything between is captured by the
    // refine instructions, in order.
    const originalDraft = run.scriptVersions[0].fullText;
    const finalDraft = run.finalScript.fullText;
    const refineInstructions = run.refineHistory.map((e) => e.instruction);

    const updatedProfile = await distillStylePreferences({
      currentProfile: currentProfile.text,
      originalDraft,
      finalDraft,
      refineInstructions,
    });

    const { runsDistilled } = await saveStyleProfile(updatedProfile);
    await saveRun({
      ...run,
      lastDistilledVersion: currentVersion,
      updatedAt: new Date().toISOString(),
    });

    console.log(
      JSON.stringify({
        event: 'orchestrator.save_learn.complete',
        chatId: body.chatId,
        ms: Date.now() - started,
        profileChars: updatedProfile.length,
        refineCount: refineInstructions.length,
        runsDistilled,
      }),
    );

    return Response.json({
      profile: updatedProfile,
      runsDistilled,
      lastDistilledVersion: currentVersion,
      cached: false,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'orchestrator.save_learn.error',
        err: String(err),
      }),
    );
    return Response.json(
      { error: 'distill_failed', detail: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
