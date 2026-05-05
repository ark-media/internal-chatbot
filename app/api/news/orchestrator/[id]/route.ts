import { ensureOrchestratorTables, loadRun } from '@/lib/orchestrator/state';

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
