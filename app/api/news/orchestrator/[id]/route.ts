// GET one scriptwriter run (+ its stored chat messages) for client bootstrap;
// DELETE removes the run and its chat.

import { deleteChat, ensureChatTables, loadChat, toUIMessages } from '@/lib/chats';
import { deleteRun, ensureScriptRunTables, loadRun } from '@/lib/scriptwriter/state';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await Promise.all([ensureScriptRunTables(), ensureChatTables()]);
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return Response.json({ run: null, messages: [] }, { status: 404 });
  const chat = await loadChat(id).catch(() => null);
  return Response.json({
    run,
    messages: chat ? toUIMessages(chat.messages) : [],
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return new Response('Forbidden', { status: 403 });
      }
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }
  await Promise.all([ensureScriptRunTables(), ensureChatTables()]);
  const { id } = await params;
  await deleteRun(id);
  await deleteChat(id).catch(() => false);
  return Response.json({ ok: true });
}
