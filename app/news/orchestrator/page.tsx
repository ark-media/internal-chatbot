import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function NewsOrchestratorIndex() {
  redirect(`/news/orchestrator/${randomUUID()}`);
}
