import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { suggestArc } from '@/lib/orchestrator/arrange';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import {
  extractedStoriesToDistill,
  type NarrativeArc,
  type OrchestratorRun,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const blockRole = z.enum(['A', 'B', 'C', 'D']);

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

  if (body.action === 'suggest') {
    // Allow suggesting from the review checkpoint or re-suggesting at 'arranged'.
    if (run.stage !== 'extracted' && run.stage !== 'arranged') {
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
      await saveRun(next);
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

  // action === 'apply' — materialize distill.topics in arc order and advance
  // to the existing 'checkpoint' stage (which the doc flow reuses as Deepen).
  if (run.stage !== 'extracted' && run.stage !== 'arranged') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  const arc: NarrativeArc = body.arc;
  const distill = extractedStoriesToDistill(stories, arc.order);

  // Reconstruct the exact id order extractedStoriesToDistill produced (arc.order
  // first, then any omitted stories appended in original order) so topic i lines
  // up with its story even when the editor's arc.order is incomplete.
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const seenIds = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of arc.order) {
    if (storyById.has(id) && !seenIds.has(id)) {
      orderedIds.push(id);
      seenIds.add(id);
    }
  }
  for (const s of stories) {
    if (!seenIds.has(s.id)) orderedIds.push(s.id);
  }

  // Fold each story's transition + block role into the matching topic's
  // description so the script writer sees the arc without any change to
  // buildCachedSystemContent. distill.topics is in this same order.
  distill.topics = distill.topics.map((topic, i) => {
    const id = orderedIds[i];
    const story = id ? storyById.get(id) : undefined;
    if (!story) return topic;
    const role = arc.roles[story.id];
    const transition = arc.transitions[story.id];
    const extra = [
      role ? `Block: ${role}` : null,
      transition ? `Transition into next: "${transition}"` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return extra
      ? { ...topic, description: `${topic.description}\n\n${extra}` }
      : topic;
  });

  const next: OrchestratorRun = {
    ...run,
    stage: 'checkpoint',
    arc,
    distill,
    // All topics approved by default, in arc order; editor can adjust at the
    // checkpoint before generating.
    approvedTopicIndices: distill.topics.map((_, i) => i),
    updatedAt: new Date().toISOString(),
  };
  await saveRun(next);

  console.log(
    JSON.stringify({
      event: 'orchestrator.arrange.apply',
      chatId: body.chatId,
      topicCount: distill.topics.length,
    }),
  );

  return Response.json({ stage: 'checkpoint', distill });
}
