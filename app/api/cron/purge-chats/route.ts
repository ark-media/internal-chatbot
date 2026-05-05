import { createHash, timingSafeEqual } from 'node:crypto';

import { ensureChatTables, purgeExpired } from '@/lib/chats';
import { sql } from '@/lib/db';
import { ensureOrchestratorTables } from '@/lib/orchestrator/state';

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
    console.error(
      JSON.stringify({ event: 'cron.misconfigured', detail: 'CRON_SECRET is not set' }),
    );
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
  await ensureOrchestratorTables();
  const deleted = await purgeExpired();
  const orchPurged = (await sql`
    DELETE FROM orchestrator_runs WHERE expires_at < NOW() RETURNING chat_id
  `) as unknown as Array<{ chat_id: string }>;
  console.log(
    JSON.stringify({
      event: 'chats.purge',
      deleted,
      orchestratorRunsPurged: orchPurged.length,
    }),
  );
  return Response.json({ deleted, orchestratorRunsPurged: orchPurged.length });
}

// Vercel Cron defaults to GET; allow POST too for manual triggering.
export const GET = run;
export const POST = run;
