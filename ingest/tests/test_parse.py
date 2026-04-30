"""Tests for transcript parsing.

Run from the ingest/ dir with: python -m unittest tests.test_parse
"""

import tempfile
import unittest
from pathlib import Path

from parse import parse_transcript


def _write(tmp: Path, name: str, body: str) -> Path:
    path = tmp / name
    path.write_text(body, encoding="utf-8")
    return path


class FormatATimestampedSpeakersTests(unittest.TestCase):
    """The upstream transcripts pipeline appends [MM:SS] / [H:MM:SS] markers
    to speaker labels in dialogue-format files. The parser must strip them so
    the canonical speaker name is stable across blocks.
    """

    def test_strips_mm_ss_from_speaker_labels(self):
        body = (
            "Show: What's Your Number?\n"
            "Title: Episode 1\n"
            "Date: 2026-01-01\n"
            "Hosts: Alice, Bob\n"
            "\n"
            "Alice [00:00]\n"
            "\n"
            "Welcome.\n"
            "\n"
            "Bob [00:04]\n"
            "\n"
            "Hello.\n"
            "\n"
            "Alice [01:05]\n"
            "\n"
            "Sure.\n"
        )
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), "simplecast_abc.txt", body)
            episode = parse_transcript(path)

        speakers = [t.speaker for t in episode.turns]
        self.assertEqual(speakers, ["Alice", "Bob", "Alice"])
        self.assertEqual([t.text for t in episode.turns], ["Welcome.", "Hello.", "Sure."])

    def test_strips_h_mm_ss_from_speaker_labels(self):
        body = (
            "Show: Call me Back\n"
            "Title: Episode 379\n"
            "Date: 2026-04-30\n"
            "Hosts: Dan\n"
            "\n"
            "Dan [0:00:00]\n"
            "\n"
            "Opening.\n"
            "\n"
            "Guest Person [1:02:05]\n"
            "\n"
            "Final thoughts.\n"
        )
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), "simplecast_xyz.txt", body)
            episode = parse_transcript(path)

        self.assertEqual([t.speaker for t in episode.turns], ["Dan", "Guest Person"])

    def test_section_header_then_timestamped_speaker(self):
        body = (
            "Show: Call me Back\n"
            "Title: Test\n"
            "Date: 2026-01-01\n"
            "Hosts: Dan\n"
            "\n"
            "COLD OPEN:\n"
            "\n"
            "Dan [00:05]\n"
            "\n"
            "Cold open text.\n"
            "\n"
            "INTERVIEW:\n"
            "\n"
            "Dan [02:00]\n"
            "\n"
            "Welcome to the show.\n"
        )
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), "simplecast_sec.txt", body)
            episode = parse_transcript(path)

        self.assertEqual([t.speaker for t in episode.turns], ["Dan", "Dan"])
        self.assertEqual([t.section for t in episode.turns], ["COLD OPEN", "INTERVIEW"])

    def test_legacy_speaker_labels_without_timestamps_still_work(self):
        # Backwards compatibility: pre-timestamp transcripts in the corpus.
        body = (
            "Show: For Heaven's Sake\n"
            "Title: Old episode\n"
            "Date: 2024-01-01\n"
            "Hosts: Alice\n"
            "\n"
            "Alice\n"
            "\n"
            "Body.\n"
        )
        with tempfile.TemporaryDirectory() as d:
            path = _write(Path(d), "simplecast_legacy.txt", body)
            episode = parse_transcript(path)

        self.assertEqual([t.speaker for t in episode.turns], ["Alice"])


if __name__ == "__main__":
    unittest.main()
