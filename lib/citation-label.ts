import type { Source } from '@/components/chat-types';

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Multi-word: first letter of each whitespace-delimited word, case preserved.
// "Call me Back" -> "CmB"; "What's Your Number?" -> "WYN".
// Single-word: first 3 chars so "Arkive" -> "Ark" instead of an uninformative "A".
export function showAbbr(show: string | null | undefined): string {
  if (!show) return '';
  const words = show.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3);
  return words.map((w) => w[0]).join('');
}

// "Nadav Eyal" -> "Eyal"; "Madonna" -> "Madonna".
export function lastName(speaker: string | null | undefined): string {
  if (!speaker) return '';
  const trimmed = speaker.trim();
  const idx = trimmed.lastIndexOf(' ');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// Parse "YYYY-MM-DD" without timezone gymnastics.
function parseIsoDate(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  return { y, m: mo, d };
}

// "2025-04-05" in 2026 -> "Apr 5 '25"; in same year -> "Apr 5".
export function shortDate(date: string | null | undefined, today = new Date()): string {
  if (!date) return '';
  const parts = parseIsoDate(date);
  if (!parts) return '';
  const month = MONTHS_SHORT[parts.m - 1];
  const sameYear = parts.y === today.getFullYear();
  return sameYear
    ? `${month} ${parts.d}`
    : `${month} ${parts.d} '${String(parts.y).slice(-2)}`;
}

// Compact, human-readable label for a citation chip.
//   chunk:   "<showAbbr> · <date>"   e.g.  "CmB · Apr 5"
//   turn:    "<lastName> · <date>"   e.g.  "Eyal · Apr 5"
//   episode: "<showAbbr> · <date>"
// Falls back to whatever side is available if the other is empty.
export function citationChipLabel(source: Source, today = new Date()): string {
  const date = shortDate(source.date, today);
  const left = source.kind === 'turn' ? lastName(source.speaker) : showAbbr(source.show);
  if (left && date) return `${left} · ${date}`;
  return left || date || (source.kind === 'turn' ? 'Speaker' : 'Source');
}
