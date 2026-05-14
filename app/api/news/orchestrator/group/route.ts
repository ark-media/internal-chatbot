import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { distillTopics } from '@/lib/orchestrator/distill';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRunIfStage,
} from '@/lib/orchestrator/state';
import type { OrchestratorRun } from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

// The triage ↔ checkpoint boundary.
//   `group`   — triage → checkpoint: today's distillTopics() (group + score +
//               summarize + extract quotes), lifted out of /start. Runs on
//               demand against the survivors, so enrichment is only paid for
//               articles that made it through triage.
//   `regroup` — checkpoint → triage: drops the distill so the writer can
//               re-rank/prune the pool and group again.
const bodySchema = z.object({
  chatId: z.string().min(1),
  mode: z.enum(['group', 'regroup']).default('group'),
});

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-group:${ip}`);
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

  // regroup — checkpoint → triage. Drops the distill (and any approval
  // snapshot derived from it) so the writer is back to the raw pool.
  if (body.mode === 'regroup') {
    if (run.stage !== 'checkpoint') {
      return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
    }
    const updated: OrchestratorRun = {
      ...run,
      stage: 'triage',
      distill: null,
      approvedTopics: null,
      approvedTopicIndices: undefined,
      updatedAt: new Date().toISOString(),
    };
    const claimed = await saveRunIfStage(updated, ['checkpoint']);
    if (!claimed) {
      return Response.json(
        { error: 'wrong_stage', detail: 'Run changed before re-group. Reload and retry.' },
        { status: 409 },
      );
    }
    console.log(
      JSON.stringify({ event: 'orchestrator.group.regroup', chatId: body.chatId }),
    );
    return Response.json({ stage: 'triage', articleCount: run.articles.length });
  }

  // group — triage → checkpoint: only a run sitting in `triage` can be grouped.
  if (run.stage !== 'triage') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }
  if (run.articles.length === 0) {
    return Response.json(
      { error: 'no_articles', detail: 'Add at least one article before grouping.' },
      { status: 409 },
    );
  }

  const started = Date.now();
  try {
    const exampleScripts = await getNewsExamples();
    const distill = await distillTopics(run.articles, exampleScripts);

    // The distill pass is the slow part — the writer may have walked away.
    // Don't persist a result they'll never see.
    if (req.signal.aborted) {
      return new Response('client closed request', { status: 499 });
    }

    const updated: OrchestratorRun = {
      ...run,
      stage: 'checkpoint',
      distill,
      updatedAt: new Date().toISOString(),
    };
    // CAS on stage so a concurrent /group (or a re-group that already moved
    // the run) can't double-write — the loser gets a 409 and the UI reloads.
    const claimed = await saveRunIfStage(updated, ['triage']);
    if (!claimed) {
      return Response.json(
        { error: 'wrong_stage', detail: 'Run was already grouped or changed. Reload and retry.' },
        { status: 409 },
      );
    }

    console.log(
      JSON.stringify({
        event: 'orchestrator.group.complete',
        chatId: body.chatId,
        ms: Date.now() - started,
        articleCount: run.articles.length,
        topicCount: distill.topics.length,
      }),
    );

    return Response.json({
      stage: 'checkpoint',
      distill,
      articleCount: run.articles.length,
    });
  } catch (err) {
    // Leave the run parked in `triage` so the writer can retry Group without
    // losing their triaged list — a distill failure is recoverable.
    console.error(
      JSON.stringify({ event: 'orchestrator.group.error', chatId: body.chatId, err: String(err) }),
    );
    return Response.json(
      { error: 'group_failed', detail: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
