import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { z } from 'zod';

import { sql } from '@/lib/db';
import { DEFAULT_MODEL_ID, supportsTemperature } from '@/lib/models';
import { lookupCorpus } from '@/lib/retrieval';
import { webSearch } from '@/lib/web-search';
import { newsSystemPrompt, newsContextForDate, getNewsExamples } from '@/lib/news-prompt';
import { extractSources, parseScriptCoverage } from '@/lib/news-script';
import { runBreakingScan } from '@/lib/orchestrator/breaking-scan';
import { buildReviewerSystemContent, reflectLoop } from '@/lib/orchestrator/reflect';
import { computeMetadata } from '@/lib/orchestrator/script-craft';
import { ensureTable, getCached, setCached, cacheKey } from '@/lib/tool-cache';
import { ensureEnglish } from '@/lib/translate';
import { normalizeMessages, validateUploads } from '@/lib/upload-parts';
import { resolveTemperature } from '@/lib/temperature';
import { stripStaleToolOutputs } from '@/lib/strip-tool-outputs';
import {
  ensureChatTables,
  persistAssistantMessage,
} from '@/lib/chats';
import type { NewsUIMessage, ScanProgressSnapshot } from '@/components/news-types';
import { errText, logEvent, warnEvent } from '@/lib/log-event';
import { prepareChatRoute, persistTurn } from '@/lib/chat-route';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Id of the reconciled `data-draft` part. Stable across every write in a turn
// so the client updates one part in place instead of appending a new one per
// token.
const DRAFT_PART_ID = 'news-draft';

// Wall-clock point, measured from the start of the request, past which the
// reflect pass may no longer run or continue. Sits below `maxDuration` (300s)
// with enough headroom to write the final text and persist the message —
// production was timing out at the ceiling and returning nothing, and an
// unreviewed script beats no script.
const REFLECT_DEADLINE_MS = 240_000;

// -- Tavily Extract wrapper --------------------------------------------------

type TavilyExtractResponse =
  | {
      ok: true;
      url: string;
      title: string;
      text: string;
      date: string | null;
      source: string;
    }
  | { ok: false; reason: string; note: string };

async function fetchArticle(articleUrl: string): Promise<TavilyExtractResponse> {
  const key = cacheKey('article', { url: articleUrl });
  const cached = await getCached<TavilyExtractResponse>(key, 72);
  if (cached) return cached;

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: 'not_configured',
      note: 'Article extraction not configured (TAVILY_API_KEY missing).',
    };
  }

  try {
    const resp = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        urls: [articleUrl],
        extract_depth: 'advanced',
      }),
    });

    if (!resp.ok) {
      return {
        ok: false,
        reason: 'error',
        note: `Tavily ${resp.status}: ${await resp.text().catch(() => '')}`.slice(0, 300),
      };
    }

    const data = (await resp.json()) as {
      results?: Array<{
        url?: string;
        title?: string;
        raw_content?: string;
        publish_date?: string | null;
        source_name?: string;
      }>;
    };

    const result = data.results?.[0];
    if (!result) {
      return {
        ok: false,
        reason: 'empty',
        note: 'Tavily returned no content for this URL.',
      };
    }

    const text = result.raw_content ?? '';
    const translatedText = await ensureEnglish(text);

    const response: TavilyExtractResponse = {
      ok: true,
      url: result.url ?? articleUrl,
      title: result.title ?? 'Untitled',
      text: translatedText,
      date: result.publish_date ?? null,
      source: result.source_name ?? 'Unknown',
    };
    await setCached(key, response);
    return response;
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      // Not `errText`: model-facing tool text, not a log line.
      note: String(err).slice(0, 300),
    };
  }
}

// -- Tools -------------------------------------------------------------------

const fetchArticleTool = tool({
  description:
    'Fetch and extract the full text of an article from a URL. Supports all web content including paywalled articles and X/Twitter. Returns title, text, publication date, and source name.',
  inputSchema: z.object({
    url: z.string().url().describe('The full URL of the article to fetch.'),
  }),
  execute: async (input) => {
    const result = await fetchArticle(input.url);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        note: result.note,
      };
    }
    return {
      url: result.url,
      title: result.title,
      text: result.text,
      date: result.date,
      source: result.source,
    };
  },
});

function createSearchCorpusTool(arkNewsDailyShowId: number | null) {
  return tool({
    description:
      "Search Ark News Daily's own transcript archive for prior scripts and style examples. Returns up to 4 matching script excerpts with show/title/date.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Search query for Ark News Daily archive. Use for retrieving prior scripts to anchor voice and structure.',
        ),
    }),
    execute: async (input) => {
      const key = cacheKey('corpus', { query: input.query, showId: arkNewsDailyShowId });
      const cached = await getCached(key, 24);
      if (cached) return cached;

      const chunks = await lookupCorpus({
        query: input.query,
        filters: arkNewsDailyShowId ? { showIds: [arkNewsDailyShowId] } : undefined,
        finalK: 4,
      });

      const response =
        chunks.length === 0
          ? {
              chunks: [],
              note: 'No matching scripts found in Ark News Daily archive.',
            }
          : {
              chunks: chunks.map((c) => ({
                id: c.chunkId,
                episode_id: c.episodeId,
                show: c.showName,
                title: c.title,
                date: c.date,
                section: c.section,
                drive_url: c.driveUrl,
                excerpt: c.text,
              })),
            };

      await setCached(key, response);
      return response;
    },
  });
}

const webSearchTool = tool({
  description:
    'Web search (Tavily) for recent news, context, and breaking developments. Use for contemporary events and sourcing. Returns up to 6 results with title, URL, snippet, and publish date.',
  inputSchema: z.object({
    query: z.string().describe('Search query with specific keywords from the story.'),
    daysBack: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Limit results to the last N days. Omit for all results.'),
  }),
  execute: async (input) => {
    const key = cacheKey('websearch', { query: input.query, daysBack: input.daysBack });
    const cached = await getCached(key, 6);
    if (cached) return cached;

    const res = await webSearch(input.query, {
      maxResults: 6,
      daysBack: input.daysBack,
    });

    let response;
    if (!res.ok) {
      response = { results: [], note: res.note };
    } else {
      const translatedResults = await Promise.all(
        res.results.map(async (r) => ({
          title: await ensureEnglish(r.title),
          url: r.url,
          snippet: await ensureEnglish(r.snippet),
          published: r.publishedDate ?? null,
        }))
      );
      response = { results: translatedResults };
    }

    await setCached(key, response);
    return response;
  },
});

// -- Route handler -----------------------------------------------------------

export async function POST(req: Request) {
  const prep = await prepareChatRoute(req, {
    rateLimitKey: 'news',
    ensureTables: async () => {
      await ensureTable();
      await ensureChatTables();
    },
  });
  if (!prep.ok) return prep.response;
  const { messages, chatId, editingMessageId } = prep.prepared;

  const model = req.headers.get('x-model') || DEFAULT_MODEL_ID;
  const temperature = resolveTemperature(req.headers.get('x-temperature'));
  const uploadError = validateUploads(messages);
  if (uploadError) {
    return new Response(uploadError, {
      status: 413,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  await persistTurn({
    chatId,
    editingMessageId,
    surface: 'news',
    messages,
    redactFiles: true,
    logKey: 'news',
  });

  const normalized = normalizeMessages(messages);
  const today = new Date().toISOString().slice(0, 10);
  const started = Date.now();

  // Load prompts: only base rules in cached system, date context & examples in messages
  const baseSystemPrompt = newsSystemPrompt();
  const dateContext = newsContextForDate(today);
  const examples = await getNewsExamples();

  // Resolve Ark News Daily show ID once per request
  let arkNewsDailyShowId: number | null = null;
  try {
    const showResult = await sql`SELECT id FROM shows WHERE LOWER(name) LIKE ${'%ark news%'} LIMIT 1`;
    if (showResult && showResult.length > 0) {
      arkNewsDailyShowId = showResult[0].id as number;
    }
  } catch {
    // Fall through, tools will proceed without filtering
  }

  // Build messages with date context and examples before user's actual messages
  const contextMessages: UIMessage[] = [
    {
      id: 'news-context',
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `${dateContext}\n\n== Reference Examples ==\n\n${examples}`,
        },
      ],
    },
    {
      id: 'news-acknowledge',
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text: 'I understand the date context and writing style. Ready to create the news script.',
        },
      ],
    },
  ];

  // Prepare history for the model: drop UI-only data-sources parts, then
  // replace stale tool outputs in older assistant messages with stubs. The
  // most-recent assistant is left intact so the next turn can still
  // reference the evidence it just synthesized from; the tool can be
  // re-called if the model needs the raw article body again.
  const messagesForModel = stripStaleToolOutputs(
    normalized.map((m) => ({
      ...m,
      // Drop UI-only data parts (sources + breaking-suggestions) from the
      // history handed to the model.
      parts:
        m.parts?.filter(
          (p) =>
            p.type !== 'data-sources' &&
            p.type !== 'data-breaking-suggestions' &&
            p.type !== 'data-breaking-progress',
        ) ?? [],
    })),
  );

  const allMessages = [...contextMessages, ...messagesForModel];
  const modelMessages = await convertToModelMessages(allMessages);

  // Cache breakpoints. Anthropic caches the prompt prefix up to and INCLUDING
  // each marked message, so what matters is where the marks sit:
  //
  //   1. the system prompt (marked at the streamText call below) — stable
  //      across every request;
  //   2. the context acknowledgement — everything before it is the date context
  //      plus the full reference example scripts, a large static block that is
  //      identical on every request from every editor;
  //   3. the last history message — freezes the conversation so far so the
  //      multi-step tool loop (up to 8 steps) reads it from cache instead of
  //      re-sending fetched article bodies and corpus excerpts on every step.
  //
  // Only (1) existed before, which is why production logged ~13.5k cached
  // tokens against a 140-200k prompt: the examples block and the whole
  // conversation were re-tokenized on every call.
  const cachePoint = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
  // The ack is the last of the two context messages. Guard on the role rather
  // than trusting the index: if convertToModelMessages ever stops mapping these
  // 1:1, we skip the breakpoint instead of marking an arbitrary message.
  const contextAck = modelMessages[contextMessages.length - 1];
  if (contextAck?.role === 'assistant') contextAck.providerOptions = cachePoint;
  const lastHistoryMessage = modelMessages.at(-1);
  if (lastHistoryMessage && lastHistoryMessage !== contextAck) {
    lastHistoryMessage.providerOptions = cachePoint;
  }
  const nowIso = new Date().toISOString();

  const stream = createUIMessageStream<NewsUIMessage>({
    originalMessages: messages as NewsUIMessage[],
    execute: async ({ writer }) => {
      // scanBreakingNews runs the deterministic breaking-scan pipeline (T-001…
      // T-009) and streams its tiered suggestions to the client as a typed
      // `data-breaking-suggestions` part, mirroring the data-sources pattern.
      // It performs NO script edits — Phase 1 is suggestions-only.
      const scanBreakingNewsTool = tool({
        description:
          "Scan the approved news outlets for breaking news that broke AFTER a finalized script was locked, and return ranked Swap / Update / Can't-ignore / Human-interest suggestions. Call this (and only this) when a finalized script is present and the writer asks to check for breaking news or more relevant stories. Do NOT edit or draft the script on this turn — present the suggestions and wait.",
        inputSchema: z.object({
          script: z.string().describe('The full finalized script text to scan against.'),
          lockedAt: z
            .string()
            .optional()
            .describe('ISO timestamp the script was locked; defaults to the request time.'),
        }),
        execute: async ({ script, lockedAt }) => {
          // Accumulate stage events into one snapshot and stream it as a single
          // id-reconciled part (same id → the client updates it in place), so
          // the writer sees a live checklist instead of dead air while discovery
          // + the three gates run. It's not transient — it lives in message.parts
          // for the live view — but the persistence block below copies parts
          // explicitly and skips it, so it vanishes on reload, leaving just the
          // suggestion cards.
          const progress: ScanProgressSnapshot = {};
          const scan = await runBreakingScan({
            script,
            lockedAt,
            today,
            now: nowIso,
            signal: req.signal,
            onProgress: (ev) => {
              switch (ev.stage) {
                case 'discovering': progress.started = true; break;
                case 'discovered': progress.discovered = ev.count; break;
                case 'exclusion': progress.afterExclusion = ev.count; break;
                case 'novelty': progress.afterNovelty = ev.count; break;
                case 'grading': progress.grading = true; break;
                case 'done': progress.suggestions = ev.count; break;
              }
              writer.write({
                type: 'data-breaking-progress',
                id: 'scan-progress',
                data: { ...progress },
              });
            },
          });
          writer.write({ type: 'data-breaking-suggestions', data: scan });
          return scan;
        },
      });

      const result = streamText({
        model,
        system: {
          role: 'system',
          content: baseSystemPrompt,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        messages: modelMessages,
        tools: {
          fetchArticle: fetchArticleTool,
          searchCorpus: createSearchCorpusTool(arkNewsDailyShowId),
          webSearch: webSearchTool,
          scanBreakingNews: scanBreakingNewsTool,
        },
        stopWhen: stepCountIs(8),
        // Omitted entirely for models that reject the parameter (Sonnet 5) —
        // passing it only produced a gateway warning per call and was dropped.
        temperature: supportsTemperature(model) ? temperature : undefined,
        // Propagate client disconnect / Stop into the provider call so the
        // model stops generating instead of burning tokens to completion.
        abortSignal: req.signal,
        onFinish: ({ usage, finishReason, steps }) => {
          const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
          logEvent('news.finish', {
            ms: Date.now() - started,
            finishReason,
            toolCalls: toolCalls.map((t) => t.toolName),
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            cachedInputTokens: usage?.cachedInputTokens,
          });
        },
      });

      // Stream the model's text live, but as a provisional `data-draft` part
      // rather than a real text part. Withholding it entirely (the previous
      // design) meant a script turn showed nothing at all for 2-3 minutes, and
      // a 300s timeout killed the function with the whole draft still buffered
      // — the editors' "it crashes and gives no response". Now the words appear
      // within seconds and survive on screen even if the turn later dies, while
      // the draft stays visibly unapproved until reflect either ships or
      // rewrites it. The authoritative text part is written once, at the end.
      let draftSoFar = '';
      writer.merge(
        result
          .toUIMessageStream<NewsUIMessage>({
            sendSources: false,
            sendReasoning: false,
          })
          .pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                if (chunk.type === 'text-start' || chunk.type === 'text-end') return;
                if (chunk.type === 'text-delta') {
                  draftSoFar += chunk.delta;
                  writer.write({
                    type: 'data-draft',
                    id: DRAFT_PART_ID,
                    data: { text: draftSoFar, status: 'streaming' },
                  });
                  return;
                }
                controller.enqueue(chunk);
              },
            }),
          ),
      );

      let draftText: string;
      try {
        draftText = await result.text;
      } catch {
        // Aborted or a provider error — the merged stream already surfaced the
        // failure. Nothing to reflect on or emit.
        return;
      }

      // The reflect loop is a script-editor pass, so it only runs when the turn
      // actually produced a broadcast script (block-structured output). Q&A,
      // breaking-news scans, translations, and article fetches are emitted as
      // written. Detection is post-hoc on the finished draft.
      const isScript = parseScriptCoverage(draftText).blocks.length >= 1;

      // Never let the editor pass push the request past the function ceiling.
      // Reflect is a quality improvement on a draft we ALREADY have — shipping
      // the unreviewed draft is strictly better than a 300s timeout that
      // returns nothing at all. If the writer alone has already eaten the
      // budget, skip reflect; otherwise cap it at whatever time is left.
      const elapsed = Date.now() - started;
      const reflectBudgetMs = REFLECT_DEADLINE_MS - elapsed;
      const skipReflect = isScript && reflectBudgetMs <= 0;
      if (skipReflect) {
        warnEvent('news.reflect_skipped_over_budget', { elapsed });
      }

      let finalText = draftText;

      if (isScript && !skipReflect) {
        // Park the draft on screen as visibly-unapproved while the editor pass
        // runs, so the reader knows the text they are looking at may still move.
        writer.write({
          type: 'data-draft',
          id: DRAFT_PART_ID,
          data: { text: draftText, status: 'reviewing' },
        });

        try {
          // In the orchestrator the reviewer checks citations against
          // pre-approved sources; here the only sources available are the ones
          // the draft itself cites, so the check is limited to orphaned/
          // misnumbered superscripts rather than fabricated sourcing.
          const { sources } = extractSources(draftText);
          const sourceList = sources
            .map(
              (s) =>
                `- ${s.title} (${s.date ?? 'unknown'})${s.flags ? ` [FLAG: ${s.flags}]` : ''}: ${s.url ?? '(no url)'}`,
            )
            .join('\n');

          // Reuse the writer's own system (base rules + examples + date
          // context) so the re-craft stays in voice. No source block: the
          // corrections are targeted edits to the existing draft, which already
          // carries the facts — reflect never re-researches.
          const cachedSystemContent = `${baseSystemPrompt}\n\n== Reference Examples ==\n\n${examples}\n\n== Date Context ==\n\n${dateContext}`;
          const cachedReviewerSystemContent = await buildReviewerSystemContent({
            exampleScripts: examples,
          });

          // Race the loop against the remaining budget. On expiry we keep the
          // draft we already have rather than letting the function be killed
          // mid-reflect with nothing to show.
          const outcome = await Promise.race([
            reflectLoop({
              initialScript: { fullText: draftText, metadata: computeMetadata(draftText) },
              sourceList,
              // This list came off the draft's own SOURCES section (above), not
              // from an approved topic set — tell the reviewer so it doesn't
              // hard-fail every figure it can't independently check.
              sourcesAreSelfReported: true,
              cachedSystemContent,
              cachedReviewerSystemContent,
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), reflectBudgetMs)),
          ]);

          if (outcome === null) {
            warnEvent('news.reflect_deadline', {
              ms: Date.now() - started,
              budgetMs: reflectBudgetMs,
            });
          } else {
            finalText = outcome.finalScript.fullText;

            logEvent('news.reflect', {
              ms: Date.now() - started,
              iterations: outcome.iterations,
              history: outcome.history,
            });
          }
        } catch (err) {
          // Reflect failure falls back to the unreviewed draft rather than
          // dropping the turn — finalText is still the original draft.
          warnEvent('news.reflect_error', { err: errText(err) });
        }
      }

      // The authoritative text. Once this lands the client drops the
      // provisional draft part, so the reader ends on exactly one copy of the
      // script — the reviewed one when reflect ran, the draft verbatim when it
      // didn't.
      const textId = 'news-final';
      writer.write({ type: 'text-start', id: textId });
      writer.write({ type: 'text-delta', id: textId, delta: finalText });
      writer.write({ type: 'text-end', id: textId });
    },
    onFinish: async ({ responseMessage }) => {
      if (!chatId) return;
      try {
        // Concatenate every text segment — the model often emits text both
        // before and after tool calls (fetchArticle / searchCorpus / webSearch),
        // and `.find` would drop everything after the first segment, leaving
        // the persisted script truncated and the source list empty.
        const responseText = (responseMessage.parts ?? [])
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('');

        const { script, sources } = extractSources(responseText);

        // Build parts: script + sources as data
        const persistedParts: Array<{ type: string; [key: string]: unknown }> = [
          { type: 'text', text: script },
        ];
        if (sources.length > 0) {
          persistedParts.push({ type: 'data-sources', data: sources });
        }

        // Persist any breaking-scan suggestions emitted this turn so the cards
        // survive a reload, consistent with the data-sources persistence above.
        for (const part of responseMessage.parts ?? []) {
          if (part.type === 'data-breaking-suggestions') {
            persistedParts.push({
              type: 'data-breaking-suggestions',
              data: (part as { data: unknown }).data,
            });
          }
        }

        await persistAssistantMessage({
          chatId,
          message: {
            id: responseMessage.id,
            role: responseMessage.role,
            parts: persistedParts,
          },
          redactFiles: true,
        });

        logEvent('news.sources_extracted', {
          chatId,
          sourceCount: sources.length,
          scriptLength: script.length,
        });
      } catch (err) {
        warnEvent('news.persist_assistant_error', { err: errText(err) });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
