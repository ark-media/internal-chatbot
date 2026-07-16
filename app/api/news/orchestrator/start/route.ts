// Create a scriptwriter run. The client generates the chat id, POSTs here,
// then navigates to the chat surface and sends the first message — which
// triggers the sourcing turn in /chat.

import { ensureScriptRunTables, loadRun, saveRun } from '@/lib/scriptwriter/state';
import { newRun } from '@/lib/scriptwriter/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  await ensureScriptRunTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`scripts:${ip}`);
  if (!ok) return new Response('Rate limit exceeded', { status: 429 });

  // CSRF defense-in-depth: Basic Auth credentials are replayed cross-site, so
  // reject state-mutating POSTs whose Origin doesn't match the host.
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return new Response('Forbidden', { status: 403 });
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  let body: { chatId?: string; today?: string; timezone?: string; prompt?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { chatId, today, timezone } = body;
  if (
    typeof chatId !== 'string' ||
    !chatId ||
    typeof today !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(today) ||
    typeof timezone !== 'string' ||
    !timezone
  ) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Idempotent: a resubmitted start for an existing run is a no-op.
  const existing = await loadRun(chatId);
  if (existing) return Response.json({ ok: true, existing: true });

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const run = newRun({
    chatId,
    today,
    timezone,
    originalPrompt: prompt.length > 0 ? prompt : null,
  });
  await saveRun(run);
  return Response.json({ ok: true });
}
