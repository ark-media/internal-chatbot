"""Parse a transcript .txt file into episode metadata + speaker turns.

Two transcript formats exist in the upstream corpus:

Format A (most shows — ~183/202 files):
    Show: <show>
    Title: <title>
    Date: YYYY-MM-DD
    Hosts: Name, Name

    COLD OPEN:

    Speaker Name

    Paragraph text...

    Speaker Name

    Paragraph text...

Format B (Ark News Daily — ~19/202 files):
    Speaker Name:
    Body line 1.
    Body line 2.


    SPEAKER_03:
    Body line 1.

No header block; episode metadata must be backfilled from state.json
by the caller. Timestamps like [05:01] may appear on their own line
and are skipped. Speaker labels always end with a colon.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


# Section marker: ALL-CAPS (optional digits/spaces/punct), colon optional.
# Some transcripts have "INTERVIEW:" and others just "INTERVIEW".
FORMAT_A_SECTION_RE = re.compile(r"^[A-Z][A-Z0-9 \-'&]{1,40}:?$")
FORMAT_B_SPEAKER_RE = re.compile(r"^([A-Z][A-Za-z0-9_ .\-]*?):$")
# Standalone timestamp marker — emitted by the no-diarization fallback in the
# upstream renderer. Skipped in both Format A and Format B as navigation noise.
# [MM:SS] for short episodes, [H:MM:SS] for episodes >=1h.
TIMESTAMP_LINE_RE = re.compile(r"^\[\d{1,2}(?::\d{2}){1,2}\]$")
FORMAT_B_TIMESTAMP_RE = TIMESTAMP_LINE_RE
# Trailing block-start marker on Format A speaker labels, e.g. "Yonatan Adiri [12:34]".
# Cross-repo contract: this regex must match the format produced by
# transcripts/src/transcriber.py:_format_timestamp. If the renderer changes
# the marker shape, update this regex too — otherwise every block becomes a
# unique canonical speaker and pollutes the speakers table.
SPEAKER_TIMESTAMP_SUFFIX_RE = re.compile(r"\s*\[\d{1,2}(?::\d{2}){1,2}\]$")
# Last-resort speaker name when a transcript lacks a Hosts: header (e.g. the
# no-diarization fallback) and orphan body text appears with no speaker label.
# Without this, that body would be silently dropped.
UNKNOWN_SPEAKER = "Unknown"
HEADER_KEYS = ("Show", "Title", "Date", "Hosts")


@dataclass
class Turn:
    section: str
    speaker: str
    text: str


@dataclass
class Episode:
    episode_id: str
    show: str
    title: str
    date: str | None
    hosts: list[str] = field(default_factory=list)
    turns: list[Turn] = field(default_factory=list)


def _episode_id_from_filename(path: Path) -> str:
    """`simplecast_<uuid>.txt` -> `simplecast:<uuid>`."""
    stem = path.stem
    if "_" not in stem:
        raise ValueError(f"unexpected filename shape: {path.name}")
    prefix, rest = stem.split("_", 1)
    return f"{prefix}:{rest}"


def _detect_format(lines: list[str]) -> str:
    """Return 'A' if the file begins with a Show: header, else 'B'."""
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        return "A" if stripped.startswith("Show:") else "B"
    return "B"


def parse_transcript(path: Path) -> Episode:
    # utf-8-sig strips any BOM transparently
    text = path.read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    episode_id = _episode_id_from_filename(path)

    if _detect_format(lines) == "A":
        return _parse_format_a(lines, episode_id)
    return _parse_format_b(lines, episode_id)


def _parse_format_a(lines: list[str], episode_id: str) -> Episode:
    header: dict[str, str] = {}
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            break
        matched = False
        for key in HEADER_KEYS:
            prefix = f"{key}:"
            if line.startswith(prefix):
                header[key] = line[len(prefix):].strip()
                matched = True
                break
        if not matched:
            break
        i += 1

    hosts_raw = header.get("Hosts", "")
    episode = Episode(
        episode_id=episode_id,
        show=header.get("Show", "").strip(),
        title=header.get("Title", "").strip(),
        date=(header.get("Date", "").strip() or None),
        hosts=[h.strip() for h in hosts_raw.split(",") if h.strip()],
    )

    current_section = "UNLABELED"
    pending_speaker: str | None = None
    pending_lines: list[str] = []
    # Some transcripts have orphan body text with no preceding speaker label
    # (e.g. the cold-open monologue sitting under an INTERVIEW section marker,
    # or the no-diarization fallback which has no speaker labels at all).
    # The first listed host is almost always the narrator; if no Hosts: header
    # exists, attribute to UNKNOWN_SPEAKER so content reaches the vector DB
    # instead of being silently dropped.
    fallback_speaker = episode.hosts[0] if episode.hosts else UNKNOWN_SPEAKER

    def flush() -> None:
        nonlocal pending_speaker, pending_lines
        if pending_speaker is not None and pending_lines:
            body = " ".join(l.strip() for l in pending_lines if l.strip())
            if body:
                episode.turns.append(
                    Turn(section=current_section, speaker=pending_speaker, text=body)
                )
        pending_speaker = None
        pending_lines = []

    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped:
            i += 1
            continue

        # Standalone timestamp marker (no-diarization fallback emits these).
        # Drop without flushing so adjacent text blocks merge into one turn.
        if TIMESTAMP_LINE_RE.match(stripped):
            i += 1
            continue

        if FORMAT_A_SECTION_RE.match(stripped):
            flush()
            current_section = stripped.rstrip(":").strip()
            i += 1
            continue

        is_speaker_line = (
            pending_speaker is None
            and len(stripped) < 80
            and not stripped.endswith((".", "?", "!", '"', "'", ":", ","))
            and (
                (i + 1 < len(lines) and not lines[i + 1].strip())
                or i + 1 >= len(lines)
            )
        )
        if is_speaker_line:
            flush()
            # Strip trailing "[12:34]" / "[1:23:45]" block-start markers so the
            # canonical speaker name is stable across blocks — otherwise every
            # block becomes a unique speaker and pollutes the speakers table.
            pending_speaker = SPEAKER_TIMESTAMP_SUFFIX_RE.sub("", stripped).strip()
            i += 1
            while i < len(lines) and not lines[i].strip():
                i += 1
            continue

        # Orphan body (no pending_speaker): attribute to the first host.
        if pending_speaker is None and fallback_speaker is not None:
            pending_speaker = fallback_speaker

        if pending_speaker is not None:
            pending_lines.append(stripped)
            i += 1
            if i < len(lines) and not lines[i].strip():
                flush()
                i += 1
            continue

        i += 1

    flush()
    return episode


def _parse_format_b(lines: list[str], episode_id: str) -> Episode:
    """Ark News Daily-style: no header, speaker-with-colon, no sections."""
    episode = Episode(episode_id=episode_id, show="", title="", date=None)

    current_section = "UNLABELED"
    pending_speaker: str | None = None
    pending_lines: list[str] = []

    def flush() -> None:
        nonlocal pending_speaker, pending_lines
        if pending_speaker is not None and pending_lines:
            body = " ".join(l.strip() for l in pending_lines if l.strip())
            if body:
                episode.turns.append(
                    Turn(section=current_section, speaker=pending_speaker, text=body)
                )
        pending_speaker = None
        pending_lines = []

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if FORMAT_B_TIMESTAMP_RE.match(stripped):
            continue

        # Speaker label: "Name:" on its own line, immediately followed by body
        m = FORMAT_B_SPEAKER_RE.match(stripped)
        if m and i + 1 < len(lines) and lines[i + 1].strip():
            flush()
            pending_speaker = m.group(1).strip()
            continue

        if pending_speaker is not None:
            pending_lines.append(stripped)

    flush()
    return episode
