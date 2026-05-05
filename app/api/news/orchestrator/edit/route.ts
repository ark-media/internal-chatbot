import { z } from 'zod';

import { computeMetadata } from '@/lib/orchestrator/script-craft';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import type { Script } from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 30;

const bodySchema = z.object({
  chatId: z.string().min(1),
  fullText: z.string().min(1).max(30_000),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-edit:${ip}`);
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

  const trimmed = body.fullText.trim();
  if (trimmed === run.finalScript.fullText.trim()) {
    // No-op: writer hit Save without changing anything. Return the same
    // shape as the success path plus a `noOp` marker so the client can
    // distinguish "saved a new version" from "nothing to save" without
    // diffing payloads.
    return Response.json({
      script: run.finalScript,
      version: run.refineHistory.length,
      refineHistory: run.refineHistory,
      noOp: true,
    });
  }

  const newScript: Script = {
    fullText: trimmed,
    metadata: computeMetadata(trimmed),
  };
  const newVersion = run.refineHistory.length + 1;
  const updatedVersions = [...run.scriptVersions, run.finalScript];
  const updatedHistory = [
    ...run.refineHistory,
    {
      instruction: 'Inline edit',
      at: new Date().toISOString(),
      version: newVersion,
    },
  ];

  await saveRun({
    ...run,
    finalScript: newScript,
    scriptVersions: updatedVersions,
    refineHistory: updatedHistory,
    updatedAt: new Date().toISOString(),
  });

  console.log(
    JSON.stringify({
      event: 'orchestrator.edit.complete',
      chatId: body.chatId,
      version: newVersion,
      charsBefore: run.finalScript.fullText.length,
      charsAfter: trimmed.length,
    }),
  );

  return Response.json({
    script: newScript,
    version: newVersion,
    refineHistory: updatedHistory,
  });
}
