import { sql } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const rows = (await sql`SELECT COUNT(*)::int AS count FROM episodes`) as unknown as { count: number }[];
    return Response.json({ count: rows[0]?.count ?? 0 });
  } catch (e) {
    return Response.json({ count: null, error: String(e) }, { status: 500 });
  }
}
