// Persistence for scriptwriter runs. Same pattern as the retired
// orchestrator_runs table: one JSONB snapshot per chat, plain saves plus a
// stage CAS (claim long operations exactly once) and an optimistic lock
// (concurrent conversational edits must not clobber each other).

import { sql } from '../db';
import type { RunStage, ScriptRun } from './types';

let initPromise: Promise<void> | null = null;

export function ensureScriptRunTables(): Promise<void> {
  return (initPromise ??= (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS script_runs (
          chat_id     TEXT PRIMARY KEY,
          stage       TEXT NOT NULL,
          today       TEXT NOT NULL,
          timezone    TEXT NOT NULL,
          state       JSONB NOT NULL,
          version     INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
        )
      `;
      // Existing deployments predate the version column; add it idempotently.
      await sql`ALTER TABLE script_runs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`;
      await sql`CREATE INDEX IF NOT EXISTS idx_script_runs_expires ON script_runs (expires_at)`;
    } catch (err) {
      initPromise = null;
      console.error('Failed to ensure script_runs table:', err);
      throw err;
    }
  })());
}

// version and updatedAt live in dedicated columns, not the JSONB snapshot.
type RunStatePayload = Omit<
  ScriptRun,
  'chatId' | 'stage' | 'today' | 'timezone' | 'updatedAt' | 'version'
>;

function buildPayload(run: ScriptRun): RunStatePayload {
  return {
    scope: run.scope,
    originalPrompt: run.originalPrompt,
    candidates: run.candidates,
    backups: run.backups,
    topics: run.topics,
    episode: run.episode,
    episodeVersions: run.episodeVersions,
    revisionCount: run.revisionCount,
    lastDistilledVersion: run.lastDistilledVersion,
    errorMessage: run.errorMessage,
  };
}

export async function saveRun(run: ScriptRun): Promise<void> {
  const stateJson = JSON.stringify(buildPayload(run));
  // expires_at is bumped on every save so an active run never drops out of the
  // sidebar list. version increments on every write, available for optimistic-
  // concurrency checks (the sourcing claim itself CASes on stage — claimSourcing).
  await sql`
    INSERT INTO script_runs (chat_id, stage, today, timezone, state, version, updated_at)
    VALUES (${run.chatId}, ${run.stage}, ${run.today}, ${run.timezone}, ${stateJson}::jsonb, 0, date_trunc('milliseconds', NOW()))
    ON CONFLICT (chat_id) DO UPDATE
      SET stage = EXCLUDED.stage,
          today = EXCLUDED.today,
          timezone = EXCLUDED.timezone,
          state = EXCLUDED.state,
          version = script_runs.version + 1,
          updated_at = date_trunc('milliseconds', NOW()),
          expires_at = NOW() + INTERVAL '7 days'
  `;
}

// How long a 'sourcing-active' claim is trusted before it's presumed dead. Set
// safely above maxDuration (300s) so we never reclaim a run whose function is
// still alive — only one that was killed mid-sourcing.
const SOURCING_STALE_INTERVAL = '10 minutes';

// Atomically claim the sourcing turn by flipping the run into the in-flight
// stage. Succeeds only when the run is claimable — freshly 'sourcing', or a
// 'sourcing-active' claim old enough to be presumed dead (a crashed run). A
// live claim (fresh 'sourcing-active') loses the CAS, so a double-submitted or
// staggered first message can never run discovery twice. Only stage/version
// move; the state payload is left untouched for the caller to reload.
export async function claimSourcing(chatId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE script_runs
       SET stage = 'sourcing-active',
           version = version + 1,
           updated_at = date_trunc('milliseconds', NOW()),
           expires_at = NOW() + INTERVAL '7 days'
     WHERE chat_id = ${chatId}
       AND (
         stage = 'sourcing'
         OR (
           stage = 'sourcing-active'
           AND updated_at < NOW() - (${SOURCING_STALE_INTERVAL})::interval
         )
       )
   RETURNING chat_id
  `) as unknown as Array<{ chat_id: string }>;
  return rows.length > 0;
}

export async function loadRun(chatId: string): Promise<ScriptRun | null> {
  const rows = (await sql`
    SELECT chat_id, stage, today, timezone, state, version, updated_at
      FROM script_runs
     WHERE chat_id = ${chatId}
  `) as unknown as Array<{
    chat_id: string;
    stage: RunStage;
    today: string;
    timezone: string;
    state: RunStatePayload;
    version: number;
    updated_at: Date | string;
  }>;
  const row = rows[0];
  if (!row) return null;
  const updatedAt =
    typeof row.updated_at === 'string' ? row.updated_at : row.updated_at.toISOString();
  return {
    chatId: row.chat_id,
    stage: row.stage,
    today: row.today,
    timezone: row.timezone,
    scope: row.state.scope ?? { type: 'episode' },
    originalPrompt: row.state.originalPrompt ?? null,
    candidates: row.state.candidates ?? [],
    backups: row.state.backups ?? [],
    topics: row.state.topics ?? [],
    episode: row.state.episode ?? null,
    episodeVersions: row.state.episodeVersions ?? [],
    revisionCount: row.state.revisionCount ?? 0,
    lastDistilledVersion: row.state.lastDistilledVersion,
    errorMessage: row.state.errorMessage ?? null,
    updatedAt,
    version: row.version ?? 0,
  };
}

export async function deleteRun(chatId: string): Promise<void> {
  await sql`DELETE FROM script_runs WHERE chat_id = ${chatId}`;
}
