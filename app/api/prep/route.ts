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

import { lookupCorpus, listSpeakers, getDossier } from '@/lib/retrieval';
import { webSearch } from '@/lib/web-search';
import { prepSystemPrompt } from '@/lib/prep-prompt';
import { ensureTable, getCached, setCached, cacheKey } from '@/lib/tool-cache';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  TEXT_MEDIA_TYPES,
  formatBytes,
} from '@/lib/prep-limits';
import { checkRateLimit } from '@/lib/rate-limit';
import type { PrepUIMessage } from '@/components/prep-types';

export const runtime = 'nodejs';
export const maxDuration = 300;

// -- Tools -------------------------------------------------------------------

const searchCorpusTool = tool({
  description:
    "Search Ark Media's own podcast transcript corpus. Use to find past episodes where this guest has appeared (to avoid repeating ground, or to surface contradictions) or past episodes on the same topic. Returns up to 6 matching excerpts with show/title/date.",
  inputSchema: z.object({
    query: z.string().describe('Natural-language search query — usually the guest name + topic.'),
    guestName: z
      .string()
      .optional()
      .describe(
        'If set, filter to turns spoken by this guest (resolved by name). Useful for "what has this guest said before on our shows?".',
      ),
  }),
  execute: async (input) => {
    const key = cacheKey('prep-corpus', input);
    const cached = await getCached(key, 24);
    if (cached) return cached;

    let speakerIds: number[] | undefined;
    let resolvedGuest: string | null = null;

    if (input.guestName?.trim()) {
      const matches = await listSpeakers({
        nameLike: input.guestName,
        includeUnreviewed: false,
        limit: 3,
      });
      if (matches.length > 0) {
        speakerIds = [matches[0].speakerId];
        resolvedGuest = matches[0].canonicalName;
      }
    }

    const chunks = await lookupCorpus({
      query: input.query,
      filters: { speakerIds },
      finalK: 6,
    });

    const response =
      chunks.length === 0
        ? {
            chunks: [],
            resolvedGuest,
            note: resolvedGuest
              ? `No matching passages found for ${resolvedGuest} on this topic.`
              : 'No matching passages found in the corpus.',
          }
        : {
            resolvedGuest,
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

const pastGuestAppearancesTool = tool({
  description:
    "List all past Ark Media episodes where a named person has spoken. Returns a chronological dossier of their turns (first 50). Useful for 'what has this guest said on our shows before?' — review before prepping follow-up or second appearances.",
  inputSchema: z.object({
    guestName: z.string().describe('Full name of the guest.'),
  }),
  execute: async (input) => {
    const matches = await listSpeakers({
      nameLike: input.guestName,
      includeUnreviewed: false,
      limit: 3,
    });
    if (matches.length === 0) {
      return { found: false, note: `No speaker matching "${input.guestName}" in the corpus. This is likely a first-time guest.` };
    }
    const best = matches[0];
    const page = await getDossier({ speakerId: best.speakerId, limit: 50 });
    return {
      found: true,
      speakerName: best.canonicalName,
      totalTurns: page.totalCount,
      episodeCount: best.episodeCount,
      shows: best.shows,
      turns: page.turns.slice(0, 30).map((t) => ({
        id: t.turnId,
        episode_title: t.episodeTitle,
        show: t.showName,
        date: t.date,
        excerpt: t.text.slice(0, 400),
      })),
    };
  },
});

const webSearchTool = tool({
  description:
    'Web search (Tavily) for recent news, columns, interviews, and context about the guest or episode topic. Use with specific terms from the episode title + guest name. If this returns not_configured or error, proceed without it and do not mention the failure in the output.',
  inputSchema: z.object({
    query: z.string().describe('Search query — usually guest name + topic keywords.'),
    daysBack: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Limit to results from the last N days. Useful for recent-news queries.'),
  }),
  execute: async (input) => {
    const key = cacheKey('prep-websearch', input);
    const cached = await getCached(key, 6);
    if (cached) return cached;

    const res = await webSearch(input.query, {
      maxResults: 6,
      daysBack: input.daysBack,
    });

    const response =
      !res.ok
        ? { results: [], note: res.note }
        : {
            results: res.results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.snippet,
              published: r.publishedDate ?? null,
            })),
          };

    await setCached(key, response);
    return response;
  },
});

// -- File handling -----------------------------------------------------------
//
// Claude reads PDFs and images natively via file parts. For text-ish uploads
// (.md, .txt, .csv) we decode the data URL to UTF-8 and replace the file part
// with a text part so the content actually reaches the model.

// Inspects the latest user message only — historical turns were already
// validated on their own request. Returns null on success, an error message on
// violation.
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
  // data:<media-type>;base64,<payload>  or  data:<media-type>,<url-encoded>
  const comma = url.indexOf(',');
  if (comma < 0) return url.length;
  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  if (header.endsWith(';base64')) {
    // base64 encodes 3 bytes per 4 chars; subtract padding
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

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`prep:${ip}`);
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

  const result = streamText({
    model: 'anthropic/claude-sonnet-4-6',
    system: {
      role: 'system',
      content: prepSystemPrompt(today),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    messages: await convertToModelMessages(normalized),
    tools: {
      searchCorpus: searchCorpusTool,
      pastGuestAppearances: pastGuestAppearancesTool,
      webSearch: webSearchTool,
    },
    stopWhen: stepCountIs(6),
    temperature: 0.5,
    onFinish: ({ usage, finishReason, steps }) => {
      const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
      console.log(
        JSON.stringify({
          event: 'prep.finish',
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

  const stream = createUIMessageStream<PrepUIMessage>({
    execute: ({ writer }) => {
      writer.merge(
        result.toUIMessageStream<PrepUIMessage>({
          sendSources: false,
          sendReasoning: false,
        }),
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}
