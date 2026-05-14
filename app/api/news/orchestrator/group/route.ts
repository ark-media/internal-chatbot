import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { distillTopics } from '@/lib/orchestrator/distill';
import { extractCandidates } from '@/lib/orchestrator/source-gathering';
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
//   `group`   — triage → checkpoint: verify + Tavily-extract the triaged
//               candidates, then run distillTopics() (group + score +
//               summarize + extract quotes). Verification and extraction were
//               lifted out of /start, so they're only paid for the survivors.
//   `regroup` — checkpoint → triage: drops the distill and the extracted
//               article pool so the writer can re-rank/prune the candidates.
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

  // regroup — checkpoint → triage. Drops the distill, the extracted article
  // pool, and any approval snapshot, so the writer is back to the raw
  // candidate list. `run.candidates` is left intact — that's what they
  // re-triage.
  if (body.mode === 'regroup') {
    if (run.stage !== 'checkpoint') {
      return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
    }
    const updated: OrchestratorRun = {
      ...run,
      stage: 'triage',
      articles: [],
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
  if (run.candidates.length === 0) {
    return Response.json(
      { error: 'no_articles', detail: 'Add at least one article before grouping.' },
      { status: 409 },
    );
  }

  const started = Date.now();
  try {
    // Verify + extract the triaged candidates (the first slow step), then
    // distill the survivors into topics (the second).
    const articles = await extractCandidates(run.candidates, run.today, req.signal);
    if (articles.length === 0) {
      // Every candidate 404'd or failed extraction. Leave the run in `triage`
      // so the writer can adjust the list and retry.
      return Response.json(
        {
          error: 'extraction_failed',
          detail:
            'None of the triaged articles could be opened. Remove or replace them and try again.',
        },
        { status: 502 },
      );
    }

    const exampleScripts = await getNewsExamples();
    const distill = await distillTopics(articles, exampleScripts, req.signal);

    // Extraction + distill are the slow part — the writer may have walked
    // away. The signal is threaded into both, so a cancel mid-distill throws
    // (caught below); this guards the narrow window where the abort lands
    // after distill resolves but before the commit.
    if (req.signal.aborted) {
      return new Response('client closed request', { status: 499 });
    }

    const updated: OrchestratorRun = {
      ...run,
      stage: 'checkpoint',
      articles,
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
        candidateCount: run.candidates.length,
        articleCount: articles.length,
        topicCount: distill.topics.length,
      }),
    );

    return Response.json({
      stage: 'checkpoint',
      distill,
      articleCount: articles.length,
    });
  } catch (err) {
    // A writer-cancelled group surfaces as an abort — unwind quietly.
    if (req.signal.aborted) {
      return new Response('client closed request', { status: 499 });
    }
    // Otherwise leave the run parked in `triage` so the writer can retry Group
    // without losing their triaged list — extract/distill failures recover.
    console.error(
      JSON.stringify({ event: 'orchestrator.group.error', chatId: body.chatId, err: String(err) }),
    );
    return Response.json(
      { error: 'group_failed', detail: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
