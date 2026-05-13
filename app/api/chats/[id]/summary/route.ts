import {
  convertToModelMessages,
  streamText,
  type UIMessage,
} from 'ai';

import { ensureChatTables, loadChat, type Surface } from '@/lib/chats';
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

const ARCHIVE_PROMPT = `You are producing a handoff message. The user will paste your output as the FIRST message of a fresh chat with you, then send their next question as a follow-up turn. Write from the user's first-person voice ("I've been digging into…"), addressed to the next instance of you.

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

const PREP_PROMPT = `You are producing a handoff message. The user will paste your output as the FIRST message of a fresh chat with you, then send their next instruction as a follow-up turn. Write from the user's first-person voice ("I'm prepping…"), addressed to the next instance of you.

The conversation you're summarizing is from Ark Media's episode-prep tool. The assistant has been researching an upcoming podcast episode (show, episode title, guest) and producing a set of 6–7 interview questions tagged [open] / [therefore] / [but]. The next assistant will pick up to refine the question set, swap angles, or extend the research. When the prior assistant quoted past articles or transcripts, preserve the attribution verbatim (publication + date, or show + date) so the next assistant can re-locate the source.

Structure:

1. A short opener (1–2 sentences) naming the episode being prepped (show, title, guest), plus one sentence flagging that this is context from a prior chat and the follow-up instruction is coming next.

2. ## Research so far
   Substantive facts that informed the questions, grouped by sub-topic. Short bullets. Quote attributions preserved verbatim.

3. ## Current question set
   The questions the prior assistant landed on, with their [open] / [therefore] / [but] tags. Compact form — one line each, numbered.

4. ## Open threads
   Only include if the user was actively asking for refinements or had unresolved direction. Omit the heading entirely otherwise.

Rules:
- First-person, user's voice. Do not address the user; address the next assistant.
- Skip meta-conversation (clarifying back-and-forth, refusals).
- Under 400 words.
- Output markdown only. Do not wrap your answer in code fences. Do not add a preamble like "Here is the handoff".`;

const NEWS_PROMPT = `You are producing a handoff message. The user will paste your output as the FIRST message of a fresh chat with you, then send their next instruction as a follow-up turn. Write from the user's first-person voice ("I'm scripting…"), addressed to the next instance of you.

The conversation you're summarizing is from Ark Media's daily news-script tool. The assistant has been turning a story outline into a structured script with [A BLOCK] / [B BLOCK] / [C BLOCK] sections, inline superscript footnotes (¹²³…), [FLAG: …] markers on uncertain claims, and a numbered SOURCES list at the end. The next assistant will pick up to refine blocks, re-balance tone or length, or re-fetch sources. Carry source attributions forward intact — when the prior script cited "N. Outlet, \\"Headline\\" — URL", reproduce that entry verbatim so the next assistant can re-fetch via fetchArticle.

Structure:

1. A short opener (1–2 sentences) naming the day's lead and the overall A → B → C arc, plus one sentence flagging that this is context from a prior chat and the follow-up instruction is coming next.

2. ## Story angle
   What each block is doing, in one line each.

3. ## Sources gathered
   The numbered SOURCES list from the prior script, verbatim. Include any [FLAG: …] notes that were attached to specific sources.

4. ## Open threads
   Only include if the user was actively asking for refinements (tone, length, transitions, contradictions) or unresolved direction. Omit the heading entirely otherwise.

Rules:
- First-person, user's voice. Do not address the user; address the next assistant.
- Skip meta-conversation (clarifying back-and-forth, refusals).
- Under 500 words (the sources list can push length).
- Output markdown only. Do not wrap your answer in code fences. Do not add a preamble like "Here is the handoff".`;

const SYSTEM_PROMPTS: Record<Surface, string> = {
  archive: ARCHIVE_PROMPT,
  prep: PREP_PROMPT,
  news: NEWS_PROMPT,
};

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
    system: SYSTEM_PROMPTS[chat.surface],
    messages: modelMessages,
    temperature: 0.2,
    abortSignal: req.signal,
  });

  return result.toTextStreamResponse();
}
