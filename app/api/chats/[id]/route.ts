import { deleteChat, ensureChatTables, loadChat } from '@/lib/chats';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureChatTables();
  const { id } = await params;

  const chat = await loadChat(id);
  if (!chat) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json({
    id: chat.id,
    surface: chat.surface,
    title: chat.title,
    messages: chat.messages,
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureChatTables();
  const { id } = await params;

  // Require explicit confirmation so a stray fetch from another tab or a UI
  // bug can't silently nuke a chat.
  const url = new URL(req.url);
  if (url.searchParams.get('confirm') !== '1') {
    return Response.json(
      { error: 'confirmation_required', hint: 'pass ?confirm=1' },
      { status: 400 },
    );
  }

  const deleted = await deleteChat(id);
  if (!deleted) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
