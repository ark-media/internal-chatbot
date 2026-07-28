"""Apply knowledge_base.json text normalizations to turn body text.

Three passes, in order:
  1. `corrections` — case-insensitive regex substitutions (per kb._comment).
  2. `people`      — alias string -> canonical name, word-bounded,
                     case-insensitive. The upstream pipeline treats these
                     as common name mistranscriptions.
  3. `vocabulary`  — domain term -> preferred casing, word-bounded,
                     case-insensitive.

The upstream transcripts pipeline may already apply some/all of these
when producing .txt files; re-running them here is idempotent and
defensive.
"""

from __future__ import annotations

import re


def _word(literal: str) -> re.Pattern:
    """Word-bounded, case-insensitive match on a literal string."""
    return re.compile(r"\b" + re.escape(literal) + r"\b", re.IGNORECASE)


class Normalizer:
    def __init__(self, kb: dict) -> None:
        # One ordered list rather than three. `apply` walks it front to back, so
        # list order IS the pass order documented above — keep these three
        # blocks in sequence. Keys starting with "_" are kb comments, not data.
        self._subs: list[tuple[re.Pattern, str]] = []

        # 1. corrections — the pattern is already a regex, so it is not escaped.
        for pattern, replacement in (kb.get("corrections") or {}).items():
            if pattern.startswith("_"):
                continue
            self._subs.append((re.compile(pattern, re.IGNORECASE), replacement))

        # 2. people — every alias maps to its canonical name.
        for canonical, aliases in (kb.get("people") or {}).items():
            if canonical.startswith("_") or not isinstance(aliases, list):
                continue
            for alias in aliases:
                if alias:
                    self._subs.append((_word(alias), canonical))

        # 3. vocabulary — domain term to preferred casing.
        for term, replacement in (kb.get("vocabulary") or {}).items():
            if term.startswith("_"):
                continue
            self._subs.append((_word(term), replacement))

    def apply(self, text: str) -> str:
        for pattern, repl in self._subs:
            text = pattern.sub(repl, text)
        return text
