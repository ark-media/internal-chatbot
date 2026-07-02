import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { z } from 'zod';

import { sql } from '@/lib/db';
import { DEFAULT_MODEL_ID } from '@/lib/models';
import { lookupCorpus } from '@/lib/retrieval';
import { webSearch } from '@/lib/web-search';
import { newsSystemPrompt, newsContextForDate, getNewsExamples } from '@/lib/news-prompt';
import { extractSources } from '@/lib/news-script';
import { runBreakingScan } from '@/lib/orchestrator/breaking-scan';
import { ensureTable, getCached, setCached, cacheKey } from '@/lib/tool-cache';
import { ensureEnglish } from '@/lib/translate';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  TEXT_MEDIA_TYPES,
  formatBytes,
} from '@/lib/prep-limits';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveTemperature } from '@/lib/temperature';
import { stripStaleToolOutputs } from '@/lib/strip-tool-outputs';
import {
  ensureChatTables,
  persistAssistantMessage,
  persistIncomingMessages,
  deleteMessageAndSubsequent,
} from '@/lib/chats';
import type { NewsUIMessage, ScanProgressSnapshot } from '@/components/news-types';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

// -- File handling -----------------------------------------------------------

function validateUploads(messages: UIMessage[]): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser?.parts) return null;
  const fileParts = lastUser.parts.filter((p) => p.type === 'file');
  if (fileParts.length === 0) return null;
  if (fileParts.length > MAX_FILES) {
    return `Too many files (${fileParts.length}). Maximum ${MAX_FILES} per message.`;
  }
  let total = 0;
  for (const p of fileParts) {
    const size = estimateDataUrlBytes(p.url);
    if (size > MAX_FILE_BYTES) {
      return `File "${p.filename ?? 'uploaded file'}" is ${formatBytes(size)}. Maximum ${formatBytes(MAX_FILE_BYTES)} per file.`;
    }
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) {
    return `Uploaded files total ${formatBytes(total)}. Maximum ${formatBytes(MAX_TOTAL_BYTES)} per message.`;
  }
  return null;
}

function normalizeMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.parts)) return m;
    const newParts: UIMessage['parts'] = [];
    for (const part of m.parts) {
      if (part.type !== 'file') {
        newParts.push(part);
        continue;
      }
      if (!TEXT_MEDIA_TYPES.has(part.mediaType)) {
        newParts.push(part);
        continue;
      }
      const text = decodeDataUrl(part.url);
      if (text === null) {
        newParts.push(part);
        continue;
      }
      const label = (part.filename ?? 'uploaded file').replace(/"/g, '&quot;');
      newParts.push({
        type: 'text',
        text: `<uploaded_file name="${label}" media_type="${part.mediaType}">\n${text}\n</uploaded_file>`,
      });
    }
    return { ...m, parts: newParts };
  });
}

function estimateDataUrlBytes(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return url.length;
  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  if (header.endsWith(';base64')) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.floor((payload.length * 3) / 4) - padding;
  }
  return payload.length;
}

function decodeDataUrl(url: string): string | null {
  const match = /^data:[^;,]*(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const isBase64 = match[1] === ';base64';
  const payload = match[2];
  try {
    if (isBase64) return Buffer.from(payload, 'base64').toString('utf8');
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

// -- Route handler -----------------------------------------------------------

export async function POST(req: Request) {
  await ensureTable();
  await ensureChatTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`news:${ip}`);
  if (!ok) {
    return new Response('Rate limit exceeded', { status: 429 });
  }

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

  const body = (await req.json()) as { messages?: unknown; chatId?: string; editingMessageId?: string };
  const chatId = typeof body.chatId === 'string' ? body.chatId : undefined;
  const editingMessageId = typeof body.editingMessageId === 'string' ? body.editingMessageId : undefined;

  const validated = await safeValidateUIMessages<UIMessage>({ messages: body.messages });
  if (!validated.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_messages', detail: validated.error.message }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  const messages = validated.data;
  const model = req.headers.get('x-model') || DEFAULT_MODEL_ID;
  const temperature = resolveTemperature(req.headers.get('x-temperature'));
  const uploadError = validateUploads(messages);
  if (uploadError) {
    return new Response(uploadError, {
      status: 413,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (chatId && editingMessageId) {
    try {
      await deleteMessageAndSubsequent(chatId, editingMessageId);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'news.delete_for_edit_error', err: String(err) }));
    }
  }

  if (chatId) {
    try {
      await persistIncomingMessages({
        chatId,
        surface: 'news',
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: (m.parts ?? []) as Array<{ type: string; [key: string]: unknown }>,
        })),
        redactFiles: true,
      });
    } catch (err) {
      console.warn(JSON.stringify({ event: 'news.persist_user_error', err: String(err) }));
    }
  }

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
  const nowIso = new Date().toISOString();

  const stream = createUIMessageStream<NewsUIMessage>({
    originalMessages: messages as NewsUIMessage[],
    execute: ({ writer }) => {
      // scanBreakingNews runs the deterministic breaking-scan pipeline (T-001…
      // T-009) and streams its tiered suggestions to the client as a typed
      // `data-breaking-suggestions` part, mirroring the data-sources pattern.
      // It performs NO script edits — Phase 1 is suggestions-only.
      const scanBreakingNewsTool = tool({
        description:
          "Scan the approved news outlets for breaking news that broke AFTER a finalized script was locked, and return ranked Swap / Update / Can't-ignore suggestions. Call this (and only this) when a finalized script is present and the writer asks to check for breaking news or more relevant stories. Do NOT edit or draft the script on this turn — present the suggestions and wait.",
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
        temperature,
        // Propagate client disconnect / Stop into the provider call so the
        // model stops generating instead of burning tokens to completion.
        abortSignal: req.signal,
        onFinish: ({ usage, finishReason, steps }) => {
          const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
          console.log(
            JSON.stringify({
              event: 'news.finish',
              ms: Date.now() - started,
              finishReason,
              toolCalls: toolCalls.map((t) => t.toolName),
              inputTokens: usage?.inputTokens,
              outputTokens: usage?.outputTokens,
              cachedInputTokens: usage?.cachedInputTokens,
            }),
          );
        },
      });

      writer.merge(
        result.toUIMessageStream<NewsUIMessage>({
          sendSources: false,
          sendReasoning: false,
        }),
      );
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

        console.log(
          JSON.stringify({
            event: 'news.sources_extracted',
            chatId,
            sourceCount: sources.length,
            scriptLength: script.length,
          })
        );
      } catch (err) {
        console.warn(JSON.stringify({ event: 'news.persist_assistant_error', err: String(err) }));
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
