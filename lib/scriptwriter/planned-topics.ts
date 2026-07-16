// The start form's per-block topics: the editor names the topic (and optionally
// pastes a link) for each block up front, instead of describing the run in free
// text. Parsing lives here rather than in the route so it stays unit-testable
// and the route keeps only route-shaped exports.

import type { BlockSlot, PlannedTopic } from './types';

const SLOTS: BlockSlot[] = ['A', 'B', 'C'];
const MAX_BRIEF_CHARS = 2000;

// Normalize the form payload: keep only well-formed, non-empty entries, one per
// slot, in on-air order. Returns [] for anything unusable, which falls the run
// back to the free-text/discovery path.
export function parsePlannedTopics(raw: unknown): PlannedTopic[] {
  if (!Array.isArray(raw)) return [];
  const bySlot = new Map<BlockSlot, string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { slot, brief } = item as { slot?: unknown; brief?: unknown };
    if (typeof slot !== 'string' || typeof brief !== 'string') continue;
    const upper = slot.toUpperCase() as BlockSlot;
    if (!SLOTS.includes(upper)) continue;
    const trimmed = brief.trim().slice(0, MAX_BRIEF_CHARS);
    if (!trimmed) continue;
    // First entry wins for a duplicated slot.
    if (!bySlot.has(upper)) bySlot.set(upper, trimmed);
  }
  return SLOTS.flatMap((s) => {
    const brief = bySlot.get(s);
    return brief ? [{ slot: s, brief }] : [];
  });
}

// A readable brief for a planned-topics run: it becomes the run's originalPrompt,
// so the first chat message and the conductor's context both show what was asked.
export function briefFromPlannedTopics(topics: PlannedTopic[]): string {
  return [
    "Source these blocks — I've named the topic for each:",
    ...topics.map((t) => `${t.slot} — ${t.brief}`),
  ].join('\n');
}
