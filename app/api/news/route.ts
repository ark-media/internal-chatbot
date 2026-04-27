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
import { lookupCorpus } from '@/lib/retrieval';
import { webSearch } from '@/lib/web-search';
import { newsSystemPrompt } from '@/lib/news-prompt';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  TEXT_MEDIA_TYPES,
  formatBytes,
} from '@/lib/prep-limits';
import { checkRateLimit } from '@/lib/rate-limit';
import type { NewsUIMessage } from '@/components/news-types';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
        extract_depth: 'advanced', // Required for X/Twitter and paywalled sites
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

    return {
      ok: true,
      url: result.url ?? articleUrl,
      title: result.title ?? 'Untitled',
      text: result.raw_content ?? '',
      date: result.publish_date ?? null,
      source: result.source_name ?? 'Unknown',
    };
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
      const chunks = await lookupCorpus({
        query: input.query,
        filters: arkNewsDailyShowId ? { showIds: [arkNewsDailyShowId] } : undefined,
        finalK: 4,
      });

      if (chunks.length === 0) {
        return {
          chunks: [],
          note: 'No matching scripts found in Ark News Daily archive.',
        };
      }

      return {
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
    const res = await webSearch(input.query, {
      maxResults: 6,
      daysBack: input.daysBack,
    });
    if (!res.ok) {
      return { results: [], note: res.note };
    }
    return {
      results: res.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        published: r.publishedDate ?? null,
      })),
    };
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

  const { messages }: { messages: UIMessage[] } = await req.json();
  const uploadError = validateUploads(messages);
  if (uploadError) {
    return new Response(uploadError, {
      status: 413,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const normalized = normalizeMessages(messages);
  const today = new Date().toISOString().slice(0, 10);
  const started = Date.now();

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

  const result = streamText({
    model: 'anthropic/claude-sonnet-4-6',
    system: {
      role: 'system',
      content: newsSystemPrompt(today),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    messages: await convertToModelMessages(normalized),
    tools: {
      fetchArticle: fetchArticleTool,
      searchCorpus: createSearchCorpusTool(arkNewsDailyShowId),
      webSearch: webSearchTool,
    },
    stopWhen: stepCountIs(8),
    temperature: 0.3,
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
    execute: ({ writer }) => {
      writer.merge(
        result.toUIMessageStream<NewsUIMessage>({
          sendSources: false,
          sendReasoning: false,
        }),
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}
