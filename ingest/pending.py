"""List episodes uploaded to Google Drive but not yet embedded.

Usage (from internal-chatbot/):
    python -m pending         # run inside the ingest venv
    # or
    cd ingest && python pending.py

Reads env from ../.env.local. Requires DATABASE_URL and STATE_JSON_PATH.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")


def main() -> int:
    state = json.loads(Path(os.environ["STATE_JSON_PATH"]).read_text())
    uploaded = {
        eid: m
        for eid, m in state["processed_episodes"].items()
        if m.get("status") == "uploaded"
    }

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        embedded = {
            row[0]
            for row in conn.execute(
                "SELECT episode_id FROM episodes WHERE ingested_at IS NOT NULL"
            ).fetchall()
        }

    pending = [(eid, m) for eid, m in uploaded.items() if eid not in embedded]
    pending.sort(key=lambda x: (x[1].get("show", ""), x[1].get("processed_at", "")))

    orphans = sorted(embedded - set(uploaded.keys()))
    all_state = state["processed_episodes"]

    print(f"uploaded to Drive: {len(uploaded)}")
    print(f"embedded in DB:    {len(embedded)}")
    print(f"pending (drive, not embedded): {len(pending)}")
    print(f"orphans (embedded, not uploaded): {len(orphans)}")
    print()
    for eid, m in pending:
        show = m.get("show", "?")
        title = (m.get("title") or "").strip()[:70]
        print(f"  pending  {eid}  [{show}] {title}")
    for eid in orphans:
        m = all_state.get(eid, {})
        show = m.get("show", "?")
        title = (m.get("title") or "").strip()[:70]
        status = m.get("status", "<not in state.json>")
        print(f"  orphan   {eid}  [{show}] {title}  (state: {status})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
