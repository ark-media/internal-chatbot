"""Review and clean up speakers auto-created during ingest.

Ingest creates a new `unreviewed` speaker every time it sees a raw label
it hasn't seen before. Many of those are mistranscriptions (Amit Sehgal →
Amit Segal) or title variants (Tal Becker ↔ Dr Tal Becker). This CLI
helps a human merge them into canonicals.

Subcommands:
  list      Show speakers with turn counts + sample aliases.
  suggest   Propose merges by fuzzy-matching unreviewed names to canonicals.
  merge     Merge <from> speaker into <into> speaker (ids or canonical names).
  confirm   Flip review_status from 'unreviewed' to 'canonical'.
  batch     Apply merges from a file (one "from into" pair per line).
  drop      Delete a speaker that has zero turns.

Examples:
  python review.py list --unreviewed --min-turns 20
  python review.py suggest --threshold 0.75
  python review.py merge 85 14                    # ids
  python review.py merge "Amit Sehgal" "Amit Segal"
  python review.py confirm "Ronen Bergman"
  python review.py batch merges.txt
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _conn_str() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


def _connect() -> psycopg.Connection:
    return psycopg.connect(_conn_str(), autocommit=False)


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------


@dataclass
class SpeakerRow:
    speaker_id: int
    canonical_name: str
    review_status: str
    include_in_content: bool
    turn_count: int
    episode_count: int
    aliases: list[str]


def _fetch_speakers(
    conn: psycopg.Connection,
    *,
    unreviewed_only: bool = False,
    canonical_only: bool = False,
    min_turns: int = 0,
    name_like: str | None = None,
) -> list[SpeakerRow]:
    sql = """
        SELECT sp.speaker_id, sp.canonical_name, sp.review_status,
               sp.include_in_content,
               COUNT(t.turn_id)::int AS turns,
               COUNT(DISTINCT t.episode_id)::int AS episodes,
               COALESCE(
                 array_agg(DISTINCT a.alias_display)
                   FILTER (WHERE a.alias_display IS NOT NULL
                           AND LOWER(a.alias_display) <> LOWER(sp.canonical_name)),
                 ARRAY[]::text[]
               ) AS aliases
          FROM speakers sp
          LEFT JOIN speaker_aliases a ON a.speaker_id = sp.speaker_id
          LEFT JOIN turns t ON t.speaker_id = sp.speaker_id
         WHERE TRUE
    """
    params: list = []
    if unreviewed_only:
        sql += " AND sp.review_status = 'unreviewed'"
    if canonical_only:
        sql += " AND sp.review_status = 'canonical'"
    if name_like:
        sql += " AND LOWER(sp.canonical_name) LIKE %s"
        params.append(f"%{name_like.lower()}%")
    sql += """
      GROUP BY sp.speaker_id, sp.canonical_name, sp.review_status, sp.include_in_content
        HAVING COUNT(t.turn_id) >= %s
      ORDER BY COUNT(t.turn_id) DESC, sp.canonical_name
    """
    params.append(min_turns)
    rows = conn.execute(sql, params).fetchall()
    return [
        SpeakerRow(
            speaker_id=r[0],
            canonical_name=r[1],
            review_status=r[2],
            include_in_content=r[3],
            turn_count=r[4],
            episode_count=r[5],
            aliases=list(r[6] or []),
        )
        for r in rows
    ]


def _resolve_ref(conn: psycopg.Connection, ref: str) -> SpeakerRow:
    """Accept an int id or a canonical name. Return the SpeakerRow."""
    ref = ref.strip()
    if ref.isdigit():
        rows = _fetch_speakers_by_ids(conn, [int(ref)])
        if not rows:
            raise SystemExit(f"no speaker with id={ref}")
        return rows[0]
    rows = conn.execute(
        """
        SELECT sp.speaker_id, sp.canonical_name, sp.review_status,
               sp.include_in_content,
               (SELECT COUNT(*)::int FROM turns WHERE speaker_id = sp.speaker_id),
               (SELECT COUNT(DISTINCT episode_id)::int FROM turns WHERE speaker_id = sp.speaker_id)
          FROM speakers sp
         WHERE LOWER(sp.canonical_name) = LOWER(%s)
        """,
        (ref,),
    ).fetchall()
    if not rows:
        raise SystemExit(f'no speaker with canonical_name="{ref}"')
    r = rows[0]
    return SpeakerRow(
        speaker_id=r[0],
        canonical_name=r[1],
        review_status=r[2],
        include_in_content=r[3],
        turn_count=r[4],
        episode_count=r[5],
        aliases=[],
    )


def _fetch_speakers_by_ids(
    conn: psycopg.Connection, ids: list[int]
) -> list[SpeakerRow]:
    if not ids:
        return []
    rows = conn.execute(
        """
        SELECT sp.speaker_id, sp.canonical_name, sp.review_status,
               sp.include_in_content,
               (SELECT COUNT(*)::int FROM turns WHERE speaker_id = sp.speaker_id),
               (SELECT COUNT(DISTINCT episode_id)::int FROM turns WHERE speaker_id = sp.speaker_id)
          FROM speakers sp
         WHERE sp.speaker_id = ANY(%s)
        """,
        (ids,),
    ).fetchall()
    return [
        SpeakerRow(
            speaker_id=r[0],
            canonical_name=r[1],
            review_status=r[2],
            include_in_content=r[3],
            turn_count=r[4],
            episode_count=r[5],
            aliases=[],
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> int:
    with _connect() as conn:
        speakers = _fetch_speakers(
            conn,
            unreviewed_only=args.unreviewed,
            canonical_only=args.canonical,
            min_turns=args.min_turns,
            name_like=args.name,
        )
    if not speakers:
        print("(no matching speakers)")
        return 0
    for s in speakers:
        status = s.review_status
        if not s.include_in_content:
            status += "/promo"
        alias_str = f"  aliases: {', '.join(s.aliases[:5])}" if s.aliases else ""
        print(
            f"[{s.speaker_id:4d}] {s.canonical_name:<40} {status:<12} {s.turn_count:>5} turns  {s.episode_count:>3} eps"
        )
        if alias_str:
            print(alias_str)
    print(f"\n{len(speakers)} speakers.")
    return 0


def cmd_suggest(args: argparse.Namespace) -> int:
    with _connect() as conn:
        unreviewed = _fetch_speakers(conn, unreviewed_only=True, min_turns=args.min_turns)
        canonical = _fetch_speakers(conn, canonical_only=True)

    if not unreviewed:
        print("no unreviewed speakers with >=%d turns" % args.min_turns)
        return 0
    if not canonical:
        print("no canonical speakers to match against")
        return 0

    # Pre-compute name tokens for quicker prefilter on shared surname
    def tokenize(name: str) -> set[str]:
        return {t.lower() for t in name.split() if len(t) > 1}

    canonical_tokens = [(c, tokenize(c.canonical_name)) for c in canonical]

    for u in unreviewed:
        u_tokens = tokenize(u.canonical_name)
        scored: list[tuple[float, SpeakerRow]] = []
        for c, ctok in canonical_tokens:
            base = SequenceMatcher(None, u.canonical_name.lower(), c.canonical_name.lower()).ratio()
            # small boost for shared token (shared first/last name)
            boost = 0.1 if (u_tokens & ctok) else 0.0
            score = base + boost
            if score >= args.threshold:
                scored.append((score, c))
        if not scored:
            continue
        scored.sort(key=lambda x: -x[0])
        print(
            f"[{u.speaker_id}] {u.canonical_name}  ({u.turn_count} turns, {u.episode_count} eps)"
        )
        for score, c in scored[: args.top]:
            print(
                f"  -> merge into [{c.speaker_id}] {c.canonical_name:<40} sim={score:.2f}  ({c.turn_count} turns)"
            )
        print()
    return 0


def cmd_merge(args: argparse.Namespace) -> int:
    with _connect() as conn:
        src = _resolve_ref(conn, args.from_ref)
        dst = _resolve_ref(conn, args.into_ref)
        if src.speaker_id == dst.speaker_id:
            raise SystemExit("refusing self-merge")

        print(
            f"merge [{src.speaker_id}] {src.canonical_name} ({src.turn_count} turns) "
            f"-> [{dst.speaker_id}] {dst.canonical_name} ({dst.turn_count} turns)"
        )
        if not args.yes:
            resp = input("proceed? [y/N] ").strip().lower()
            if resp != "y":
                print("aborted")
                return 1

        _apply_merge(conn, src.speaker_id, dst.speaker_id)
        conn.commit()
        print("ok")
    return 0


def _apply_merge(conn: psycopg.Connection, from_id: int, into_id: int) -> None:
    # copy aliases (skip conflicts)
    conn.execute(
        """
        INSERT INTO speaker_aliases (alias_lower, alias_display, speaker_id)
          SELECT alias_lower, alias_display, %s
            FROM speaker_aliases
           WHERE speaker_id = %s
        ON CONFLICT (alias_lower) DO NOTHING
        """,
        (into_id, from_id),
    )
    # copy show_hosts links (OR is_primary if both sides had the row)
    conn.execute(
        """
        INSERT INTO show_hosts (show_id, speaker_id, is_primary)
          SELECT show_id, %s, is_primary
            FROM show_hosts
           WHERE speaker_id = %s
        ON CONFLICT (show_id, speaker_id) DO UPDATE
          SET is_primary = show_hosts.is_primary OR EXCLUDED.is_primary
        """,
        (into_id, from_id),
    )
    # move turns
    conn.execute(
        "UPDATE turns SET speaker_id = %s WHERE speaker_id = %s",
        (into_id, from_id),
    )
    # remove source (cascades remaining aliases + show_hosts entries for from_id)
    conn.execute("DELETE FROM speakers WHERE speaker_id = %s", (from_id,))


def cmd_confirm(args: argparse.Namespace) -> int:
    with _connect() as conn:
        s = _resolve_ref(conn, args.ref)
        if s.review_status == "canonical":
            print(f"[{s.speaker_id}] {s.canonical_name} is already canonical")
            return 0
        conn.execute(
            "UPDATE speakers SET review_status = 'canonical' WHERE speaker_id = %s",
            (s.speaker_id,),
        )
        conn.commit()
        print(f"confirmed [{s.speaker_id}] {s.canonical_name} as canonical")
    return 0


def cmd_batch(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not path.exists():
        raise SystemExit(f"file not found: {path}")
    with _connect() as conn:
        applied = 0
        for lineno, raw in enumerate(path.read_text().splitlines(), 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                print(f"line {lineno}: expected 'FROM INTO', got {raw!r}")
                continue
            from_ref, into_ref = parts
            try:
                src = _resolve_ref(conn, from_ref.strip('"'))
                dst = _resolve_ref(conn, into_ref.strip('"'))
            except SystemExit as e:
                print(f"line {lineno}: {e}")
                continue
            if src.speaker_id == dst.speaker_id:
                print(f"line {lineno}: skipping self-merge")
                continue
            _apply_merge(conn, src.speaker_id, dst.speaker_id)
            print(
                f"line {lineno}: merged [{src.speaker_id}] {src.canonical_name} -> [{dst.speaker_id}] {dst.canonical_name}"
            )
            applied += 1
        conn.commit()
        print(f"\napplied {applied} merge(s)")
    return 0


def cmd_drop(args: argparse.Namespace) -> int:
    with _connect() as conn:
        s = _resolve_ref(conn, args.ref)
        if s.turn_count > 0 and not args.force:
            raise SystemExit(
                f"[{s.speaker_id}] {s.canonical_name} has {s.turn_count} turns; pass --force to delete anyway (cascade will drop turns)"
            )
        conn.execute("DELETE FROM speakers WHERE speaker_id = %s", (s.speaker_id,))
        conn.commit()
        print(f"dropped [{s.speaker_id}] {s.canonical_name}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="list speakers")
    p_list.add_argument("--unreviewed", action="store_true")
    p_list.add_argument("--canonical", action="store_true")
    p_list.add_argument("--min-turns", type=int, default=0)
    p_list.add_argument("--name", help="filter by canonical name substring")
    p_list.set_defaults(func=cmd_list)

    p_sug = sub.add_parser("suggest", help="propose merges")
    p_sug.add_argument("--threshold", type=float, default=0.75)
    p_sug.add_argument("--min-turns", type=int, default=5)
    p_sug.add_argument("--top", type=int, default=3)
    p_sug.set_defaults(func=cmd_suggest)

    p_merge = sub.add_parser("merge", help="merge FROM into INTO")
    p_merge.add_argument("from_ref", help="speaker id or canonical name")
    p_merge.add_argument("into_ref", help="speaker id or canonical name")
    p_merge.add_argument("-y", "--yes", action="store_true", help="skip confirm")
    p_merge.set_defaults(func=cmd_merge)

    p_conf = sub.add_parser(
        "confirm", help="mark unreviewed speaker as canonical"
    )
    p_conf.add_argument("ref", help="speaker id or canonical name")
    p_conf.set_defaults(func=cmd_confirm)

    p_batch = sub.add_parser("batch", help="apply merges from file")
    p_batch.add_argument("file", help='text file: "FROM INTO" pairs, # comments allowed')
    p_batch.set_defaults(func=cmd_batch)

    p_drop = sub.add_parser("drop", help="delete speaker")
    p_drop.add_argument("ref")
    p_drop.add_argument("--force", action="store_true")
    p_drop.set_defaults(func=cmd_drop)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
