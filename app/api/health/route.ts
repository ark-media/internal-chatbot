import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const rows = (await sql`SELECT 1 AS ok`) as unknown as { ok: number }[];
    return Response.json({ ok: rows[0]?.ok === 1 });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
