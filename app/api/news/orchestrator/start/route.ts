import { z } from 'zod';

import { getNewsExamples } from '@/lib/news-prompt';
import { distillTopics } from '@/lib/orchestrator/distill';
import {
  extractUrlToArticle,
  gatherCandidates,
  gatherSources,
} from '@/lib/orchestrator/source-gathering';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import type {
  Article,
  OrchestratorRun,
  RatedArticle,
  TopicWithSources,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const baseSchema = {
  chatId: z.string().min(1),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).default('America/New_York'),
};

const bodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('discover'), ...baseSchema }),
  // Document-driven flow: just creates the run shell at stage 'extracting'.
  // The client immediately uploads the dossier file to /extract, which parses
  // it and runs the extraction agent. Kept separate so a re-extract is
  // possible and a /start retry never double-charges the model call.
  z.object({ mode: z.literal('document'), ...baseSchema }),
  z.object({
    mode: z.literal('urls'),
    urls: z.array(z.string().url()).min(1).max(20),
    ...baseSchema,
  }),
  z.object({
    mode: z.literal('topics'),
    topics: z
      .array(
        z.object({
          topic: z.string().min(1).max(500),
          description: z.string().min(1).max(2000),
        }),
      )
      .min(1)
      .max(4),
    autoGather: z.boolean().default(true),
    ...baseSchema,
  }),
]);

function newRun(
  chatId: string,
  today: string,
  timezone: string,
): OrchestratorRun {
  return {
    chatId,
    stage: 'gathering',
    today,
    timezone,
    candidates: [],
    articles: [],
    distill: null,
    approvedTopics: null,
    finalScript: null,
    scriptVersions: [],
    refineHistory: [],
    iterations: 0,
    errorMessage: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-start:${ip}`);
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

  const { chatId, today, timezone } = body;
  const started = Date.now();
  const initial = newRun(chatId, today, timezone);
  await saveRun(initial);

  try {
    if (body.mode === 'document') {
      // Just park the run at 'extracting'; the client uploads the file to
      // /extract next. No model call here.
      const run: OrchestratorRun = {
        ...initial,
        stage: 'extracting',
        updatedAt: new Date().toISOString(),
      };
      await saveRun(run);
      console.log(
        JSON.stringify({
          event: 'orchestrator.start.complete',
          mode: 'document',
          chatId,
          ms: Date.now() - started,
          stage: 'extracting',
        }),
      );
      return Response.json({ stage: 'extracting' });
    }

    if (body.mode === 'urls') {
      const articles = await Promise.all(
        body.urls.map((u) => extractUrlToArticle(u, today)),
      );
      const usable = articles.filter((a) => a.content.length > 0);
      if (usable.length === 0) {
        const errored: OrchestratorRun = {
          ...initial,
          stage: 'error',
          errorMessage:
            'Could not extract any of the supplied URLs. Check the links and try again.',
          updatedAt: new Date().toISOString(),
        };
        await saveRun(errored);
        return Response.json(
          { stage: 'error', errorMessage: errored.errorMessage },
          { status: 200 },
        );
      }
      const exampleScripts = await getNewsExamples();
      // The writer hand-picked these URLs — pass `isUserSupplied` so the
      // distill prompt trusts the selection instead of filtering for the
      // show's editorial scope. Without this it rejects writer requests
      // with rationales like "these articles fall outside the show's beat."
      const distill = await distillTopics(usable, exampleScripts, undefined, {
        isUserSupplied: true,
      });
      const run: OrchestratorRun = {
        ...initial,
        stage: 'checkpoint',
        articles,
        distill,
        updatedAt: new Date().toISOString(),
      };
      await saveRun(run);
      console.log(
        JSON.stringify({
          event: 'orchestrator.start.complete',
          mode: 'urls',
          chatId,
          ms: Date.now() - started,
          articleCount: articles.length,
          topicCount: distill.topics.length,
        }),
      );
      return Response.json({
        stage: 'checkpoint',
        distill,
        articleCount: articles.length,
      });
    }

    if (body.mode === 'topics') {
      // Optionally auto-gather sources per topic in parallel. Each call is a
      // separate Gemini search constrained by topic name/description.
      const gathered = body.autoGather
        ? await Promise.all(
            body.topics.map((t) =>
              gatherSources({
                today,
                timezone,
                extraGuidance: `Specifically find articles on this topic: "${t.topic}". ${t.description}`,
                maxArticles: 6,
              }).catch((err) => {
                console.warn(
                  JSON.stringify({
                    event: 'orchestrator.start.gather_topic_error',
                    topic: t.topic,
                    err: String(err),
                  }),
                );
                return [] as Article[];
              }),
            ),
          )
        : body.topics.map(() => [] as Article[]);

      const allArticles: Article[] = [];
      const seen = new Set<string>();
      const topics: TopicWithSources[] = body.topics.map((t, i) => {
        const fresh = gathered[i].filter((a) => {
          if (seen.has(a.url)) return false;
          seen.add(a.url);
          allArticles.push(a);
          return true;
        });
        const articles: RatedArticle[] = fresh.map((article) => ({
          article,
          relevance: 60,
          credibility: 60,
          completeness: 60,
          avgScore: 60,
          provenance: 'refetched',
        }));
        return { topic: t.topic, description: t.description, articles };
      });
      const distill = {
        topics,
        rationale: 'Topics supplied by the writer.',
      };
      const run: OrchestratorRun = {
        ...initial,
        stage: 'checkpoint',
        articles: allArticles,
        distill,
        updatedAt: new Date().toISOString(),
      };
      await saveRun(run);
      console.log(
        JSON.stringify({
          event: 'orchestrator.start.complete',
          mode: 'topics',
          chatId,
          ms: Date.now() - started,
          topicCount: topics.length,
          articleCount: allArticles.length,
        }),
      );
      return Response.json({
        stage: 'checkpoint',
        distill,
        articleCount: allArticles.length,
      });
    }

    // mode === 'discover' — gather the raw candidate pool and stop at
    // `triage`. No URL verification, no Tavily extraction here: the writer
    // ranks/prunes the candidate list, then /group verifies + extracts the
    // survivors and runs distillTopics().
    //
    // gatherCandidates throws (not returns []) when every discovery attempt
    // hits an infrastructure error — that's caught below and surfaces the real
    // error. A returned empty `top` means discovery completed but came up empty,
    // which is almost always a transient search-provider issue, not a date
    // problem. `extras` is the overflow pool the writer can browse via the
    // "See more" panel — keep it stashed on the run alongside the active list.
    const { top: candidates, extras } = await gatherCandidates({ today });

    if (candidates.length === 0) {
      const errored: OrchestratorRun = {
        ...initial,
        stage: 'error',
        errorMessage:
          'News discovery came up empty after several tries. This is usually a transient issue with the search provider — try again in a moment, or seed the run manually with article URLs.',
        updatedAt: new Date().toISOString(),
      };
      await saveRun(errored);
      return Response.json(
        { stage: 'error', errorMessage: errored.errorMessage },
        { status: 200 },
      );
    }

    const run: OrchestratorRun = {
      ...initial,
      stage: 'triage',
      candidates,
      extraCandidates: extras,
      updatedAt: new Date().toISOString(),
    };
    await saveRun(run);

    console.log(
      JSON.stringify({
        event: 'orchestrator.start.complete',
        mode: 'discover',
        chatId,
        ms: Date.now() - started,
        candidateCount: candidates.length,
        extraCount: extras.length,
        stage: 'triage',
      }),
    );

    return Response.json({
      stage: 'triage',
      candidateCount: candidates.length,
      extraCount: extras.length,
    });
  } catch (err) {
    const errored = await loadRun(chatId);
    if (errored) {
      await saveRun({
        ...errored,
        stage: 'error',
        errorMessage: String(err).slice(0, 500),
        updatedAt: new Date().toISOString(),
      });
    }
    console.error(JSON.stringify({ event: 'orchestrator.start.error', chatId, err: String(err) }));
    return Response.json(
      { stage: 'error', errorMessage: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
