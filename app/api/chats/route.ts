import { ensureChatTables, isSurface, listChats } from '@/lib/chats';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  await ensureChatTables();

  const url = new URL(req.url);
  const surfaceParam = url.searchParams.get('surface');
  if (!isSurface(surfaceParam)) {
    return Response.json(
      { error: 'invalid_surface', expected: ['archive', 'prep', 'news'] },
      { status: 400 },
    );
  }

  const chats = await listChats(surfaceParam);
  return Response.json({ chats });
}
