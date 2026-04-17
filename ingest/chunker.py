"""Group consecutive turns into chunk specs for embedding + retrieval.

A chunk is a window of consecutive turns within a single episode and
section, roughly TARGET_TOKENS long. Chunk text includes an episode+section
preamble so embeddings carry that context. Canonical speaker names are
used in the "Speaker: ..." labels (not raw transcript labels), so
embeddings and FTS see consistent identities across episodes.

Long-turn policy: if a single turn exceeds MAX_TOKENS, it gets its own
oversize chunk rather than being split. voyage-3-large has >30K token
input; individual podcast turns rarely approach that.
"""

from __future__ import annotations

from dataclasses import dataclass


TARGET_TOKENS = 600
MAX_TOKENS = 900
TOKENS_PER_WORD = 1.3


def count_tokens(text: str) -> int:
    """Whitespace heuristic — close enough for chunk sizing."""
    return int(len(text.split()) * TOKENS_PER_WORD) + 1


@dataclass
class ResolvedTurn:
    """A parsed transcript turn with its speaker resolved to a canonical id."""
    turn_index: int
    speaker_id: int
    speaker_name: str
    section: str
    text: str
    token_count: int


@dataclass
class ChunkSpec:
    chunk_index: int
    start_turn_index: int
    end_turn_index: int
    section: str
    text: str
    token_count: int


def _preamble(show: str, title: str, date: str | None, section: str) -> str:
    return (
        f"[Show: {show}] [Title: {title}] [Date: {date or 'unknown'}] "
        f"[Section: {section or 'UNLABELED'}]"
    )


def _format_turn(turn: ResolvedTurn) -> str:
    return f"{turn.speaker_name}: {turn.text}"


def build_chunks(
    turns: list[ResolvedTurn],
    show: str,
    title: str,
    date: str | None,
) -> list[ChunkSpec]:
    chunks: list[ChunkSpec] = []
    current: list[ResolvedTurn] = []
    current_section = ""
    current_tokens = 0

    def flush() -> None:
        nonlocal current, current_tokens
        if not current:
            return
        preamble = _preamble(show, title, date, current_section)
        body = "\n\n".join(_format_turn(t) for t in current)
        text = f"{preamble}\n\n{body}"
        chunks.append(
            ChunkSpec(
                chunk_index=len(chunks),
                start_turn_index=current[0].turn_index,
                end_turn_index=current[-1].turn_index,
                section=current_section,
                text=text,
                token_count=count_tokens(text),
            )
        )
        current = []
        current_tokens = 0

    for turn in turns:
        # section boundary -> flush
        if turn.section != current_section and current:
            flush()
        current_section = turn.section

        # oversize single turn -> own chunk
        if turn.token_count > MAX_TOKENS:
            if current:
                flush()
            current = [turn]
            current_tokens = turn.token_count
            flush()
            continue

        # would exceed target -> flush before appending
        if current and current_tokens + turn.token_count > TARGET_TOKENS:
            flush()

        current.append(turn)
        current_tokens += turn.token_count

    flush()
    return chunks
