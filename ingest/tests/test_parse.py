"""Tests for transcript parsing.

Run from the ingest/ dir with: python -m unittest tests.test_parse
"""

import tempfile
import unittest
from pathlib import Path

from parse import parse_transcript


def _parse(body: str, name: str):
    """Parse `body` as a transcript file called `name`.

    The name is not incidental: parse_transcript derives episode_id from it
    (`simplecast_<uuid>.txt` -> `simplecast:<uuid>`), so it must keep the
    `<prefix>_<rest>.txt` shape.
    """
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / name
        path.write_text(body, encoding="utf-8")
        return parse_transcript(path)


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
        episode = _parse(body, "simplecast_abc.txt")

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
        episode = _parse(body, "simplecast_xyz.txt")

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
        episode = _parse(body, "simplecast_sec.txt")

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
        episode = _parse(body, "simplecast_legacy.txt")

        self.assertEqual([t.speaker for t in episode.turns], ["Alice"])

    def test_non_timestamp_brackets_are_not_stripped(self):
        # Lock in: only digit-shaped brackets get stripped. A name-with-tag
        # like "Alice [editor]" would survive unchanged (vanishing edge case
        # but worth pinning down).
        body = (
            "Show: Test\n"
            "Title: T\n"
            "Date: 2026-01-01\n"
            "Hosts: Alice [editor]\n"
            "\n"
            "Alice [editor]\n"
            "\n"
            "Body.\n"
        )
        episode = _parse(body, "simplecast_brackets.txt")

        self.assertEqual([t.speaker for t in episode.turns], ["Alice [editor]"])


class FormatANoDiarizationTests(unittest.TestCase):
    """When diarization fails, the upstream renderer emits standalone [ts]
    markers and no Hosts: header. The parser must skip the markers and
    attribute body text to a fallback speaker so content isn't dropped.
    """

    def test_skips_standalone_timestamp_markers(self):
        body = (
            "Show: Test\n"
            "Title: No diarization\n"
            "Date: 2026-04-30\n"
            "Hosts: Alice\n"
            "\n"
            "[00:00]\n"
            "First sentence. Mid sentence.\n"
            "\n"
            "[05:05]\n"
            "After five minutes.\n"
        )
        episode = _parse(body, "simplecast_nodiar.txt")

        # Markers stripped; both bodies attributed to the host.
        self.assertEqual([t.speaker for t in episode.turns], ["Alice", "Alice"])
        self.assertEqual(
            [t.text for t in episode.turns],
            ["First sentence. Mid sentence.", "After five minutes."],
        )

    def test_orphan_body_falls_back_to_unknown_when_no_hosts_header(self):
        # The renderer's no-diarization branch omits Hosts: entirely. Without
        # the Unknown fallback, this content would be silently dropped.
        body = (
            "Show: Test\n"
            "Title: No header hosts\n"
            "Date: 2026-04-30\n"
            "\n"
            "[00:00]\n"
            "First sentence.\n"
            "\n"
            "[05:05]\n"
            "Second sentence.\n"
        )
        episode = _parse(body, "simplecast_nohosts.txt")

        self.assertEqual(episode.hosts, [])
        self.assertEqual([t.speaker for t in episode.turns], ["Unknown", "Unknown"])
        self.assertEqual(
            [t.text for t in episode.turns],
            ["First sentence.", "Second sentence."],
        )


if __name__ == "__main__":
    unittest.main()
