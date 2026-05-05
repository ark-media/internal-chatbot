import { sql } from '../db';
import type { OrchestratorRun, OrchestratorStage } from './types';

let initPromise: Promise<void> | null = null;

export function ensureOrchestratorTables(): Promise<void> {
  return (initPromise ??= (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS orchestrator_runs (
          chat_id     TEXT PRIMARY KEY,
          stage       TEXT NOT NULL,
          today       TEXT NOT NULL,
          timezone    TEXT NOT NULL,
          state       JSONB NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_orch_runs_expires ON orchestrator_runs (expires_at)`;
    } catch (err) {
      initPromise = null;
      console.error('Failed to ensure orchestrator tables:', err);
      throw err;
    }
  })());
}

type RunStatePayload = Omit<OrchestratorRun, 'chatId' | 'stage' | 'today' | 'timezone' | 'updatedAt'>;

export async function saveRun(run: OrchestratorRun): Promise<void> {
  const payload: RunStatePayload = {
    articles: run.articles,
    distill: run.distill,
    approvedTopics: run.approvedTopics,
    finalScript: run.finalScript,
    iterations: run.iterations,
    errorMessage: run.errorMessage,
  };
  const stateJson = JSON.stringify(payload);
  await sql`
    INSERT INTO orchestrator_runs (chat_id, stage, today, timezone, state)
    VALUES (${run.chatId}, ${run.stage}, ${run.today}, ${run.timezone}, ${stateJson}::jsonb)
    ON CONFLICT (chat_id) DO UPDATE
      SET stage = EXCLUDED.stage,
          today = EXCLUDED.today,
          timezone = EXCLUDED.timezone,
          state = EXCLUDED.state,
          updated_at = NOW()
  `;
}

export async function loadRun(chatId: string): Promise<OrchestratorRun | null> {
  const rows = (await sql`
    SELECT chat_id, stage, today, timezone, state, updated_at
      FROM orchestrator_runs
     WHERE chat_id = ${chatId}
  `) as unknown as Array<{
    chat_id: string;
    stage: OrchestratorStage;
    today: string;
    timezone: string;
    state: RunStatePayload;
    updated_at: Date | string;
  }>;
  const row = rows[0];
  if (!row) return null;
  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : row.updated_at.toISOString();
  return {
    chatId: row.chat_id,
    stage: row.stage,
    today: row.today,
    timezone: row.timezone,
    articles: row.state.articles ?? [],
    distill: row.state.distill ?? null,
    approvedTopics: row.state.approvedTopics ?? null,
    finalScript: row.state.finalScript ?? null,
    iterations: row.state.iterations ?? 0,
    errorMessage: row.state.errorMessage ?? null,
    updatedAt,
  };
}

export async function deleteRun(chatId: string): Promise<void> {
  await sql`DELETE FROM orchestrator_runs WHERE chat_id = ${chatId}`;
}
