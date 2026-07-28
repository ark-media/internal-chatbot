import { createHash, timingSafeEqual } from 'node:crypto';

import { ensureChatTables, purgeExpired } from '@/lib/chats';
import { sql } from '@/lib/db';
import { ensureScriptRunTables } from '@/lib/scriptwriter/state';
import { errorEvent, logEvent } from '@/lib/log-event';

export const runtime = 'nodejs';

// Constant-time string compare. Hashing both sides to a fixed-length digest
// before comparing means timingSafeEqual never throws on length mismatch and
// the comparison itself doesn't leak length or content via timing.
function safeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Loud config error: a missing CRON_SECRET means the daily purge silently
    // 401s forever, so expired chats accumulate. Surface it noisily.
    errorEvent('cron.misconfigured', { detail: 'CRON_SECRET is not set' });
    return false;
  }
  const header = req.headers.get('authorization');
  if (!header) return false;
  return safeEqual(header, `Bearer ${expected}`);
}

async function run(req: Request) {
  if (!authorized(req)) {
    return new Response('Unauthorized', { status: 401 });
  }
  await ensureChatTables();
  await ensureScriptRunTables();
  const deleted = await purgeExpired();
  const runsPurged = (await sql`
    DELETE FROM script_runs WHERE expires_at < NOW() RETURNING chat_id
  `) as unknown as Array<{ chat_id: string }>;
  // The retired orchestrator_runs table drains on its own 7-day TTL; sweep any
  // leftovers too until the table is dropped. Guarded so a dropped table
  // doesn't fail the whole purge.
  let legacyPurged = 0;
  try {
    const legacy = (await sql`
      DELETE FROM orchestrator_runs WHERE expires_at < NOW() RETURNING chat_id
    `) as unknown as Array<{ chat_id: string }>;
    legacyPurged = legacy.length;
  } catch {
    // Table already dropped — nothing to sweep.
  }
  logEvent('chats.purge', {
    deleted,
    scriptRunsPurged: runsPurged.length,
    legacyOrchestratorRunsPurged: legacyPurged,
  });
  return Response.json({ deleted, scriptRunsPurged: runsPurged.length });
}

// Vercel Cron defaults to GET; allow POST too for manual triggering.
export const GET = run;
export const POST = run;
