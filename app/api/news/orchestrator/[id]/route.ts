import {
  deleteRun,
  ensureOrchestratorTables,
  loadRun,
} from '@/lib/orchestrator/state';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureOrchestratorTables();
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return Response.json({ run: null });
  return Response.json({ run });
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
  await ensureOrchestratorTables();
  const { id } = await params;
  await deleteRun(id);
  return Response.json({ ok: true });
}
