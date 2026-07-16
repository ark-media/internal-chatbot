import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from 'ai';
import { sql } from './db';

export type Surface = 'archive' | 'prep' | 'news' | 'scripts';

// Single source of truth for the valid surfaces — reused by the runtime guard
// and by API error payloads so the list can't drift as surfaces are added.
export const SURFACE_VALUES: readonly Surface[] = ['archive', 'prep', 'news', 'scripts'];

const SURFACES: ReadonlySet<Surface> = new Set(SURFACE_VALUES);

export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && SURFACES.has(value as Surface);
}

export type ChatSummary = {
  id: string;
  title: string | null;
  updated_at: string;
};

export type ChatRecord = {
  id: string;
  surface: Surface;
  title: string | null;
  messages: StoredMessage[];
};

export type StoredMessage = {
  id: string;
  role: string;
  parts: UIMessagePart<UIDataTypes, UITools>[];
};

// Accept any object with a `type` field — covers UIMessagePart's discriminated
// unions (text/file/tool-*/data-*/etc.) without requiring callers to import the
// AI SDK union type.
type AnyPart = { type: string; [key: string]: unknown };

// Drop file body data on persistence: keep only filename + mediaType so saved
// chats render the attachment by name without storing the bytes. Returning a
// shape WITHOUT `url` (rather than url='') avoids any consumer accidentally
// fetching the empty-relative-URL on replay.
export function redactFileParts<P extends AnyPart>(parts: readonly P[]): P[] {
  return parts.map((part) => {
    if (part.type !== 'file') return part;
    const filename = (part as { filename?: unknown }).filename;
    const mediaType = (part as { mediaType?: unknown }).mediaType;
    return {
      type: 'file',
      ...(typeof filename === 'string' ? { filename } : {}),
      ...(typeof mediaType === 'string' ? { mediaType } : {}),
    } as unknown as P;
  });
}

// One-shot DDL bootstrap, memoized per Lambda lifetime. Without this each
// chat POST would round-trip 4 IF-NOT-EXISTS statements to Neon over HTTP.
let initPromise: Promise<void> | null = null;

export function ensureChatTables(): Promise<void> {
  return (initPromise ??= (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS chats (
          id          TEXT PRIMARY KEY,
          surface     TEXT NOT NULL CHECK (surface IN ('archive', 'prep', 'news', 'scripts')),
          title       TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
        )
      `;
      // The inline CHECK above only applies when the table is first created.
      // Existing deployments carry the pre-'scripts' constraint, so swap it in
      // place, guarded so concurrent cold starts and re-runs are no-ops.
      await sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'chats_surface_check_v2'
          ) THEN
            ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_surface_check;
            ALTER TABLE chats ADD CONSTRAINT chats_surface_check_v2
              CHECK (surface IN ('archive', 'prep', 'news', 'scripts'));
          END IF;
        -- Two cold starts can both pass the NOT EXISTS check on their MVCC
        -- snapshots; the loser's ADD then races an already-added constraint.
        -- Swallow that so the migration stays a no-op under concurrency.
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_chats_surface_updated ON chats (surface, updated_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_chats_expires_at ON chats (expires_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS chat_messages (
          chat_id     TEXT  NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          message_id  TEXT  NOT NULL,
          ordinal     INT   NOT NULL,
          role        TEXT  NOT NULL,
          parts       JSONB NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (chat_id, message_id)
        )
      `;
      // Concurrent writes for the same chat hold a per-chat advisory lock, so
      // ordinal allocation is serialized — but the UNIQUE index is the
      // belt-and-suspenders that catches any allocation bug loudly.
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_chat_ordinal_uniq ON chat_messages (chat_id, ordinal)`;
    } catch (err) {
      // Reset so a transient failure (cold start race against migration)
      // doesn't permanently disable persistence for this Lambda instance.
      initPromise = null;
      console.error('Failed to ensure chat tables:', err);
      throw err;
    }
  })());
}

// Hash the chat id into the int8 range that pg_advisory_xact_lock expects.
// hashtext() returns int4; combining with int4 of substring gives a stable
// 64-bit hash that Postgres accepts without overflow.
const ADVISORY_LOCK = (chatId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${chatId}))`;

function deriveTitle(
  messages: readonly { role: string; parts: readonly AnyPart[] }[],
): string | null {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return null;
  for (const p of firstUser.parts) {
    if (p.type === 'text' && typeof p.text === 'string') {
      const trimmed = p.text.trim();
      if (trimmed) return trimmed.slice(0, 80);
    }
  }
  return null;
}

// Persist any incoming UI messages that aren't already stored. Wraps the work
// in a transaction with a per-chat advisory lock so concurrent POSTs for the
// same chat serialize their ordinal allocation. Returns the count newly
// persisted.
export async function persistIncomingMessages(opts: {
  chatId: string;
  surface: Surface;
  messages: readonly { id: string; role: string; parts: readonly AnyPart[] }[];
  redactFiles?: boolean;
}): Promise<{ newCount: number }> {
  const { chatId, surface, messages } = opts;
  if (messages.length === 0) return { newCount: 0 };

  const title = deriveTitle(messages);
  const sanitizedAll = opts.redactFiles
    ? messages.map((m) => ({ ...m, parts: redactFileParts(m.parts) }))
    : messages;

  // Build the per-message INSERTs. ordinal is computed inside the INSERT via a
  // subquery so we never read-then-write across round-trips. ON CONFLICT on
  // the PK (chat_id, message_id) makes resends a no-op.
  const inserts = sanitizedAll.map((m) => {
    const partsJson = JSON.stringify(m.parts);
    return sql`
      INSERT INTO chat_messages (chat_id, message_id, ordinal, role, parts)
      SELECT
        ${chatId},
        ${m.id},
        COALESCE((SELECT MAX(ordinal) FROM chat_messages WHERE chat_id = ${chatId}), -1) + 1,
        ${m.role},
        ${partsJson}::jsonb
      ON CONFLICT (chat_id, message_id) DO NOTHING
      RETURNING 1
    `;
  });

  const results = await sql.transaction([
    ADVISORY_LOCK(chatId),
    sql`
      INSERT INTO chats (id, surface, title)
      VALUES (${chatId}, ${surface}, ${title})
      ON CONFLICT (id) DO NOTHING
    `,
    ...inserts,
  ]);

  // The first two entries are the lock + chats insert; the rest are the
  // chat_messages inserts. Count rows actually inserted (RETURNING populated
  // → row inserted; empty array → ON CONFLICT skipped).
  const insertedCount = results
    .slice(2)
    .reduce((n, r) => n + ((r as unknown as unknown[])?.length ?? 0), 0);
  return { newCount: insertedCount };
}

// Persist the assistant message produced by streamText.onFinish, then bump
// updated_at on the parent chat. Same per-chat advisory lock so the
// assistant write can't interleave with a concurrent user-message write.
export async function persistAssistantMessage(opts: {
  chatId: string;
  message: { id: string; role: string; parts: readonly AnyPart[] };
  redactFiles?: boolean;
}): Promise<void> {
  const { chatId, message } = opts;
  const parts = opts.redactFiles ? redactFileParts(message.parts) : message.parts;
  const partsJson = JSON.stringify(parts);

  await sql.transaction([
    ADVISORY_LOCK(chatId),
    sql`
      INSERT INTO chat_messages (chat_id, message_id, ordinal, role, parts)
      SELECT
        ${chatId},
        ${message.id},
        COALESCE((SELECT MAX(ordinal) FROM chat_messages WHERE chat_id = ${chatId}), -1) + 1,
        ${message.role},
        ${partsJson}::jsonb
      ON CONFLICT (chat_id, message_id) DO NOTHING
    `,
    sql`UPDATE chats SET updated_at = NOW() WHERE id = ${chatId}`,
  ]);
}

export async function listChats(surface: Surface, limit = 50): Promise<ChatSummary[]> {
  const rows = (await sql`
    SELECT id, title, updated_at
      FROM chats
     WHERE surface = ${surface}
       AND expires_at > NOW()
     ORDER BY updated_at DESC
     LIMIT ${limit}
  `) as unknown as Array<{ id: string; title: string | null; updated_at: string | Date }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : r.updated_at.toISOString(),
  }));
}

export async function loadChat(chatId: string): Promise<ChatRecord | null> {
  const chatRows = (await sql`
    SELECT id, surface, title FROM chats
     WHERE id = ${chatId} AND expires_at > NOW()
     LIMIT 1
  `) as unknown as Array<{ id: string; surface: Surface; title: string | null }>;
  if (chatRows.length === 0) return null;
  const chat = chatRows[0];

  const msgRows = (await sql`
    SELECT message_id, role, parts FROM chat_messages
     WHERE chat_id = ${chatId}
     ORDER BY ordinal ASC
  `) as unknown as Array<{ message_id: string; role: string; parts: unknown }>;

  const messages: StoredMessage[] = msgRows.map((r) => ({
    id: r.message_id,
    role: r.role,
    parts: (r.parts as UIMessagePart<UIDataTypes, UITools>[]) ?? [],
  }));

  return { id: chat.id, surface: chat.surface, title: chat.title, messages };
}

export async function chatExists(chatId: string): Promise<boolean> {
  const rows = (await sql`SELECT 1 FROM chats WHERE id = ${chatId} LIMIT 1`) as unknown as Array<{
    '?column?': number;
  }>;
  return rows.length > 0;
}

export async function deleteChat(chatId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM chats WHERE id = ${chatId} RETURNING 1
  `) as unknown as Array<unknown>;
  return rows.length > 0;
}

export async function purgeExpired(): Promise<number> {
  const rows = (await sql`
    DELETE FROM chats WHERE expires_at < NOW() RETURNING 1
  `) as unknown as Array<unknown>;
  return rows.length;
}

// Delete a message and all subsequent messages (used when editing). Returns the ordinal
// of the deleted message if found, or null if not found. The entire operation is
// wrapped in a transaction with an advisory lock to prevent concurrent edit races.
export async function deleteMessageAndSubsequent(
  chatId: string,
  messageId: string,
): Promise<{ deletedOrdinal: number | null; deletedCount: number }> {
  const results = await sql.transaction([
    ADVISORY_LOCK(chatId),
    // Get the ordinal of the message to delete
    sql`
      SELECT ordinal FROM chat_messages
       WHERE chat_id = ${chatId} AND message_id = ${messageId}
       LIMIT 1
    `,
  ]);

  const msgRows = results[1] as unknown as Array<{ ordinal: number }>;
  if (msgRows.length === 0) {
    return { deletedOrdinal: null, deletedCount: 0 };
  }

  const ordinal = msgRows[0].ordinal;

  // Delete the message and all messages with ordinal >= this one, then update chat
  const deleteResults = await sql.transaction([
    ADVISORY_LOCK(chatId),
    sql`
      DELETE FROM chat_messages
       WHERE chat_id = ${chatId} AND ordinal >= ${ordinal}
       RETURNING 1
    `,
    sql`UPDATE chats SET updated_at = NOW() WHERE id = ${chatId}`,
  ]);

  const deletedCount = (deleteResults[1] as unknown as Array<unknown>).length;

  return { deletedOrdinal: ordinal, deletedCount };
}

// Convenience: convert StoredMessage[] back to UIMessage[] shape that useChat accepts.
export function toUIMessages<M extends UIMessage>(stored: StoredMessage[]): M[] {
  return stored.map((m) => ({
    id: m.id,
    role: m.role,
    parts: m.parts,
  })) as unknown as M[];
}
