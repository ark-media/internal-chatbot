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
import { lookupCorpus } from '@/lib/retrieval';
import { webSearch } from '@/lib/web-search';
import { newsSystemPrompt, newsContextForDate, getNewsExamples } from '@/lib/news-prompt';
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
import {
  ensureChatTables,
  persistAssistantMessage,
  persistIncomingMessages,
  deleteMessageAndSubsequent,
} from '@/lib/chats';
import type { NewsUIMessage } from '@/components/news-types';

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

// -- Source extraction -------------------------------------------------------

type ExtractedSources = Array<{
  num: number;
  title: string;
  url: string;
  date?: string;
  flags?: string;
}>;

function extractSources(text: string): { script: string; sources: ExtractedSources } {
  // Find the SOURCES heading at the start of a line. Tolerate:
  //   - any divider before it (---, ***, ___, or none),
  //   - heading variants (SOURCES, Sources, "Sources:", "## Sources"),
  //   - smart quotes / extra punctuation around the colon.
  // A strict prior regex required `\n---\nSOURCES:\n` exactly and silently
  // returned zero sources whenever the model drifted, persisting scripts
  // with empty source lists.
  const headingMatch = text.match(/(^|\n)[#\s>*]*sources\b[\s:．·.\-—]*\n/i);
  if (!headingMatch || headingMatch.index === undefined) {
    console.warn(
      JSON.stringify({
        event: 'news.extract_sources_format_not_found',
        textLength: text.length,
      })
    );
    return { script: text, sources: [] };
  }

  // Trim any trailing divider (---, ***, ___) or whitespace from the
  // script body so it doesn't end with the separator.
  const scriptEnd = headingMatch.index + (headingMatch[1] === '\n' ? 1 : 0);
  const script = text
    .slice(0, scriptEnd)
    .replace(/\n[\s>*#]*[-*_]{3,}\s*$/, '')
    .replace(/\s+$/, '');
  const sourcesText = text.slice(headingMatch.index + headingMatch[0].length);
  const sources: ExtractedSources = [];

  // Parse lines like: "1. Title — URL — Date [FLAG: note]"
  // Handles em-dashes in titles by identifying URLs and dates via pattern matching.
  // Examples that now parse correctly:
  // - "1. Reuters — Analysis — https://example.com — May 2026" (em-dash in title)
  // - "2. BBC Report — https://bbc.com/news" (missing date)
  // - "3. NYT: The Story — Full Text — https://nytimes.com [FLAG: blocked]" (complex title)
  const lines = sourcesText.split('\n').filter((l) => l.trim());
  let parseErrors = 0;
  let parseMethod: 'strict' | 'smart' = 'strict';

  for (const line of lines) {
    // First, try strict parsing: number. Title — URL — optional(Date) optional([FLAG: ...])
    // Require URL to start with http:// or https:// to avoid matching em-dashes in titles.
    const strictMatch = line.match(
      /^(\d+)\.\s+(.+?)\s+—\s+(https?:\/\/[^\s]+)(?:\s+—\s+(.+?))?(?:\s+\[FLAG:\s+(.+?)\])?$/
    );
    if (strictMatch) {
      sources.push({
        num: parseInt(strictMatch[1], 10),
        title: strictMatch[2].trim(),
        url: strictMatch[3].trim(),
        date: strictMatch[4]?.trim(),
        flags: strictMatch[5]?.trim(),
      });
      continue;
    }

    // Fallback: smart parsing that identifies URLs and dates by pattern.
    // This handles em-dashes in titles by recognizing field types.
    const numMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      const rest = numMatch[2];
      parseMethod = 'smart';

      // Extract flag if present (always at the end: [FLAG: ...])
      const flagMatch = rest.match(/\[FLAG:\s+(.+?)\]$/);
      const flagText = flagMatch?.[1]?.trim();
      const withoutFlag = flagMatch ? rest.slice(0, flagMatch.index).trim() : rest;

      // Find URL: look for http:// or https:// followed by non-whitespace
      const urlMatch = withoutFlag.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) {
        parseErrors++;
        continue;
      }

      const url = urlMatch[0];
      const urlStartIndex = withoutFlag.indexOf(url);
      const titlePart = withoutFlag.slice(0, urlStartIndex).trim();
      const datePart = withoutFlag.slice(urlStartIndex + url.length).trim();

      // Clean up title: remove trailing em-dash if present
      const cleanTitle = titlePart.replace(/\s+—\s*$/, '').trim();

      // Clean up date: remove leading em-dash if present
      const cleanDate = datePart.replace(/^\s*—\s+/, '').trim() || undefined;

      sources.push({
        num,
        title: cleanTitle,
        url,
        date: cleanDate,
        flags: flagText,
      });
    } else {
      parseErrors++;
    }
  }

  if (parseErrors > 0) {
    console.warn(
      JSON.stringify({
        event: 'news.extract_sources_parse_errors',
        totalLines: lines.length,
        parseErrors,
        successfulParses: sources.length,
        parseMethod,
      })
    );
  }

  return { script, sources };
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
  const model = req.headers.get('x-model') || 'anthropic/claude-sonnet-4-6';
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

  // Filter out data-sources before sending to model (keep only script text).
  // This ensures sources don't bloat the context on multi-turn conversations.
  const messagesForModel = normalized.map((m) => ({
    ...m,
    parts: m.parts?.filter((p) => p.type !== 'data-sources') ?? [],
  }));

  const allMessages = [...contextMessages, ...messagesForModel];

  const result = streamText({
    model,
    system: {
      role: 'system',
      content: baseSystemPrompt,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    messages: await convertToModelMessages(allMessages),
    tools: {
      fetchArticle: fetchArticleTool,
      searchCorpus: createSearchCorpusTool(arkNewsDailyShowId),
      webSearch: webSearchTool,
    },
    stopWhen: stepCountIs(8),
    temperature: 0.3,
    // Propagate client disconnect / Stop into the provider call so the model
    // stops generating instead of burning tokens to completion.
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

  const stream = createUIMessageStream<NewsUIMessage>({
    originalMessages: messages as NewsUIMessage[],
    execute: ({ writer }) => {
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
