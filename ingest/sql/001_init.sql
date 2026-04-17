-- Ark internal-chatbot: initial schema.
--
-- Clean-slate design. Turns are the source of truth for speaker
-- attribution; chunks are derived windows of consecutive turns used
-- only for embedding + hybrid retrieval. Speakers and shows are
-- first-class entities so that dossier/comparison queries are
-- possible without fuzzy matching at query time.
--
-- Apply via `python -m bootstrap --reset` (preferred) or
-- `psql $DATABASE_URL -f ingest/sql/001_init.sql`.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- Order matters: children before parents.
DROP TABLE IF EXISTS chunks CASCADE;
DROP TABLE IF EXISTS turns CASCADE;
DROP TABLE IF EXISTS episode_summaries CASCADE;
DROP TABLE IF EXISTS episodes CASCADE;
DROP TABLE IF EXISTS show_hosts CASCADE;
DROP TABLE IF EXISTS shows CASCADE;
DROP TABLE IF EXISTS show_groups CASCADE;
DROP TABLE IF EXISTS speaker_aliases CASCADE;
DROP TABLE IF EXISTS speakers CASCADE;

-- Speakers -------------------------------------------------------------------

CREATE TABLE speakers (
  speaker_id          SERIAL PRIMARY KEY,
  canonical_name      TEXT NOT NULL UNIQUE,
  review_status       TEXT NOT NULL DEFAULT 'unreviewed'
                      CHECK (review_status IN ('canonical', 'unreviewed', 'merged')),
  merged_into         INTEGER REFERENCES speakers(speaker_id),
  -- When FALSE, ingest skips turns attributed to this speaker (e.g. promo
  -- tags like "Ark Media"). Applies only to turn ingestion; the speaker row
  -- itself stays around so references don't break.
  include_in_content  BOOLEAN NOT NULL DEFAULT TRUE,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every raw speaker string in a transcript resolves through this table.
-- alias_lower is the lookup key; alias_display is the original casing.
CREATE TABLE speaker_aliases (
  alias_lower    TEXT PRIMARY KEY,
  alias_display  TEXT NOT NULL,
  speaker_id     INTEGER NOT NULL REFERENCES speakers(speaker_id) ON DELETE CASCADE
);
CREATE INDEX idx_speaker_aliases_speaker ON speaker_aliases(speaker_id);

-- Shows ----------------------------------------------------------------------

CREATE TABLE show_groups (
  group_id     SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT
);

CREATE TABLE shows (
  show_id      SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  group_id     INTEGER REFERENCES show_groups(group_id),
  description  TEXT
);
CREATE INDEX idx_shows_group ON shows(group_id);

CREATE TABLE show_hosts (
  show_id     INTEGER NOT NULL REFERENCES shows(show_id) ON DELETE CASCADE,
  speaker_id  INTEGER NOT NULL REFERENCES speakers(speaker_id) ON DELETE CASCADE,
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (show_id, speaker_id)
);

-- Episodes -------------------------------------------------------------------

CREATE TABLE episodes (
  episode_id   TEXT PRIMARY KEY,
  show_id      INTEGER NOT NULL REFERENCES shows(show_id),
  title        TEXT NOT NULL,
  date         DATE,
  drive_url    TEXT,
  status       TEXT,
  ingested_at  TIMESTAMPTZ
);
CREATE INDEX idx_episodes_show ON episodes(show_id);
CREATE INDEX idx_episodes_date ON episodes(date);

-- Turns: one row per speaker turn. Source of truth for speaker attribution.
-- Dossier queries hit this table directly with speaker_id filter; chunks are
-- only used for embedding-based retrieval.
CREATE TABLE turns (
  turn_id      SERIAL PRIMARY KEY,
  episode_id   TEXT NOT NULL REFERENCES episodes(episode_id) ON DELETE CASCADE,
  turn_index   INTEGER NOT NULL,
  speaker_id   INTEGER NOT NULL REFERENCES speakers(speaker_id),
  section      TEXT,
  text         TEXT NOT NULL,
  token_count  INTEGER NOT NULL,
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  UNIQUE (episode_id, turn_index)
);
CREATE INDEX idx_turns_speaker_episode ON turns(speaker_id, episode_id, turn_index);
CREATE INDEX idx_turns_episode ON turns(episode_id, turn_index);
CREATE INDEX idx_turns_tsv ON turns USING GIN (tsv);

-- Chunks: derived retrieval units. Each chunk spans [start_turn_id, end_turn_id]
-- inclusive, all within a single episode. Built by the ingest pipeline.
CREATE TABLE chunks (
  chunk_id       SERIAL PRIMARY KEY,
  episode_id     TEXT NOT NULL REFERENCES episodes(episode_id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  start_turn_id  INTEGER NOT NULL REFERENCES turns(turn_id),
  end_turn_id    INTEGER NOT NULL REFERENCES turns(turn_id),
  section        TEXT,
  text           TEXT NOT NULL,
  token_count    INTEGER NOT NULL,
  embedding      VECTOR(1024),
  tsv            TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  UNIQUE (episode_id, chunk_index)
);
CREATE INDEX idx_chunks_episode ON chunks(episode_id, chunk_index);
CREATE INDEX idx_chunks_tsv ON chunks USING GIN (tsv);
CREATE INDEX idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

COMMIT;
