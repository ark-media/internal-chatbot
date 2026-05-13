import {
  convertToModelMessages,
  streamText,
  type UIMessage,
} from 'ai';

import { ensureChatTables, loadChat } from '@/lib/chats';
import { checkRateLimit } from '@/lib/rate-limit';
import { stripStaleToolOutputs } from '@/lib/strip-tool-outputs';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Pinned to Sonnet (not user-selectable like /api/chat) so summary quality
// and citation-preservation behavior are consistent regardless of which model
// the user chose for the conversation itself.
const SUMMARY_MODEL = 'anthropic/claude-sonnet-4-6';

function textError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

const SUMMARY_SYSTEM_PROMPT = `You are producing a handoff message. The user will paste your output as the FIRST message of a fresh chat with you, then send their next question as a follow-up turn. Write from the user's first-person voice ("I've been digging into…"), addressed to the next instance of you.

The conversation you're summarizing is from Ark Media's internal podcast-archive chatbot. Assistant responses cite podcast transcripts with [id:N] and [turn:N] markers. Preserve these citations verbatim — the next assistant can pass them to lookupCorpus or getDossier to re-pull the underlying transcripts (IDs are stable unless the episode has been re-ingested since).

Structure:

1. A short opener (1–2 sentences) naming what the user has been investigating, plus one sentence flagging that this is context from a prior chat and the follow-up question is coming in the next message.

2. ## Findings so far
   Substantive findings grouped by sub-topic. Short bullets. Every claim is followed by the existing [id:N] or [turn:N] citation EXACTLY as it appeared. Do not invent or renumber.

3. ## Open threads
   Only include if the prior conversation left something unresolved or was heading somewhere specific. Omit the heading entirely otherwise.

Rules:
- First-person, user's voice. Do not address the user; address the next assistant.
- Skip meta-conversation (clarifying back-and-forth, refusals, "I don't have information on that"). Focus on what was actually found.
- Under 400 words.
- Output markdown only. Do not wrap your answer in code fences. Do not add a preamble like "Here is the handoff".`;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureChatTables();
  const { id } = await params;

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`summary:${ip}`);
  if (!ok) {
    return textError('Rate limit exceeded. Try again in a minute.', 429);
  }

  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return textError('Forbidden', 403);
      }
    } catch {
      return textError('Forbidden', 403);
    }
  }

  const chat = await loadChat(id);
  if (!chat) {
    return textError('Chat not found.', 404);
  }

  const hasAssistant = chat.messages.some((m) => m.role === 'assistant');
  if (!hasAssistant || chat.messages.length < 2) {
    return textError('Need at least one assistant reply before composing a handoff.', 400);
  }

  // Drop UI-only data-* parts and stale tool outputs before sending history to
  // the model — same treatment as the main chat route, minus the retrieval
  // step. The summary model only needs the text the user and assistant
  // exchanged plus the most-recent tool evidence.
  const uiMessages = chat.messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: (m.parts ?? []).filter(
      (p) => !(typeof p.type === 'string' && p.type.startsWith('data-')),
    ),
  })) as UIMessage[];
  const messagesForModel = stripStaleToolOutputs(uiMessages);

  // Anthropic rejects requests whose final message is from the assistant
  // (it interprets that as a prefill, which Sonnet doesn't support). Append a
  // synthetic user turn that asks for the summary, so the system prompt's
  // formatting rules apply to a normal user-initiated response.
  const modelMessages = await convertToModelMessages(messagesForModel);
  modelMessages.push({
    role: 'user',
    content:
      'Now produce the handoff message described in your instructions, written in my voice for the next assistant.',
  });

  const result = streamText({
    model: SUMMARY_MODEL,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: modelMessages,
    temperature: 0.2,
    abortSignal: req.signal,
  });

  return result.toTextStreamResponse();
}
