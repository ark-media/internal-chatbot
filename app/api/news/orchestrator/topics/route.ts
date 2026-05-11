import { z } from 'zod';

import { gatherSources } from '@/lib/orchestrator/source-gathering';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRunIfUnchanged,
} from '@/lib/orchestrator/state';
import {
  deriveApprovedTopics,
  renumberIndicesAfterDelete,
  type Article,
  type DistillResult,
  type OrchestratorRun,
  type RatedArticle,
  type TopicWithSources,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    chatId: z.string().min(1),
    topic: z.string().min(1).max(500),
    description: z.string().min(1).max(2000),
    autoGather: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('update'),
    chatId: z.string().min(1),
    topicIndex: z.number().int().min(0),
    topic: z.string().min(1).max(500).optional(),
    description: z.string().min(1).max(2000).optional(),
  }),
  z.object({
    action: z.literal('delete'),
    chatId: z.string().min(1),
    topicIndex: z.number().int().min(0),
  }),
  z.object({
    action: z.literal('gather'),
    chatId: z.string().min(1),
    topicIndex: z.number().int().min(0),
  }),
]);

// /topics is reachable only from `checkpoint` or `complete` (writer revising
// after a finished run). Reject mid-flight stages and `error` — the UI
// pushes those to /start instead.
function ensureEditable(run: OrchestratorRun): void {
  if (run.stage !== 'checkpoint' && run.stage !== 'complete') {
    throw new Error(`run is not editable (stage=${run.stage})`);
  }
}

// After any mutation to `distill.topics`, refresh the materialized
// `approvedTopics` snapshot so refine/regenerate consumers see the latest
// articles. No-op when the run hasn't reached crafting yet.
function refreshApproved(
  run: OrchestratorRun,
  distill: DistillResult,
): TopicWithSources[] | null {
  if (!run.approvedTopicIndices) return run.approvedTopics;
  return deriveApprovedTopics(distill.topics, run.approvedTopicIndices);
}

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-topics:${ip}`);
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
  try {
    ensureEditable(run);
  } catch (err) {
    return Response.json(
      { error: 'wrong_stage', stage: run.stage, detail: String(err) },
      { status: 409 },
    );
  }
  // /start is the only entry point that creates `distill`. By the time the
  // UI reaches /topics there should always be one — anything else is a
  // client bug (or a request against a freshly errored run that never made
  // it to checkpoint).
  if (!run.distill) {
    return Response.json({ error: 'no_topics_yet' }, { status: 409 });
  }
  const distill: DistillResult = run.distill;
  // Optimistic-locking snapshot: every action below CAS-writes on this
  // value so two concurrent /topics calls can't both win.
  const baseUpdatedAt = run.updatedAt;

  // Tries the CAS write; on conflict surface a 409 so the UI re-fetches
  // and retries with the latest snapshot.
  const commit = async (
    updated: OrchestratorRun,
    extra: Record<string, unknown> = {},
  ): Promise<Response> => {
    const ok = await saveRunIfUnchanged(updated, baseUpdatedAt);
    if (!ok) {
      return Response.json(
        { error: 'stale_state', detail: 'Run was updated by another request. Reload and retry.' },
        { status: 409 },
      );
    }
    return Response.json({
      stage: updated.stage,
      distill: updated.distill,
      ...extra,
    });
  };

  if (body.action === 'add') {
    let articles: RatedArticle[] = [];
    let allArticles = run.articles;
    if (body.autoGather) {
      const fresh = await gatherSources({
        today: run.today,
        timezone: run.timezone,
        extraGuidance: `Specifically find articles on this topic: "${body.topic}". ${body.description}`,
        maxArticles: 6,
      });
      const seen = new Set(run.articles.map((a) => a.url));
      const deduped = fresh.filter((a) => !seen.has(a.url));
      articles = deduped.map((article) => ({
        article,
        relevance: 60,
        credibility: 60,
        completeness: 60,
        avgScore: 60,
        provenance: 'refetched' as const,
      }));
      allArticles = [...run.articles, ...deduped];
    }
    const newTopic: TopicWithSources = {
      topic: body.topic,
      description: body.description,
      articles,
    };
    const updatedDistill: DistillResult = { ...distill, topics: [...distill.topics, newTopic] };
    // New topic appended at the end — existing approved indices stay valid,
    // and the new topic isn't approved until the writer regenerates.
    const updated: OrchestratorRun = {
      ...run,
      articles: allArticles,
      distill: updatedDistill,
      approvedTopics: refreshApproved(run, updatedDistill),
      updatedAt: new Date().toISOString(),
    };
    return commit(updated, {
      addedTopicIndex: updated.distill!.topics.length - 1,
      addedSourceCount: articles.length,
    });
  }

  if (body.action === 'update') {
    if (body.topicIndex >= distill.topics.length) {
      return Response.json({ error: 'invalid_topic_index' }, { status: 400 });
    }
    const updatedTopics = distill.topics.map((t, i) =>
      i === body.topicIndex
        ? {
            ...t,
            topic: body.topic ?? t.topic,
            description: body.description ?? t.description,
          }
        : t,
    );
    const updatedDistill: DistillResult = { ...distill, topics: updatedTopics };
    const updated: OrchestratorRun = {
      ...run,
      distill: updatedDistill,
      approvedTopics: refreshApproved(run, updatedDistill),
      updatedAt: new Date().toISOString(),
    };
    return commit(updated);
  }

  if (body.action === 'delete') {
    if (body.topicIndex >= distill.topics.length) {
      return Response.json({ error: 'invalid_topic_index' }, { status: 400 });
    }
    const updatedTopics = distill.topics.filter((_, i) => i !== body.topicIndex);
    const updatedDistill: DistillResult = { ...distill, topics: updatedTopics };
    // Renumber the approved indices to match the shifted topic positions.
    const renumbered = run.approvedTopicIndices
      ? renumberIndicesAfterDelete(run.approvedTopicIndices, body.topicIndex)
      : run.approvedTopicIndices;
    const updated: OrchestratorRun = {
      ...run,
      distill: updatedDistill,
      approvedTopicIndices: renumbered,
      approvedTopics: renumbered
        ? deriveApprovedTopics(updatedDistill.topics, renumbered)
        : run.approvedTopics,
      updatedAt: new Date().toISOString(),
    };
    return commit(updated);
  }

  // action === 'gather' — fetch sources for an existing topic shell that
  // doesn't have any yet (or to add more without writer guidance).
  if (body.topicIndex >= distill.topics.length) {
    return Response.json({ error: 'invalid_topic_index' }, { status: 400 });
  }
  const target = distill.topics[body.topicIndex];
  const fresh = await gatherSources({
    today: run.today,
    timezone: run.timezone,
    extraGuidance: `Specifically find articles on this topic: "${target.topic}". ${target.description}`,
    maxArticles: 6,
  });
  const existingUrls = new Set(run.articles.map((a) => a.url));
  const deduped = fresh.filter((a: Article) => !existingUrls.has(a.url));
  const augmented: RatedArticle[] = deduped.map((article) => ({
    article,
    relevance: 60,
    credibility: 60,
    completeness: 60,
    avgScore: 60,
    provenance: 'refetched',
  }));
  const updatedTopics = distill.topics.map((t, i) =>
    i === body.topicIndex ? { ...t, articles: [...t.articles, ...augmented] } : t,
  );
  const updatedDistill: DistillResult = { ...distill, topics: updatedTopics };
  const updated: OrchestratorRun = {
    ...run,
    articles: [...run.articles, ...deduped],
    distill: updatedDistill,
    approvedTopics: refreshApproved(run, updatedDistill),
    updatedAt: new Date().toISOString(),
  };
  return commit(updated, { addedCount: deduped.length });
}
