// The scriptwriter's single conversational endpoint. Turn 1 (stage
// 'sourcing') runs the deterministic open-web sourcing pipeline inline,
// streaming progress as an id-reconciled data part; every turn then runs the
// Sonnet 5 conductor, whose tools mutate the run and stream Opus block drafts
// / episode assembly to the client as data parts.

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UIMessage,
} from 'ai';

import {
  ensureChatTables,
  persistAssistantMessage,
  persistIncomingMessages,
} from '@/lib/chats';
import { getNewsExamples } from '@/lib/news-prompt';
import { checkRateLimit } from '@/lib/rate-limit';
import { stripStaleToolOutputs } from '@/lib/strip-tool-outputs';
import { ensureTable as ensureToolCacheTable } from '@/lib/tool-cache';
import { CONDUCTOR_SYSTEM, buildRunStateContext } from '@/lib/scriptwriter/prompts';
import { parseScopeFromPrompt } from '@/lib/scriptwriter/scope';
import { sourceStories, type SourcingProgress } from '@/lib/scriptwriter/sourcing';
import {
  claimSourcing,
  ensureScriptRunTables,
  loadRun,
  saveRun,
} from '@/lib/scriptwriter/state';
import { createConductorTools, topicSummary, type EmitPart } from '@/lib/scriptwriter/tools';
import type { ScriptRun } from '@/lib/scriptwriter/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONDUCTOR_MODEL = 'anthropic/claude-sonnet-5';

// Data-part types persisted with the assistant message (so cards survive a
// reload). Streaming/progress parts are deliberately not persisted — the
// id-reconciled 'ready' state is what lands in responseMessage.parts.
const DURABLE_DATA_PARTS = new Set(['data-topics', 'data-block', 'data-episode']);

// Full topic-card payload for the client (summaries + per-source credibility).
function topicCard(run: ScriptRun, index: number) {
  const t = run.topics[index];
  return {
    ...topicSummary(run, index),
    angle: t.story.angle,
    rationale: t.story.rationale,
    register: t.story.register,
    sources: t.story.sources.map((s) => ({
      title: s.title,
      url: s.url,
      source: s.source,
      publicationDate: s.publicationDate,
      credibility: s.credibility,
      credibilityNote: s.credibilityNote,
      isFlagged: s.isFlagged ?? false,
      fetchError: s.fetchError ?? null,
    })),
  };
}

export async function POST(req: Request) {
  await Promise.all([ensureChatTables(), ensureScriptRunTables(), ensureToolCacheTable()]);

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`scripts:${ip}`);
  if (!ok) return new Response('Rate limit exceeded', { status: 429 });

  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return new Response('Forbidden', { status: 403 });
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  let body: { messages?: unknown; chatId?: string };
  try {
    body = (await req.json()) as { messages?: unknown; chatId?: string };
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const chatId = typeof body.chatId === 'string' ? body.chatId : undefined;
  if (!chatId) {
    return Response.json({ error: 'missing_chat_id' }, { status: 400 });
  }

  const validated = await safeValidateUIMessages<UIMessage>({ messages: body.messages });
  if (!validated.success) {
    return Response.json(
      { error: 'invalid_messages', detail: validated.error.message },
      { status: 400 },
    );
  }
  const messages = validated.data;

  const initialRun = await loadRun(chatId);
  if (!initialRun) {
    return Response.json({ error: 'run_not_found' }, { status: 404 });
  }

  try {
    await persistIncomingMessages({
      chatId,
      surface: 'scripts',
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: (m.parts ?? []) as Array<{ type: string; [key: string]: unknown }>,
      })),
      redactFiles: true,
    });
  } catch (err) {
    console.warn(JSON.stringify({ event: 'scripts.persist_user_error', err: String(err) }));
  }

  const started = Date.now();

  // Set when the only thing this turn emits is a transient status message
  // ("sourcing already running" / "sourcing failed — retry"). Those must not
  // land in durable history, or they replay as assistant messages on reload.
  let transientOnly = false;

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      const emit: EmitPart = (part) =>
        writer.write(part as Parameters<typeof writer.write>[0]);

      // Mutable run reference shared by the sourcing turn and the conductor
      // tools within this request.
      let run = initialRun;
      const ctx = {
        getRun: () => run,
        setRun: (next: ScriptRun) => {
          run = next;
        },
        emit,
        signal: req.signal,
      };

      // -- Sourcing turn (first message, or retry after a failed sourcing) --
      // 'sourcing' is fresh/retry; 'sourcing-active' is either in-flight (claim
      // will lose) or a crashed run past the stale window (claim will win).
      const needsSourcing =
        run.stage === 'sourcing' || run.stage === 'sourcing-active';
      if (needsSourcing) {
        // Atomic stage CAS: flips 'sourcing' → 'sourcing-active' for exactly
        // one caller. A staggered second message sees a live 'sourcing-active'
        // and loses the claim, so discovery never runs twice.
        const claimed = await claimSourcing(chatId);
        if (!claimed) {
          transientOnly = true;
          writer.write({
            type: 'text-start' as const,
            id: 'busy',
          });
          writer.write({
            type: 'text-delta' as const,
            id: 'busy',
            delta: 'Sourcing is already running for this episode — give it a moment, then reload.',
          });
          writer.write({ type: 'text-end' as const, id: 'busy' });
          return;
        }
        run = (await loadRun(chatId)) ?? run;

        const progress: Record<string, unknown> = {};
        const onProgress = (p: SourcingProgress) => {
          progress[p.step] = p.count ?? true;
          writer.write({
            type: 'data-sourcing-progress' as const,
            id: 'sourcing-progress',
            data: { ...progress },
          });
        };

        try {
          // Scope comes from the original prompt (start page); parse before
          // discovery since targeted mode changes the queries.
          if (run.originalPrompt) {
            run = { ...run, scope: await parseScopeFromPrompt(run.originalPrompt) };
          }
          const examples = await getNewsExamples();
          const { topics, backups, candidates, insufficientPool } = await sourceStories({
            today: run.today,
            scope: run.scope,
            guidance: run.originalPrompt ?? undefined,
            examples: examples.slice(0, 8000),
            onProgress,
            signal: req.signal,
          });
          const snapshotCandidates = candidates.map((c) => ({
            title: c.title,
            url: c.url,
            source: c.source,
            publicationDate: c.publicationDate,
          }));

          if (topics.length === 0) {
            // The pool couldn't support a single valid block. Surface that
            // honestly — never fabricate block cards — and stay in 'sourcing'
            // so the next message retries (news may break through the day).
            const reason =
              insufficientPool?.reason ??
              'No stories in the pool met the freshness and newsworthiness bar for today.';
            const fallbacks = backups.length > 0
              ? backups.map((b) => {
                  const s = b.sources[0];
                  const meta = s
                    ? ` (${s.source}${s.publicationDate ? `, ${s.publicationDate}` : ''})`
                    : '';
                  return `- ${b.headline}${meta}`;
                })
              : snapshotCandidates.slice(0, 5).map(
                  (c) => `- ${c.title} (${c.source}${c.publicationDate ? `, ${c.publicationDate}` : ''})`,
                );
            run = {
              ...run,
              stage: 'sourcing',
              topics: [],
              backups,
              candidates: snapshotCandidates,
              errorMessage: null,
              sourcingNote: reason,
            };
            await saveRun(run);
            transientOnly = true;
            const message = `I couldn't put together a valid rundown from today's sourcing.\n\n${reason}\n\nClosest items I found — all outside the acceptable window or off-beat, so use one only if you want to deliberately opt in:\n${fallbacks.join('\n')}\n\nReply when you'd like me to try sourcing again.`;
            writer.write({ type: 'text-start' as const, id: 'sourcing-thin' });
            writer.write({ type: 'text-delta' as const, id: 'sourcing-thin', delta: message });
            writer.write({ type: 'text-end' as const, id: 'sourcing-thin' });
            return;
          }

          run = {
            ...run,
            stage: 'working',
            topics,
            backups,
            candidates: snapshotCandidates,
            errorMessage: null,
            // A thin-but-usable rundown carries the selector's note so the
            // conductor can explain the unfilled slots instead of implying
            // they exist.
            sourcingNote: insufficientPool?.reason ?? null,
          };
          await saveRun(run);
          writer.write({
            type: 'data-topics' as const,
            data: run.topics.map((_, i) => topicCard(run, i)),
          });
        } catch (err) {
          if (req.signal.aborted) return;
          const message = String(err instanceof Error ? err.message : err).slice(0, 300);
          console.warn(JSON.stringify({ event: 'scripts.sourcing_error', err: message }));
          run = { ...run, stage: 'sourcing', errorMessage: message };
          await saveRun(run);
          transientOnly = true;
          writer.write({ type: 'text-start' as const, id: 'sourcing-error' });
          writer.write({
            type: 'text-delta' as const,
            id: 'sourcing-error',
            delta: `Sourcing failed: ${message}\n\nSend another message to retry.`,
          });
          writer.write({ type: 'text-end' as const, id: 'sourcing-error' });
          return;
        }
      }

      // -- Conductor turn --
      // History for the model: drop data-* UI parts, stub stale tool outputs.
      const messagesForModel = stripStaleToolOutputs(
        messages.map((m) => ({
          ...m,
          parts: m.parts?.filter((p) => !p.type.startsWith('data-')) ?? [],
        })),
      );
      const modelMessages = await convertToModelMessages(messagesForModel);

      // Cache breakpoints: the system prompt (marked below) and the last
      // history message — the volatile run-state context sits AFTER it, so
      // the whole conversation prefix stays cached across turns and tool steps.
      const cachePoint = {
        anthropic: { cacheControl: { type: 'ephemeral' as const } },
      };
      const lastHistory = modelMessages.at(-1);
      if (lastHistory) lastHistory.providerOptions = cachePoint;

      const runStateMessage: ModelMessage = {
        role: 'user',
        content: [{ type: 'text', text: buildRunStateContext(run) }],
      };

      const result = streamText({
        model: CONDUCTOR_MODEL,
        system: {
          role: 'system',
          content: CONDUCTOR_SYSTEM,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        messages: [...modelMessages, runStateMessage],
        tools: createConductorTools(ctx),
        stopWhen: stepCountIs(6),
        abortSignal: req.signal,
        onFinish: ({ usage, finishReason, steps }) => {
          const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
          console.log(
            JSON.stringify({
              event: 'scripts.turn_finish',
              ms: Date.now() - started,
              stage: run.stage,
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
        result.toUIMessageStream({ sendSources: false, sendReasoning: false }),
      );
      try {
        await result.text;
      } catch {
        // Abort / provider error — already surfaced on the merged stream.
      }
    },
    onFinish: async ({ responseMessage }) => {
      try {
        // A transient-only turn produces just a status text part; keep only
        // durable data parts (there are none in that path) so the status text
        // never persists and replays on reload.
        const persistedParts = (responseMessage.parts ?? []).filter((p) =>
          transientOnly ? DURABLE_DATA_PARTS.has(p.type) : p.type === 'text' || DURABLE_DATA_PARTS.has(p.type),
        ) as Array<{ type: string; [key: string]: unknown }>;
        if (persistedParts.length === 0) return;
        await persistAssistantMessage({
          chatId,
          message: {
            id: responseMessage.id,
            role: responseMessage.role,
            parts: persistedParts,
          },
          redactFiles: true,
        });
      } catch (err) {
        console.warn(
          JSON.stringify({ event: 'scripts.persist_assistant_error', err: String(err) }),
        );
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
