// Sidebar list of scriptwriter runs. Title comes from the chat when one
// exists (derived from the writer's first message); falls back to a dated
// label for runs whose first message hasn't been sent yet.

import { sql } from '@/lib/db';
import { ensureChatTables } from '@/lib/chats';
import { ensureScriptRunTables } from '@/lib/scriptwriter/state';

export const runtime = 'nodejs';

export async function GET() {
  await Promise.all([ensureScriptRunTables(), ensureChatTables()]);

  const rows = (await sql`
    SELECT r.chat_id, r.today, r.stage, r.updated_at, c.title
      FROM script_runs r
      LEFT JOIN chats c ON c.id = r.chat_id
     WHERE r.expires_at > NOW()
     ORDER BY r.updated_at DESC
     LIMIT 50
  `) as unknown as Array<{
    chat_id: string;
    today: string;
    stage: string;
    updated_at: Date | string;
    title: string | null;
  }>;

  const chats = rows.map((r) => {
    const updated_at =
      typeof r.updated_at === 'string' ? r.updated_at : r.updated_at.toISOString();
    const hhmm = new Date(updated_at).toISOString().slice(11, 16);
    return {
      id: r.chat_id,
      title: r.title ?? `News script — ${r.today} ${hhmm}`,
      updated_at,
      stage: r.stage,
    };
  });

  return Response.json({ chats });
}
