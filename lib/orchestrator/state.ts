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

function buildPayload(run: OrchestratorRun): RunStatePayload {
  return {
    articles: run.articles,
    distill: run.distill,
    approvedTopics: run.approvedTopics,
    approvedTopicIndices: run.approvedTopicIndices,
    finalScript: run.finalScript,
    scriptVersions: run.scriptVersions,
    refineHistory: run.refineHistory,
    iterations: run.iterations,
    errorMessage: run.errorMessage,
    lastDistilledVersion: run.lastDistilledVersion,
  };
}

export async function saveRun(run: OrchestratorRun): Promise<void> {
  const stateJson = JSON.stringify(buildPayload(run));
  // Bump expires_at on every save so a long-iterating run doesn't drop out
  // of the list view (which filters WHERE expires_at > NOW()) just because
  // it was first created 7+ days ago.
  await sql`
    INSERT INTO orchestrator_runs (chat_id, stage, today, timezone, state)
    VALUES (${run.chatId}, ${run.stage}, ${run.today}, ${run.timezone}, ${stateJson}::jsonb)
    ON CONFLICT (chat_id) DO UPDATE
      SET stage = EXCLUDED.stage,
          today = EXCLUDED.today,
          timezone = EXCLUDED.timezone,
          state = EXCLUDED.state,
          updated_at = NOW(),
          expires_at = NOW() + INTERVAL '7 days'
  `;
}

// Atomic compare-and-set on the run's stage. Used by /generate to claim
// the `crafting` stage exactly once, even when two writers click Generate
// concurrently. Returns true iff the update happened (i.e. the prior stage
// matched one of `requiredStages`). Caller should treat `false` as "another
// generate is already in flight".
export async function saveRunIfStage(
  run: OrchestratorRun,
  requiredStages: OrchestratorStage[],
): Promise<boolean> {
  const stateJson = JSON.stringify(buildPayload(run));
  const rows = (await sql`
    UPDATE orchestrator_runs
       SET stage = ${run.stage},
           today = ${run.today},
           timezone = ${run.timezone},
           state = ${stateJson}::jsonb,
           updated_at = NOW(),
           expires_at = NOW() + INTERVAL '7 days'
     WHERE chat_id = ${run.chatId}
       AND stage = ANY(${requiredStages}::text[])
   RETURNING chat_id
  `) as unknown as Array<{ chat_id: string }>;
  return rows.length > 0;
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
    approvedTopicIndices: row.state.approvedTopicIndices,
    finalScript: row.state.finalScript ?? null,
    scriptVersions: row.state.scriptVersions ?? [],
    refineHistory: row.state.refineHistory ?? [],
    iterations: row.state.iterations ?? 0,
    errorMessage: row.state.errorMessage ?? null,
    lastDistilledVersion: row.state.lastDistilledVersion,
    updatedAt,
  };
}

export async function deleteRun(chatId: string): Promise<void> {
  await sql`DELETE FROM orchestrator_runs WHERE chat_id = ${chatId}`;
}
