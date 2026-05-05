import { z } from 'zod';

import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const bodySchema = z.object({ chatId: z.string().min(1) });

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-undo:${ip}`);
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
  if (run.stage !== 'complete' || !run.finalScript) {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }
  if (run.scriptVersions.length === 0) {
    return Response.json({ error: 'nothing_to_undo' }, { status: 409 });
  }

  const updatedVersions = run.scriptVersions.slice(0, -1);
  const restored = run.scriptVersions[run.scriptVersions.length - 1];
  const updatedHistory = run.refineHistory.slice(0, -1);

  // If the writer ran Save & Learn on a version that we've now undone past,
  // the recorded `lastDistilledVersion` points at a state that no longer
  // exists. Drop it so the UI re-shows "Save & learn" for the restored
  // version instead of claiming it's already been learned.
  const nextLastDistilled =
    typeof run.lastDistilledVersion === 'number' &&
    run.lastDistilledVersion > updatedHistory.length
      ? undefined
      : run.lastDistilledVersion;

  await saveRun({
    ...run,
    finalScript: restored,
    scriptVersions: updatedVersions,
    refineHistory: updatedHistory,
    lastDistilledVersion: nextLastDistilled,
    updatedAt: new Date().toISOString(),
  });

  return Response.json({
    script: restored,
    refineHistory: updatedHistory,
    lastDistilledVersion: nextLastDistilled ?? null,
  });
}
