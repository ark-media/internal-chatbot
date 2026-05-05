import { sql } from '@/lib/db';
import { ensureOrchestratorTables } from '@/lib/orchestrator/state';

export const runtime = 'nodejs';

export async function GET() {
  await ensureOrchestratorTables();

  const rows = (await sql`
    SELECT chat_id, today, stage, updated_at
      FROM orchestrator_runs
     WHERE expires_at > NOW()
     ORDER BY updated_at DESC
     LIMIT 50
  `) as unknown as Array<{
    chat_id: string;
    today: string;
    stage: string;
    updated_at: Date | string;
  }>;

  const chats = rows.map((r) => {
    const updated_at =
      typeof r.updated_at === 'string' ? r.updated_at : r.updated_at.toISOString();
    // Multiple runs can share the same `today` (the writer kicked off two
    // takes the same morning). Append HH:MM from updated_at so the sidebar
    // can disambiguate them at a glance.
    const hhmm = new Date(updated_at).toISOString().slice(11, 16);
    return {
      id: r.chat_id,
      title: `News script — ${r.today} ${hhmm}`,
      updated_at,
      stage: r.stage,
    };
  });

  return Response.json({ chats });
}
