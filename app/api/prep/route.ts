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

import {
  lookupCorpus,
  listSpeakers,
  getDossier,
  type DossierTurn,
} from '@/lib/retrieval';
import { webSearch } from '@/lib/web-search';
import { extractArticles, type ExtractedArticle } from '@/lib/url-fetch';
import { extractPrepContext } from '@/lib/prep-extract';
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
import {
  ensureChatTables,
  persistAssistantMessage,
  persistIncomingMessages,
  deleteMessageAndSubsequent,
} from '@/lib/chats';
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
    "List past Ark Media episodes where a named person has spoken. Returns a chronological dossier of their turns. Pass `topic` to narrow to turns matching a topic (full-text search) — strongly recommended for high-volume guests like Nadav Eyal where the unfiltered first 50 are mostly off-topic. Useful for 'what has this guest said on our shows before about X?'.",
  inputSchema: z.object({
    guestName: z.string().describe('Full name of the guest.'),
    topic: z
      .string()
      .optional()
      .describe(
        'Optional 2–6 keyword full-text filter, e.g. "Iran nuclear Hormuz". Drops stopwords. Omit only when you want the unfiltered chronological dossier.',
      ),
  }),
  execute: async (input) => {
    // Resolve the speaker first so the cache key can include episodeCount —
    // any newly ingested episode for that speaker auto-invalidates the entry,
    // independent of TTL. listSpeakers is a small indexed lookup.
    const matches = await listSpeakers({
      nameLike: input.guestName,
      includeUnreviewed: false,
      limit: 3,
    });
    if (matches.length === 0) {
      return { found: false, note: `No speaker matching "${input.guestName}" in the corpus. This is likely a first-time guest.` };
    }
    const best = matches[0];

    const key = cacheKey('prep-past-guest', {
      speakerId: best.speakerId,
      topic: input.topic ?? null,
      ec: best.episodeCount,
    });
    const cached = await getCached(key, 24);
    if (cached) return cached;

    const page = await getDossier({
      speakerId: best.speakerId,
      topic: input.topic,
      limit: 50,
    });
    const response = {
      found: true,
      speakerName: best.canonicalName,
      totalTurns: page.totalCount,
      episodeCount: best.episodeCount,
      shows: best.shows,
      topic: input.topic ?? null,
      turns: page.turns.slice(0, 30).map((t) => ({
        id: t.turnId,
        episode_title: t.episodeTitle,
        show: t.showName,
        date: t.date,
        excerpt: t.text.slice(0, 400),
      })),
    };
    await setCached(key, response);
    return response;
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

// -- Pre-retrieval helpers ---------------------------------------------------

// Cap on guests pre-loaded from a single prep prompt. Beyond this we trust the
// model to call pastGuestAppearances itself. Each pre-loaded dossier costs
// ~one DB round-trip + a few thousand tokens of context, so 4 is a comfortable
// ceiling for typical prep prompts (which name 1–2 guests).
const PREP_MAX_PRELOADED_GUESTS = 4;
// Bookend half-size per guest dossier. With topic filter applied, FTS
// already narrows the row set; this cap keeps the worst case bounded.
const PREP_DOSSIER_BOOKEND_HALF = 12;

function firstUserText(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const p of m.parts ?? []) {
      if (p.type === 'text') return p.text;
    }
  }
  return '';
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildDossierEvidenceBlock(
  speakerName: string,
  speakerId: number,
  turns: DossierTurn[],
  totalCount: number,
  topic: string | null,
): string {
  if (turns.length === 0) {
    const topicNote = topic ? ` matching topic "${topic}"` : '';
    return `<dossier speaker="${escapeAttr(speakerName)}" speaker_id="${speakerId}">\nNo past turns${topicNote} found in the corpus. Either this is a first-time guest on this topic, or extraction missed the right speaker — call pastGuestAppearances if you need broader history.\n</dossier>`;
  }

  const dates = turns.map((t) => t.date).filter((d): d is string => Boolean(d));
  const dateRange =
    dates.length > 0 ? `${dates[0]} → ${dates[dates.length - 1]}` : 'unknown';
  const topicNote = topic
    ? `Filtered by topic: "${topic}".`
    : 'Unfiltered (oldest + newest sample).';
  const moreNote =
    totalCount > turns.length
      ? `Showing ${turns.length} of ${totalCount} matching turns (oldest + newest). Call pastGuestAppearances for more.`
      : `Complete dossier (${turns.length} turns).`;

  const body = turns
    .map(
      (t) =>
        `<dossier_turn id="${t.turnId}" date="${t.date ?? 'unknown'}" show="${escapeAttr(t.showName)}" episode="${escapeAttr(t.episodeTitle)}">\n${t.speakerName}: ${t.text}\n</dossier_turn>`,
    )
    .join('\n\n');

  return `<dossier speaker="${escapeAttr(speakerName)}" speaker_id="${speakerId}" date_range="${dateRange}">\n${topicNote} ${moreNote}\n\n${body}\n</dossier>`;
}

function buildLinkedArticleBlock(article: ExtractedArticle): string {
  const titleAttr = article.title ? ` title="${escapeAttr(article.title)}"` : '';
  return `<linked_article url="${escapeAttr(article.url)}"${titleAttr}>\n${article.content}\n</linked_article>`;
}

type ResolvedGuest = {
  inputName: string;
  speakerId: number;
  canonicalName: string;
  episodeCount: number;
};

async function resolveGuestNames(names: string[]): Promise<ResolvedGuest[]> {
  const resolved = await Promise.all(
    names.map(async (name) => {
      const matches = await listSpeakers({
        nameLike: name,
        includeUnreviewed: false,
        limit: 3,
      });
      if (matches.length === 0) return null;
      const exact = matches.find(
        (m) => m.canonicalName.toLowerCase() === name.toLowerCase(),
      );
      const pick = exact ?? matches[0];
      return {
        inputName: name,
        speakerId: pick.speakerId,
        canonicalName: pick.canonicalName,
        episodeCount: pick.episodeCount,
      };
    }),
  );
  // Dedupe by speakerId — the user might say "Nadav" and "Eyal" separately.
  const seen = new Set<number>();
  const out: ResolvedGuest[] = [];
  for (const r of resolved) {
    if (!r || seen.has(r.speakerId)) continue;
    seen.add(r.speakerId);
    out.push(r);
  }
  return out;
}

async function loadGuestDossier(
  guest: ResolvedGuest,
  topic: string | null,
): Promise<{ turns: DossierTurn[]; totalCount: number }> {
  const cKey = cacheKey('prep-preload-dossier', {
    speakerId: guest.speakerId,
    topic,
    half: PREP_DOSSIER_BOOKEND_HALF,
    // Bump key whenever a new episode for this speaker has been ingested, so a
    // newly transcribed appearance shows up in the dossier without waiting on
    // the TTL.
    ec: guest.episodeCount,
  });
  const cached = await getCached<{ turns: DossierTurn[]; totalCount: number }>(
    cKey,
    6,
  );
  if (cached) return cached;
  try {
    const page = await getDossier({
      speakerId: guest.speakerId,
      topic: topic ?? undefined,
      bookendHalf: PREP_DOSSIER_BOOKEND_HALF,
    });
    const result = { turns: page.turns, totalCount: page.totalCount };
    await setCached(cKey, result);
    return result;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'prep.preload_dossier_error',
        speakerId: guest.speakerId,
        err: String(err),
      }),
    );
    return { turns: [], totalCount: 0 };
  }
}

async function loadLinkedArticles(
  urls: string[],
): Promise<ExtractedArticle[]> {
  if (urls.length === 0) return [];
  const cKey = cacheKey('prep-preload-articles', { urls: [...urls].sort() });
  const cached = await getCached<ExtractedArticle[]>(cKey, 24);
  if (cached) return cached;
  const resp = await extractArticles(urls);
  if (resp.failed.length > 0) {
    console.warn(
      JSON.stringify({
        event: 'prep.article_fetch_failed',
        failures: resp.failed,
      }),
    );
  }
  await setCached(cKey, resp.ok);
  return resp.ok;
}

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
  await ensureChatTables();

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
      console.warn(JSON.stringify({ event: 'prep.delete_for_edit_error', err: String(err) }));
    }
  }

  if (chatId) {
    try {
      await persistIncomingMessages({
        chatId,
        surface: 'prep',
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: (m.parts ?? []) as Array<{ type: string; [key: string]: unknown }>,
        })),
        redactFiles: true,
      });
    } catch (err) {
      console.warn(JSON.stringify({ event: 'prep.persist_user_error', err: String(err) }));
    }
  }

  const normalized = normalizeMessages(messages);
  const today = new Date().toISOString().slice(0, 10);
  const started = Date.now();

  // Pre-retrieval: only on the first user turn, fan out to load guest dossiers
  // and linked articles in parallel, then inject as <dossier>/<linked_article>
  // blocks below the cached base prompt. Subsequent turns inherit the cached
  // base + cumulative messages and rely on tools for any additional evidence.
  const isFirstUserTurn = messages.filter((m) => m.role === 'user').length === 1;
  const userText = firstUserText(messages);
  const evidenceBlocks: string[] = [];
  let preMs = 0;
  let preSummary: {
    guests: number;
    resolved: number;
    topic: string | null;
    urls: number;
    articlesOk: number;
  } | null = null;

  if (isFirstUserTurn && userText.trim().length > 0) {
    const preStart = Date.now();
    try {
      const extracted = await extractPrepContext(userText, today);
      const limitedGuests = extracted.guests.slice(0, PREP_MAX_PRELOADED_GUESTS);

      const [resolvedGuests, articles] = await Promise.all([
        resolveGuestNames(limitedGuests),
        loadLinkedArticles(extracted.urls),
      ]);

      const dossiers = await Promise.all(
        resolvedGuests.map((g) =>
          loadGuestDossier(g, extracted.topic).then((page) => ({
            guest: g,
            ...page,
          })),
        ),
      );

      for (const d of dossiers) {
        evidenceBlocks.push(
          buildDossierEvidenceBlock(
            d.guest.canonicalName,
            d.guest.speakerId,
            d.turns,
            d.totalCount,
            extracted.topic,
          ),
        );
      }
      for (const article of articles) {
        evidenceBlocks.push(buildLinkedArticleBlock(article));
      }

      preSummary = {
        guests: extracted.guests.length,
        resolved: resolvedGuests.length,
        topic: extracted.topic,
        urls: extracted.urls.length,
        articlesOk: articles.length,
      };
    } catch (err) {
      console.warn(
        JSON.stringify({ event: 'prep.preretrieval_error', err: String(err) }),
      );
    }
    preMs = Date.now() - preStart;
  }

  // Two cache breakpoints: one after the base prompt (stable across all prep
  // requests) and a second after the evidence block (stable across the
  // multi-step tool loop within a single first-turn prep request). Without the
  // second breakpoint, the bookended dossier (~13–18K tokens for high-volume
  // guests) gets re-tokenised on every tool step. Follow-up turns inherit only
  // the base-prompt cache; evidenceBlocks is only built on the first user turn.
  const cachedBaseSystem = {
    role: 'system' as const,
    content: prepSystemPrompt(today),
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };
  const system =
    evidenceBlocks.length > 0
      ? [
          cachedBaseSystem,
          {
            role: 'system' as const,
            content: evidenceBlocks.join('\n\n'),
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
          },
        ]
      : cachedBaseSystem;

  const result = streamText({
    model,
    system,
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
          preMs,
          preSummary,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          cachedInputTokens: usage?.cachedInputTokens,
        }),
      );
    },
  });

  const stream = createUIMessageStream<PrepUIMessage>({
    originalMessages: messages as PrepUIMessage[],
    execute: ({ writer }) => {
      writer.merge(
        result.toUIMessageStream<PrepUIMessage>({
          sendSources: false,
          sendReasoning: false,
        }),
      );
    },
    onFinish: async ({ responseMessage }) => {
      if (!chatId) return;
      try {
        await persistAssistantMessage({
          chatId,
          message: {
            id: responseMessage.id,
            role: responseMessage.role,
            parts: (responseMessage.parts ?? []) as Array<{ type: string; [key: string]: unknown }>,
          },
          redactFiles: true,
        });
      } catch (err) {
        console.warn(JSON.stringify({ event: 'prep.persist_assistant_error', err: String(err) }));
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
