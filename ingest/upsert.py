"""Database operations for the ingest pipeline.

Handles speaker/show resolution (with auto-create for unknown entities),
episode upsert, and replace-in-place of turns + chunks for an episode.
Unknown speakers are auto-created with review_status='unreviewed' so a
human pass can later merge them into existing canonicals.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone

import psycopg

from chunker import ChunkSpec, ResolvedTurn


def _conn_str() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


def connect() -> psycopg.Connection:
    return psycopg.connect(_conn_str(), autocommit=False)


def _format_vector(vec: list[float]) -> str:
    return "[" + ",".join(f"{v:.7f}" for v in vec) + "]"


@dataclass
class SpeakerResolution:
    speaker_id: int
    canonical_name: str
    include_in_content: bool


class SpeakerCache:
    """Per-connection cache so the same raw name doesn't round-trip repeatedly."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn
        self._cache: dict[str, SpeakerResolution] = {}

    def resolve(self, raw_name: str) -> SpeakerResolution:
        key = raw_name.strip()
        if key in self._cache:
            return self._cache[key]
        res = _resolve_or_create_speaker(self._conn, key)
        self._cache[key] = res
        return res

    def clear(self) -> None:
        """Invalidate after a rollback: freshly-created ids may no longer exist."""
        self._cache.clear()


def _resolve_or_create_speaker(
    conn: psycopg.Connection, raw_name: str
) -> SpeakerResolution:
    row = conn.execute(
        """
        SELECT s.speaker_id, s.canonical_name, s.include_in_content
          FROM speakers s
          JOIN speaker_aliases a ON a.speaker_id = s.speaker_id
         WHERE a.alias_lower = %s
        """,
        (raw_name.lower(),),
    ).fetchone()
    if row is not None:
        return SpeakerResolution(row[0], row[1], row[2])

    # Unknown speaker -> create as 'unreviewed' canonical + self-alias
    row = conn.execute(
        """
        INSERT INTO speakers (canonical_name, review_status)
        VALUES (%s, 'unreviewed')
        ON CONFLICT (canonical_name) DO UPDATE
          SET canonical_name = EXCLUDED.canonical_name
        RETURNING speaker_id, canonical_name, include_in_content
        """,
        (raw_name,),
    ).fetchone()
    assert row is not None
    sid, canonical, include = row[0], row[1], row[2]
    conn.execute(
        """
        INSERT INTO speaker_aliases (alias_lower, alias_display, speaker_id)
        VALUES (%s, %s, %s)
        ON CONFLICT (alias_lower) DO NOTHING
        """,
        (raw_name.lower(), raw_name, sid),
    )
    return SpeakerResolution(sid, canonical, include)


def resolve_show(conn: psycopg.Connection, show_name: str) -> int:
    """Return show_id, creating the show with no group if unseen.

    Case-insensitive match against existing shows so that minor casing
    drift in upstream transcripts (e.g. "Call Me Back" vs "Call me Back")
    doesn't produce duplicate show rows.
    """
    row = conn.execute(
        "SELECT show_id FROM shows WHERE LOWER(name) = LOWER(%s)", (show_name,)
    ).fetchone()
    if row is not None:
        return row[0]
    row = conn.execute(
        """
        INSERT INTO shows (name) VALUES (%s)
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING show_id
        """,
        (show_name,),
    ).fetchone()
    assert row is not None
    return row[0]


def upsert_episode(
    conn: psycopg.Connection,
    episode_id: str,
    show_id: int,
    title: str,
    date: str | None,
    drive_url: str | None,
    status: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO episodes (episode_id, show_id, title, date, drive_url, status, ingested_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (episode_id) DO UPDATE SET
          show_id=EXCLUDED.show_id,
          title=EXCLUDED.title,
          date=EXCLUDED.date,
          drive_url=EXCLUDED.drive_url,
          status=EXCLUDED.status,
          ingested_at=EXCLUDED.ingested_at
        """,
        (
            episode_id,
            show_id,
            title,
            date,
            drive_url,
            status,
            datetime.now(timezone.utc),
        ),
    )


def replace_turns(
    conn: psycopg.Connection, episode_id: str, turns: list[ResolvedTurn]
) -> dict[int, int]:
    """Replace all turns for the episode. Returns turn_index -> turn_id."""
    # Chunks FK to turn_ids, so clear chunks first.
    conn.execute("DELETE FROM chunks WHERE episode_id = %s", (episode_id,))
    conn.execute("DELETE FROM turns WHERE episode_id = %s", (episode_id,))
    if not turns:
        return {}

    placeholders = ",".join(["(%s, %s, %s, %s, %s, %s)"] * len(turns))
    params: list = []
    for t in turns:
        params.extend(
            [episode_id, t.turn_index, t.speaker_id, t.section, t.text, t.token_count]
        )
    rows = conn.execute(
        f"""
        INSERT INTO turns (episode_id, turn_index, speaker_id, section, text, token_count)
        VALUES {placeholders}
        RETURNING turn_index, turn_id
        """,
        params,
    ).fetchall()
    return {turn_index: turn_id for turn_index, turn_id in rows}


def replace_chunks(
    conn: psycopg.Connection,
    episode_id: str,
    chunks: list[ChunkSpec],
    embeddings: list[list[float]],
    turn_index_to_id: dict[int, int],
) -> None:
    assert len(chunks) == len(embeddings), "chunk/embedding count mismatch"
    if not chunks:
        return

    placeholders = ",".join(
        ["(%s, %s, %s, %s, %s, %s, %s, %s::vector)"] * len(chunks)
    )
    params: list = []
    for c, emb in zip(chunks, embeddings):
        start_id = turn_index_to_id[c.start_turn_index]
        end_id = turn_index_to_id[c.end_turn_index]
        params.extend(
            [
                episode_id,
                c.chunk_index,
                start_id,
                end_id,
                c.section,
                c.text,
                c.token_count,
                _format_vector(emb),
            ]
        )
    conn.execute(
        f"""
        INSERT INTO chunks (episode_id, chunk_index, start_turn_id, end_turn_id,
                            section, text, token_count, embedding)
        VALUES {placeholders}
        """,
        params,
    )
