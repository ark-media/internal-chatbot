import { generateObject } from 'ai';
import { z } from 'zod';

import type { Candidate } from './types';

// Title-only clustering for the triage list. Runs right after discovery on the
// raw candidates — headlines, sources, and dates only, no article bodies — so
// it's one cheap Haiku call, not the expensive content-based distillTopics pass
// (that still runs later at /group on the survivors). The point is purely
// ergonomic: group related headlines under a broad theme so the writer can bin
// a whole cluster at once instead of reading every headline.

const OTHER = 'Other';
const MAX_THEME_LABEL = 60;

const clusterSchema = z.object({
  themes: z
    .array(
      z.object({
        theme: z
          .string()
          .describe('Short, broad theme label, e.g. "Iran nuclear program" or "US politics & Israel"'),
        candidateIndices: z
          .array(z.number().int().min(0))
          .describe('Indices into the numbered headline list that belong to this theme'),
      }),
    )
    .describe('Broad themes, most newsworthy first. Aim for 3–7; every headline goes in exactly one.'),
});

function numberedList(candidates: Candidate[]): string {
  return candidates
    .map((c, i) => {
      const date = c.publicationDate ? `, ${c.publicationDate.slice(0, 10)}` : '';
      return `${i}. [${c.source}${date}] ${c.title}`;
    })
    .join('\n');
}

// Assign each candidate a `theme` and return the list reordered so that each
// theme's candidates sit contiguously (model's theme order, "Other" last),
// preserving the incoming freshness order within each theme. Contiguity is what
// lets the triage UI render clean groups and keep drag-to-rank within a group.
export async function clusterCandidates(
  candidates: Candidate[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  // Nothing to gain from a model call on a trivial list.
  if (candidates.length <= 1) return candidates;

  const { object } = await generateObject({
    model: 'anthropic/claude-haiku-4-5',
    schema: clusterSchema,
    system:
      'You organize a news editor\'s raw discovery list. Cluster the headlines into a few broad ' +
      'themes so the editor can scan by topic and discard whole clusters at once. Use 3–7 themes; ' +
      'make them broad, not one-per-story. Assign every headline to exactly one theme by its index. ' +
      'Order themes most newsworthy first. Put anything that fits no clear theme under "Other".',
    prompt: `Headlines:\n${numberedList(candidates)}`,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    abortSignal: signal,
  });

  // Assign themes by index — first theme to claim an index wins, ignoring
  // out-of-range or duplicate indices the model may emit.
  const assigned = new Array<string | undefined>(candidates.length).fill(undefined);
  const themeOrder: string[] = [];
  for (const t of object.themes) {
    const label = t.theme.trim().slice(0, MAX_THEME_LABEL) || OTHER;
    if (!themeOrder.includes(label)) themeOrder.push(label);
    for (const idx of t.candidateIndices) {
      if (idx >= 0 && idx < candidates.length && assigned[idx] === undefined) {
        assigned[idx] = label;
      }
    }
  }

  // Rebuild contiguously: each theme in model order, then any unassigned
  // stragglers under "Other". Within a theme, original (freshness) order holds
  // because we walk `candidates` in order.
  const ordered: Candidate[] = [];
  const emit = (label: string, match: (c: Candidate, i: number) => boolean) => {
    candidates.forEach((c, i) => {
      if (match(c, i)) ordered.push({ ...c, theme: label });
    });
  };
  for (const label of themeOrder) {
    if (label === OTHER) continue; // fold any model-named "Other" into the straggler bucket below
    emit(label, (_c, i) => assigned[i] === label);
  }
  const hasStragglers = assigned.some((a) => a === undefined || a === OTHER);
  if (hasStragglers) emit(OTHER, (_c, i) => assigned[i] === undefined || assigned[i] === OTHER);

  // Safety net: if anything fell through the cracks (it shouldn't), the counts
  // won't match — fall back to the untouched list rather than silently dropping.
  if (ordered.length !== candidates.length) return candidates;
  return ordered;
}
