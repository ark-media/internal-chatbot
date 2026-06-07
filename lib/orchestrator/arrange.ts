import { generateObject } from 'ai';
import { z } from 'zod';

import { newsSystemPrompt } from '../news-prompt';
import type { ExtractedStory, NarrativeArc } from './types';

// Cap on the tone-reference excerpt of prior scripts, matching distill.ts. The
// arc agent mainly needs the bible's structure/openings guidance (already in
// newsSystemPrompt); a slice of examples anchors what a good lead looks like.
const EXAMPLES_CHARS = 6000;

// The model returns stories in final broadcast order (lead first), each tagged
// with its block role and a one-line transition into the next story. We derive
// the richer NarrativeArc shape from this flat, model-friendly form.
const arcSchema = z.object({
  ordered: z
    .array(
      z.object({
        id: z.string().describe('The story id, copied exactly from the input.'),
        role: z
          .enum(['A', 'B', 'C', 'D'])
          .describe('Block role: A = lead/most significant, B = second, C = shorter/warmer close, D = optional fourth.'),
        transition: z
          .string()
          .describe('A one-line bridge from this story into the NEXT one. Empty for the final story.'),
      }),
    )
    .describe('All stories in final broadcast order, lead (A block) first.'),
  rationale: z
    .string()
    .describe('2–4 sentences on why this order tells the most coherent story per Ark\'s structure.'),
});

// A no-model fallback arc: keep stories in their extracted order, lead first.
// Used when the arc agent fails so the stories are never stranded — the editor
// reshapes it by hand in the review-and-arrange UI. The lead always gets the A
// role (so leadId and roles agree); the rest keep their dossier blockHint or
// default to D.
export function extractedOrderArc(stories: ExtractedStory[]): NarrativeArc {
  return {
    order: stories.map((s) => s.id),
    leadId: stories[0]?.id ?? '',
    roles: Object.fromEntries(
      stories.map((s, i) => [s.id, i === 0 ? 'A' : (s.blockHint ?? 'D')]),
    ),
    transitions: {},
    rationale: '',
  };
}

// Suggest a narrative arc for the extracted stories, grounded in the Ark news
// bible. Reorders freely toward the most coherent broadcast, using any existing
// A/B/C BLOCK labels (blockHint) as a starting hint. The editor always has the
// final say via drag-to-reorder in the UI.
export async function suggestArc(
  stories: ExtractedStory[],
  exampleScripts: string,
  signal?: AbortSignal,
): Promise<NarrativeArc> {
  const cachedSystem = `${newsSystemPrompt('orchestrator')}

== Tone reference (recent Ark News Daily scripts — match this register) ==

${exampleScripts.slice(0, EXAMPLES_CHARS)}`;

  const storyList = stories
    .map((s) => {
      const hint = s.blockHint ? ` [dossier labeled this ${s.blockHint} BLOCK]` : '';
      return `id: ${s.id}${hint}
headline: ${s.headline}
lead: ${s.lead ?? '(none)'}
why it matters: ${s.relevance}`;
    })
    .join('\n\n');

  const prompt = `You are sequencing the stories below into a coherent Ark News Daily episode.

${storyList}

Order them into the most coherent broadcast arc per Ark's structure:
- Pick the lead (A block) — usually the most significant development.
- Sequence the rest so each story flows naturally into the next; group related stories.
- Assign each a block role (A/B/C/D). The C block is the shorter, warmer close.
- Write a one-line transition bridging each story into the next (leave the last one's transition empty).
- You may reorder freely; treat the dossier's existing BLOCK labels as hints, not constraints.

Return every story exactly once, using the ids above verbatim.`;

  const { object } = await generateObject({
    model: 'anthropic/claude-sonnet-4-6',
    schema: arcSchema,
    system: {
      role: 'system',
      content: cachedSystem,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    prompt,
    temperature: 0.3,
    abortSignal: signal,
  });

  return assembleArc(object.ordered, stories, object.rationale);
}

type OrderedItem = { id: string; role: 'A' | 'B' | 'C' | 'D'; transition: string };

// Turn the model's flat, possibly-imperfect `ordered` array into a clean
// NarrativeArc. Pure and exported so the reconciliation — the easy-to-break
// part — is unit-tested without a model call.
//
// Steps: (1) keep only ids that exist in the input and drop dupes, so a
// hallucinated or repeated id can't corrupt the arc; (2) append any story the
// model omitted (role D) so nothing silently disappears; (3) stably sort by
// role so the broadcast sequence agrees with the role labels. The model
// occasionally lists stories out of role order — e.g. the C-block close placed
// second — even though its roles, transitions, and rationale all speak in
// A→B→C terms, and the review UI derives the block letter positionally, so a
// raw-sequence/role mismatch surfaces the C story in the B slot and parks the
// wrong transition above it. A story's transition bridges into whatever role
// follows it, so once the order matches the roles the transitions line up. The
// sort is stable, so an already-consistent model (and ties within a role) is
// left untouched and the appended D-role fallbacks stay last.
export function assembleArc(
  modelOrdered: OrderedItem[],
  stories: ExtractedStory[],
  rationale: string,
): NarrativeArc {
  const validIds = new Set(stories.map((s) => s.id));
  const seen = new Set<string>();
  const ordered = modelOrdered.filter((o) => {
    if (!validIds.has(o.id) || seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
  for (const s of stories) {
    if (!seen.has(s.id)) {
      ordered.push({ id: s.id, role: 'D', transition: '' });
      seen.add(s.id);
    }
  }

  const roleRank = { A: 0, B: 1, C: 2, D: 3 } as const;
  ordered.sort((a, b) => roleRank[a.role] - roleRank[b.role]);

  const order = ordered.map((o) => o.id);
  const roles: Record<string, 'A' | 'B' | 'C' | 'D'> = {};
  const transitions: Record<string, string> = {};
  for (const o of ordered) {
    roles[o.id] = o.role;
    transitions[o.id] = o.transition;
  }

  return {
    order,
    leadId: order[0] ?? '',
    roles,
    transitions,
    rationale,
  };
}
