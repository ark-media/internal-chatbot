// Save & Learn: distill the writer's revision behavior on this run into the
// persistent style profile. Signal = initial block drafts vs the approved
// text, plus every revision instruction (block + episode) in order.
//
// Security note: revision instructions are operator-supplied text that flow
// verbatim into the distill prompt and (post-distillation) into a stored
// system prompt every future writer call sees. Treat this as a stored
// prompt-injection vector and review the profile after each save.

import {
  distillStylePreferences,
  loadStyleProfile,
  saveStyleProfile,
  shouldSkipDistillation,
} from '@/lib/orchestrator/style-memory';
import { ensureScriptRunTables, loadRun, saveRun } from '@/lib/scriptwriter/state';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// The distillation is a Sonnet pass over the full block/episode drafts, which
// can be large; give it the same headroom as the chat route rather than 60s.
export const maxDuration = 300;

export async function POST(req: Request) {
  await ensureScriptRunTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`scripts-save-learn:${ip}`);
  if (!ok) return new Response('Rate limit exceeded', { status: 429 });

  // CSRF defense-in-depth: Basic Auth credentials are replayed cross-site.
  // This route triggers a paid distillation and mutates the global style
  // profile, so reject cross-origin POSTs.
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return new Response('Forbidden', { status: 403 });
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  let body: { chatId?: string };
  try {
    body = (await req.json()) as { chatId?: string };
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (typeof body.chatId !== 'string' || !body.chatId) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const run = await loadRun(body.chatId);
  if (!run) return Response.json({ error: 'not_found' }, { status: 404 });

  const topicsWithBlocks = run.topics.filter((t) => t.block !== null);
  if (topicsWithBlocks.length === 0) {
    return Response.json({ error: 'nothing_to_learn' }, { status: 400 });
  }

  if (
    shouldSkipDistillation({
      refineHistoryLength: run.revisionCount,
      lastDistilledVersion: run.lastDistilledVersion,
    })
  ) {
    return Response.json({ ok: true, skipped: true });
  }

  // Initial drafts: the oldest version of each block (blockVersions[0] when
  // revisions happened, else the current text).
  const originalDraft = topicsWithBlocks
    .map((t) => t.blockVersions[0]?.text ?? t.block!.text)
    .join('\n\n');
  const finalDraft =
    run.episode?.fullText ?? topicsWithBlocks.map((t) => t.block!.text).join('\n\n');
  const refineInstructions = [
    ...run.topics.flatMap((t) =>
      t.blockVersions.flatMap((v) => (v.instruction ? [v.instruction] : [])),
    ),
    ...run.episodeVersions.map((v) => v.instruction),
  ];

  try {
    const current = await loadStyleProfile();
    const updated = await distillStylePreferences({
      currentProfile: current.text,
      originalDraft,
      finalDraft,
      refineInstructions,
    });
    const { runsDistilled } = await saveStyleProfile(updated);

    await saveRun({ ...run, lastDistilledVersion: run.revisionCount });

    return Response.json({ ok: true, runsDistilled });
  } catch (err) {
    console.error('save_learn.error', err);
    const detail = err instanceof Error ? err.message.slice(0, 500) : 'unknown';
    return Response.json({ error: 'distill_failed', detail }, { status: 500 });
  }
}
