"""Export edited Google Docs back to local .txt transcripts.

Usage:
    python refresh_from_drive.py <episode_id>=<drive_url> ...

Reads TRANSCRIPTS_DIR from internal-chatbot/.env.local.
Reuses the upstream transcripts repo's DriveUploader for auth + export.
Run from the upstream transcripts venv (which has googleapiclient deps).
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

CHATBOT_ROOT = Path(__file__).resolve().parents[2]
UPSTREAM_ROOT = CHATBOT_ROOT.parent / "transcripts"

load_dotenv(CHATBOT_ROOT / ".env.local")
load_dotenv(UPSTREAM_ROOT / ".env", override=False)

sys.path.insert(0, str(UPSTREAM_ROOT))

from src.uploader import DriveUploader  # noqa: E402

DRIVE_FILE_ID_RE = re.compile(r"/d/([A-Za-z0-9_-]+)")


def file_id_from_url(url: str) -> str:
    m = DRIVE_FILE_ID_RE.search(url)
    if not m:
        raise ValueError(f"Could not extract file_id from: {url}")
    return m.group(1)


def safe_id(episode_id: str) -> str:
    return episode_id.replace(":", "_")


def main(pairs: list[tuple[str, str]]) -> int:
    transcripts_dir = Path(os.environ["TRANSCRIPTS_DIR"])
    uploader = DriveUploader()

    for eid, url in pairs:
        file_id = file_id_from_url(url)
        out_path = transcripts_dir / f"{safe_id(eid)}.txt"

        print(f"[GET]  {eid}")
        print(f"       file_id={file_id}")
        text = uploader.download_transcript(file_id)
        before = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        out_path.write_text(text, encoding="utf-8")
        print(f"[WROTE] {out_path}  ({len(before)} -> {len(text)} chars)")

    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(
            "usage: refresh_from_drive.py <episode_id>=<drive_url> "
            "[<episode_id>=<drive_url> ...]"
        )
        sys.exit(1)
    pairs: list[tuple[str, str]] = []
    for arg in sys.argv[1:]:
        if "=" not in arg:
            print(f"bad arg (expected episode_id=drive_url): {arg}", file=sys.stderr)
            sys.exit(1)
        eid, url = arg.split("=", 1)
        pairs.append((eid, url))
    sys.exit(main(pairs))
