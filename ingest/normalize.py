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


class Normalizer:
    def __init__(self, kb: dict) -> None:
        self._corrections: list[tuple[re.Pattern, str]] = []
        for pattern, replacement in (kb.get("corrections") or {}).items():
            if pattern.startswith("_"):
                continue
            self._corrections.append((re.compile(pattern, re.IGNORECASE), replacement))

        self._people: list[tuple[re.Pattern, str]] = []
        for canonical, aliases in (kb.get("people") or {}).items():
            if canonical.startswith("_") or not isinstance(aliases, list):
                continue
            for alias in aliases:
                if not alias:
                    continue
                self._people.append(
                    (
                        re.compile(r"\b" + re.escape(alias) + r"\b", re.IGNORECASE),
                        canonical,
                    )
                )

        self._vocab: list[tuple[re.Pattern, str]] = []
        for term, replacement in (kb.get("vocabulary") or {}).items():
            if term.startswith("_"):
                continue
            self._vocab.append(
                (
                    re.compile(r"\b" + re.escape(term) + r"\b", re.IGNORECASE),
                    replacement,
                )
            )

    def apply(self, text: str) -> str:
        for pattern, repl in self._corrections:
            text = pattern.sub(repl, text)
        for pattern, repl in self._people:
            text = pattern.sub(repl, text)
        for pattern, repl in self._vocab:
            text = pattern.sub(repl, text)
        return text
