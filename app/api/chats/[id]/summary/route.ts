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

const SUMMARY_SYSTEM_PROMPT = `You are summarising a research conversation from Ark Media's internal podcast-archive chatbot. The conversation is between a user and an assistant that cites podcast transcripts.

Produce a structured synthesis the user can paste into a research note.

Rules:
- Preserve every [id:N] and [turn:N] citation EXACTLY as it appears in the assistant's responses. Do not invent new citations. Do not strip or renumber them.
- Group findings by topic. Use markdown headings and short bullets.
- Omit the meta-conversation (clarifying back-and-forth, refusals, "I don't have information on that"). Focus on what was found.
- If the user asked multiple distinct questions, give each its own section.
- Keep it tight — under 400 words.
- Output markdown only. Do not wrap your answer in code fences. Do not add a preamble like "Here is the summary".`;

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
    return textError('Need at least one assistant reply before summarising.', 400);
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
      'Now produce the structured summary of the conversation above, following the rules in your instructions.',
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
