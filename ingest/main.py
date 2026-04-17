"""CLI entry point for the Ark transcript ingestion pipeline.

Usage:
    python -m main --full
    python -m main --incremental
    python -m main --episode simplecast:<uuid>
    python -m main --full --limit 5

Reads env from ../.env.local. Requires:
    DATABASE_URL, VOYAGE_API_KEY, TRANSCRIPTS_DIR, STATE_JSON_PATH
Optional:
    KNOWLEDGE_BASE_PATH (default: <repo>/../transcripts/knowledge_base.json)

Flow per episode:
  parse .txt -> normalize turn text -> resolve speakers (auto-create
  unknowns as 'unreviewed') -> skip non-content speakers -> upsert
  episode -> replace turns -> build chunks -> embed -> replace chunks.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parse import parse_transcript  # noqa: E402
from normalize import Normalizer  # noqa: E402
from chunker import ResolvedTurn, build_chunks, count_tokens  # noqa: E402
from embed import embed_documents  # noqa: E402
from upsert import (  # noqa: E402
    SpeakerCache,
    connect,
    replace_chunks,
    replace_turns,
    resolve_show,
    upsert_episode,
)


DEFAULT_KB_PATH = ROOT.parent / "transcripts" / "knowledge_base.json"


def _transcripts_dir() -> Path:
    return Path(os.environ["TRANSCRIPTS_DIR"])


def _state() -> dict:
    with open(os.environ["STATE_JSON_PATH"]) as f:
        return json.load(f)


def _load_kb() -> dict:
    path = Path(os.environ.get("KB_JSON_PATH", DEFAULT_KB_PATH))
    return json.loads(path.read_text())


def _episode_id_to_path(episode_id: str, directory: Path) -> Path | None:
    prefix, rest = episode_id.split(":", 1)
    candidate = directory / f"{prefix}_{rest}.txt"
    return candidate if candidate.exists() else None


def _iter_targets(args, state: dict) -> list[tuple[str, dict]]:
    all_eps = state.get("processed_episodes", {})
    if args.episode:
        if args.episode not in all_eps:
            raise SystemExit(f"episode not in state.json: {args.episode}")
        return [(args.episode, all_eps[args.episode])]

    eligible = [
        (eid, meta)
        for eid, meta in all_eps.items()
        if meta.get("status") == "uploaded"
    ]
    if args.limit:
        eligible = eligible[: args.limit]
    return eligible


def _already_ingested(conn, episode_id: str, file_mtime: float) -> bool:
    row = conn.execute(
        "SELECT ingested_at FROM episodes WHERE episode_id = %s", (episode_id,)
    ).fetchone()
    if row is None or row[0] is None:
        return False
    return row[0].timestamp() >= file_mtime


def ingest_one(
    conn,
    episode_id: str,
    meta: dict,
    transcripts_dir: Path,
    normalizer: Normalizer,
    speaker_cache: SpeakerCache,
    force: bool,
) -> str:
    path = _episode_id_to_path(episode_id, transcripts_dir)
    if path is None:
        return f"skip (no file) {episode_id}"

    if not force and _already_ingested(conn, episode_id, path.stat().st_mtime):
        return f"skip (up-to-date) {episode_id}"

    episode = parse_transcript(path)

    # Backfill metadata from state.json for files without a Show: header
    # (e.g. Ark News Daily). Upstream processed_at is close enough to air date.
    if not episode.show:
        episode.show = (meta.get("show") or "").strip()
    if not episode.title:
        episode.title = (meta.get("title") or "").strip()
    if not episode.date:
        processed = meta.get("processed_at") or ""
        episode.date = processed[:10] if len(processed) >= 10 else None

    if not episode.turns:
        return f"skip (no turns) {episode_id}"
    if not episode.show:
        return f"skip (no show) {episode_id}"

    show_id = resolve_show(conn, episode.show)

    resolved: list[ResolvedTurn] = []
    skipped_non_content = 0
    for raw_turn in episode.turns:
        res = speaker_cache.resolve(raw_turn.speaker)
        if not res.include_in_content:
            skipped_non_content += 1
            continue
        normalized_text = normalizer.apply(raw_turn.text)
        if not normalized_text.strip():
            continue
        resolved.append(
            ResolvedTurn(
                turn_index=len(resolved),
                speaker_id=res.speaker_id,
                speaker_name=res.canonical_name,
                section=raw_turn.section,
                text=normalized_text,
                token_count=count_tokens(normalized_text),
            )
        )

    if not resolved:
        return f"skip (no content turns) {episode_id}"

    upsert_episode(
        conn,
        episode.episode_id,
        show_id,
        episode.title,
        episode.date,
        meta.get("drive_url"),
        meta.get("status"),
    )

    turn_map = replace_turns(conn, episode.episode_id, resolved)

    chunks = build_chunks(resolved, episode.show, episode.title, episode.date)
    if not chunks:
        return f"skip (no chunks) {episode_id}"

    embeddings = embed_documents([c.text for c in chunks])
    replace_chunks(conn, episode.episode_id, chunks, embeddings, turn_map)
    conn.commit()
    return (
        f"ok {episode_id} ({len(resolved)} turns, {len(chunks)} chunks"
        f"{f', {skipped_non_content} skipped' if skipped_non_content else ''})"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--full", action="store_true", help="re-ingest everything")
    mode.add_argument("--incremental", action="store_true", help="only new/modified")
    mode.add_argument("--episode", help="one episode id e.g. simplecast:<uuid>")
    parser.add_argument("--limit", type=int, default=0, help="max episodes to process")
    args = parser.parse_args()

    transcripts_dir = _transcripts_dir()
    state = _state()
    targets = _iter_targets(args, state)

    force = args.full or bool(args.episode)
    normalizer = Normalizer(_load_kb())

    print(f"targets: {len(targets)} (force={force})")

    with connect() as conn:
        speaker_cache = SpeakerCache(conn)
        for i, (eid, meta) in enumerate(targets, 1):
            try:
                msg = ingest_one(
                    conn,
                    eid,
                    meta,
                    transcripts_dir,
                    normalizer,
                    speaker_cache,
                    force=force,
                )
            except Exception as e:
                conn.rollback()
                speaker_cache.clear()
                msg = f"err {eid}: {e!r}"
            print(f"[{i}/{len(targets)}] {msg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
