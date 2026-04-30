import { ensureChatTables, purgeExpired } from '@/lib/chats';

export const runtime = 'nodejs';

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
  return header === `Bearer ${expected}`;
}

async function run(req: Request) {
  if (!authorized(req)) {
    return new Response('Unauthorized', { status: 401 });
  }
  await ensureChatTables();
  const deleted = await purgeExpired();
  console.log(JSON.stringify({ event: 'chats.purge', deleted }));
  return Response.json({ deleted });
}

// Vercel Cron defaults to GET; allow POST too for manual triggering.
export const GET = run;
export const POST = run;
