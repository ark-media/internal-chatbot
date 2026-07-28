"""Apply the initial schema migration and seed canonical identity data.

Seeds:
  - speakers (canonical) + speaker_aliases from knowledge_base.json's
    `people` section and from `shows[*].host` / `co_hosts`
  - show_groups (e.g. the Call me Back family)
  - shows and show_hosts

Conservative resolution: aliases come only from knowledge_base.json's
explicit mapping. Unknown raw speakers encountered during ingest will
be auto-created as `review_status='unreviewed'` canonical speakers;
a human review pass can later merge them into the right canonical id.

Run:
    python -m bootstrap --reset   # drop and recreate all tables, then seed
    python -m bootstrap           # seed only (tables must already exist)
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from db import connect

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")


DEFAULT_KB_PATH = ROOT.parent / "transcripts" / "knowledge_base.json"
MIGRATION_PATH = Path(__file__).resolve().parent / "sql" / "001_init.sql"

# Show families. Each entry: (group_name, description, member_show_names).
SHOW_GROUPS: list[tuple[str, str, list[str]]] = [
    (
        "Call me Back family",
        "Call me Back and its spinoff Inside Call me Back.",
        ["Call me Back", "Inside Call me Back"],
    ),
]

# Canonical speakers not present in knowledge_base.json (e.g. rotating hosts,
# guests we want on the review whitelist up front).
EXTRA_SPEAKERS: list[str] = [
    "Ilan Benatar",
    "Amit Segal",
    "Ronen Bergman",
    "Dr Tal Becker",
]

# Speakers whose turns should be excluded from ingest (promos, brand tags).
# These rows are still created so alias lookups succeed; ingest drops their
# turns before writing to `turns`.
NON_CONTENT_SPEAKERS: set[str] = {"Ark Media"}

# Host relationships beyond what knowledge_base.json encodes. Used for shows
# with rotating casts like Inside Call me Back. All entries here are seeded
# as non-primary hosts.
EXTRA_SHOW_HOSTS: dict[str, list[str]] = {
    "Inside Call me Back": [
        "Dan Senor",
        "Ilan Benatar",
        "Nadav Eyal",
        "Amit Segal",
        "Ronen Bergman",
        "Dr Tal Becker",
    ],
}


def _load_kb() -> dict:
    path = Path(os.environ.get("KB_JSON_PATH", DEFAULT_KB_PATH))
    if not path.exists():
        raise FileNotFoundError(f"knowledge_base.json not at {path}")
    return json.loads(path.read_text())


def apply_migration(conn: psycopg.Connection) -> None:
    sql = MIGRATION_PATH.read_text()
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
    print(f"migration applied: {MIGRATION_PATH.name}")


def insert_speaker(
    conn: psycopg.Connection, canonical_name: str, review_status: str = "canonical"
) -> int:
    row = conn.execute(
        """
        INSERT INTO speakers (canonical_name, review_status)
        VALUES (%s, %s)
        ON CONFLICT (canonical_name) DO UPDATE
          SET review_status = EXCLUDED.review_status
        RETURNING speaker_id
        """,
        (canonical_name, review_status),
    ).fetchone()
    assert row is not None
    sid = row[0]
    # self-alias so runtime lookups of the canonical name always succeed
    conn.execute(
        """
        INSERT INTO speaker_aliases (alias_lower, alias_display, speaker_id)
        VALUES (%s, %s, %s)
        ON CONFLICT (alias_lower) DO NOTHING
        """,
        (canonical_name.lower(), canonical_name, sid),
    )
    return sid


def add_alias(conn: psycopg.Connection, alias: str, speaker_id: int) -> None:
    conn.execute(
        """
        INSERT INTO speaker_aliases (alias_lower, alias_display, speaker_id)
        VALUES (%s, %s, %s)
        ON CONFLICT (alias_lower) DO NOTHING
        """,
        (alias.lower(), alias, speaker_id),
    )


def seed_speakers(conn: psycopg.Connection, kb: dict) -> dict[str, int]:
    """Seed canonical speakers. Returns canonical_name -> speaker_id."""
    name_to_sid: dict[str, int] = {}

    for canonical, aliases in kb.get("people", {}).items():
        if canonical.startswith("_"):
            continue
        sid = insert_speaker(conn, canonical, "canonical")
        name_to_sid[canonical] = sid
        if isinstance(aliases, list):
            for a in aliases:
                if a:
                    add_alias(conn, a, sid)

    def ensure(name: str | None) -> None:
        """Insert a canonical speaker unless `people` already seeded them."""
        if name and name not in name_to_sid:
            name_to_sid[name] = insert_speaker(conn, name, "canonical")

    # Hosts from shows that aren't already in `people`
    for _show_name, info in kb.get("shows", {}).items():
        ensure(info.get("host"))
        for co in info.get("co_hosts") or []:
            ensure(co)

    # Extras not in knowledge_base.json (e.g. rotating hosts)
    for name in EXTRA_SPEAKERS:
        ensure(name)

    # Flag non-content speakers so ingest skips their turns
    if NON_CONTENT_SPEAKERS:
        conn.execute(
            "UPDATE speakers SET include_in_content = FALSE "
            "WHERE canonical_name = ANY(%s)",
            (list(NON_CONTENT_SPEAKERS),),
        )

    conn.commit()
    return name_to_sid


def seed_shows(
    conn: psycopg.Connection, kb: dict, name_to_sid: dict[str, int]
) -> dict[str, int]:
    """Seed show_groups, shows, show_hosts. Returns show_name -> show_id."""
    group_name_to_id: dict[str, int] = {}
    for name, desc, _members in SHOW_GROUPS:
        row = conn.execute(
            """
            INSERT INTO show_groups (name, description) VALUES (%s, %s)
            ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
            RETURNING group_id
            """,
            (name, desc),
        ).fetchone()
        group_name_to_id[name] = row[0]

    show_to_group: dict[str, int] = {}
    for gname, _desc, members in SHOW_GROUPS:
        gid = group_name_to_id[gname]
        for show_name in members:
            show_to_group[show_name] = gid

    show_name_to_id: dict[str, int] = {}
    for show_name, info in kb.get("shows", {}).items():
        group_id = show_to_group.get(show_name)
        row = conn.execute(
            """
            INSERT INTO shows (name, group_id) VALUES (%s, %s)
            ON CONFLICT (name) DO UPDATE SET group_id = EXCLUDED.group_id
            RETURNING show_id
            """,
            (show_name, group_id),
        ).fetchone()
        show_id = row[0]
        show_name_to_id[show_name] = show_id

        host = info.get("host")
        if host and host in name_to_sid:
            conn.execute(
                """
                INSERT INTO show_hosts (show_id, speaker_id, is_primary)
                VALUES (%s, %s, TRUE)
                ON CONFLICT DO NOTHING
                """,
                (show_id, name_to_sid[host]),
            )
        for co in info.get("co_hosts") or []:
            if co in name_to_sid:
                conn.execute(
                    """
                    INSERT INTO show_hosts (show_id, speaker_id, is_primary)
                    VALUES (%s, %s, FALSE)
                    ON CONFLICT DO NOTHING
                    """,
                    (show_id, name_to_sid[co]),
                )

    # Rotating / extra hosts not encoded in knowledge_base.json
    for show_name, extra_hosts in EXTRA_SHOW_HOSTS.items():
        show_id = show_name_to_id.get(show_name)
        if show_id is None:
            continue
        for host_name in extra_hosts:
            sid = name_to_sid.get(host_name)
            if sid is None:
                continue
            conn.execute(
                """
                INSERT INTO show_hosts (show_id, speaker_id, is_primary)
                VALUES (%s, %s, FALSE)
                ON CONFLICT DO NOTHING
                """,
                (show_id, sid),
            )

    conn.commit()
    return show_name_to_id


def print_summary(conn: psycopg.Connection) -> None:
    counts = conn.execute(
        """
        SELECT
          (SELECT COUNT(*) FROM speakers),
          (SELECT COUNT(*) FROM speaker_aliases),
          (SELECT COUNT(*) FROM show_groups),
          (SELECT COUNT(*) FROM shows),
          (SELECT COUNT(*) FROM show_hosts)
        """
    ).fetchone()
    s, a, g, sh, h = counts
    print(f"seeded: {s} speakers, {a} aliases, {g} groups, {sh} shows, {h} show-hosts")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--reset",
        action="store_true",
        help="drop and recreate all tables before seeding (DESTRUCTIVE)",
    )
    args = parser.parse_args()

    kb = _load_kb()

    with connect() as conn:
        if args.reset:
            apply_migration(conn)

        name_to_sid = seed_speakers(conn, kb)
        seed_shows(conn, kb, name_to_sid)
        print_summary(conn)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
