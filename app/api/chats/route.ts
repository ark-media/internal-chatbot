import { ensureChatTables, isSurface, listChats, SURFACE_VALUES } from '@/lib/chats';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  await ensureChatTables();

  const url = new URL(req.url);
  const surfaceParam = url.searchParams.get('surface');
  if (!isSurface(surfaceParam)) {
    return Response.json(
      { error: 'invalid_surface', expected: SURFACE_VALUES },
      { status: 400 },
    );
  }

  const chats = await listChats(surfaceParam);
  return Response.json({ chats });
}
