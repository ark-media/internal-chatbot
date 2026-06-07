import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { suggestArc } from '@/lib/orchestrator/arrange';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
  saveRunIfUnchanged,
} from '@/lib/orchestrator/state';
import {
  extractedStoriesToDistill,
  orderStoriesById,
  type NarrativeArc,
  type OrchestratorRun,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const blockRole = z.enum(['A', 'B', 'C', 'D']);
// Positional block roles: 1st topic → A, 2nd → B, …, 4th-and-beyond → D.
const ROLE_LETTERS = ['A', 'B', 'C', 'D'] as const;

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suggest'), chatId: z.string().min(1) }),
  z.object({
    action: z.literal('apply'),
    chatId: z.string().min(1),
    arc: z.object({
      order: z.array(z.string().min(1)).min(1),
      leadId: z.string(),
      roles: z.record(z.string(), blockRole),
      transitions: z.record(z.string(), z.string()),
      rationale: z.string(),
    }),
  }),
]);

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-arrange:${ip}`);
  if (!ok) return new Response('Rate limit exceeded', { status: 429 });

  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return new Response('Forbidden', { status: 403 });
      }
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return Response.json({ error: 'invalid_body', detail: String(err) }, { status: 400 });
  }

  const run = await loadRun(body.chatId);
  if (!run) return Response.json({ error: 'run_not_found' }, { status: 404 });
  const stories = run.extractedStories ?? [];
  if (stories.length === 0) {
    return Response.json({ error: 'no_stories', stage: run.stage }, { status: 409 });
  }
  // Optimistic-lock snapshot for the success saves, matching /deepen. Guards
  // against a double-submit (or an overlapping deepen) clobbering the run.
  const expectedUpdatedAt = run.updatedAt;

  if (body.action === 'suggest') {
    // Re-suggest an arc from the review-and-arrange checkpoint.
    if (run.stage !== 'arranged') {
      return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
    }
    const started = Date.now();
    try {
      const exampleScripts = await getNewsExamples();
      const arc = await suggestArc(stories, exampleScripts);
      const next: OrchestratorRun = {
        ...run,
        stage: 'arranged',
        arc,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveRunIfUnchanged(next, expectedUpdatedAt);
      if (!saved) {
        return Response.json(
          { error: 'conflict', detail: 'The run changed while arranging. Try again.' },
          { status: 409 },
        );
      }
      console.log(
        JSON.stringify({
          event: 'orchestrator.arrange.suggest',
          chatId: body.chatId,
          ms: Date.now() - started,
          storyCount: stories.length,
        }),
      );
      return Response.json({ stage: 'arranged', arc });
    } catch (err) {
      await saveRun({
        ...run,
        stage: 'error',
        errorMessage: String(err).slice(0, 500),
        updatedAt: new Date().toISOString(),
      });
      console.error(
        JSON.stringify({ event: 'orchestrator.arrange.error', chatId: body.chatId, err: String(err) }),
      );
      return Response.json(
        { stage: 'error', errorMessage: String(err).slice(0, 500) },
        { status: 500 },
      );
    }
  }

  // action === 'apply' — stamp the editor's arc onto the topics and advance to
  // 'checkpoint' so /generate can run. Reachable from 'arranged' (first write)
  // and from 'complete' (the editor reopened the merged screen to revise a
  // finished doc run).
  if (run.stage !== 'arranged' && run.stage !== 'complete') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  const arc: NarrativeArc = body.arc;

  // The merged review screen has already materialized distill at extract time
  // and may have deepened/refetched/added topics since. So rather than rebuild
  // distill from stories (which would discard those edits), stamp each existing
  // topic's arc decisions (block + transition) onto its `block`/`transition`
  // fields, matched by id. distill.topics order is left untouched — the script
  // order is conveyed by the arc-ordered `approvedTopicIndices` the client
  // sends to /generate, and buildSourceBlock folds block/transition into the
  // writer's view. Block role is positional in the editor's arc order.
  let distill: typeof run.distill;
  if (run.distill) {
    const positionById = new Map(arc.order.map((id, i) => [id, i] as const));
    distill = {
      ...run.distill,
      topics: run.distill.topics.map((topic) => {
        if (!topic.id) return topic;
        const pos = positionById.get(topic.id);
        const role = arc.roles[topic.id] ?? (pos != null ? ROLE_LETTERS[Math.min(pos, 3)] : undefined);
        const transition = arc.transitions[topic.id];
        return { ...topic, block: role, transition: transition || undefined };
      }),
    };
  } else {
    // Fallback for legacy runs that never materialized a distill: build it from
    // the stories in arc order and stamp the arc decisions the same way.
    const orderedStories = orderStoriesById(stories, arc.order);
    const built = extractedStoriesToDistill(stories, arc.order);
    built.topics = built.topics.map((topic, i) => {
      const story = orderedStories[i];
      if (!story) return topic;
      return {
        ...topic,
        block: arc.roles[story.id] ?? ROLE_LETTERS[Math.min(i, 3)],
        transition: arc.transitions[story.id] || undefined,
      };
    });
    distill = built;
  }

  const next: OrchestratorRun = {
    ...run,
    stage: 'checkpoint',
    arc,
    distill,
    // All topics approved by default; the client's /generate call narrows this
    // to the non-rejected set in arc order.
    approvedTopicIndices: distill.topics.map((_, i) => i),
    updatedAt: new Date().toISOString(),
  };
  const saved = await saveRunIfUnchanged(next, expectedUpdatedAt);
  if (!saved) {
    return Response.json(
      { error: 'conflict', detail: 'The run changed while arranging. Try again.' },
      { status: 409 },
    );
  }

  console.log(
    JSON.stringify({
      event: 'orchestrator.arrange.apply',
      chatId: body.chatId,
      topicCount: distill.topics.length,
    }),
  );

  return Response.json({ stage: 'checkpoint', distill });
}
