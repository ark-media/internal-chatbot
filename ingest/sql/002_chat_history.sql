-- Saved chat history with 7-day retention.
--
-- Every chat surface (archive | prep | news) persists messages here so the
-- sidebar can list recent chats and click-through to replay one. Rows expire
-- after 7 days; expired rows are filtered on read and reaped by a daily cron.
--
-- Concurrent writes for the same chat are serialized via a per-chat
-- pg_advisory_xact_lock keyed on hashtext(chat_id), so ordinal allocation
-- (computed inside the INSERT via subquery) cannot race. The UNIQUE index on
-- (chat_id, ordinal) is the belt-and-suspenders that catches any allocation
-- bug loudly rather than silently producing duplicate ordinals.
--
-- Apply via `psql $DATABASE_URL -f ingest/sql/002_chat_history.sql`.

BEGIN;

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  surface     TEXT NOT NULL CHECK (surface IN ('archive', 'prep', 'news')),
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_chats_surface_updated
  ON chats (surface, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chats_expires_at
  ON chats (expires_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  chat_id     TEXT  NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id  TEXT  NOT NULL,
  ordinal     INT   NOT NULL,
  role        TEXT  NOT NULL,
  parts       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_chat_ordinal_uniq
  ON chat_messages (chat_id, ordinal);

COMMIT;
