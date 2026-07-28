import { safeValidateUIMessages, type UIMessage } from 'ai';

import { deleteMessageAndSubsequent, persistIncomingMessages } from './chats';
import { errText, warnEvent } from './log-event';
import { checkRateLimit } from './rate-limit';

// The preamble every chat-shaped route runs before it reaches the model. It was
// duplicated across chat/prep/news/orchestrator-chat, which is how the four
// drifted: three called `req.json()` unwrapped and turned a malformed body into
// an unhandled 500, while the fourth returned a 400.
//
// Deliberately two functions rather than one. The routes do genuinely different
// work between validating the request and persisting the turn — prep and news
// check uploads (413), the scripts route loads its run (404) — so a single
// linear helper would need a callback to slot that work into the middle. Two
// calls with the route's own code between them reads better and keeps each
// route's ordering visible where it matters.
//
// Neither function touches `streamText` or the stream writer.

export type ChatSurface = 'archive' | 'prep' | 'news' | 'scripts';

export type PreparedChatRequest = {
  messages: UIMessage[];
  chatId?: string;
  editingMessageId?: string;
};

export type PrepareOutcome =
  | { ok: true; prepared: PreparedChatRequest }
  | { ok: false; response: Response };

// First entry is the client; the rest of x-forwarded-for is the proxy chain.
function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

// CSRF: a browser always sends Origin on a cross-site POST. Absent Origin or
// Host means a non-browser client, which this check is not for. An Origin that
// doesn't parse is treated as cross-origin — fail closed.
function isCrossOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/**
 * Bootstrap tables, rate-limit, CSRF-check, parse and validate.
 *
 * Error bodies here are user-visible: `lib/chat-fetch.ts` turns a non-2xx into
 * `[<status> <statusText>] <body>` and `ChatErrorBanner` parses that back out,
 * showing the JSON `error` field. Don't change these shapes casually.
 */
export async function prepareChatRoute(
  req: Request,
  opts: {
    /** Rate-limit bucket prefix — one bucket per surface. */
    rateLimitKey: string;
    /** Route-specific DDL bootstrap, run before anything else. */
    ensureTables: () => Promise<unknown>;
  },
): Promise<PrepareOutcome> {
  await opts.ensureTables();

  const { ok } = await checkRateLimit(`${opts.rateLimitKey}:${clientIp(req)}`);
  if (!ok) {
    return { ok: false, response: new Response('Rate limit exceeded', { status: 429 }) };
  }

  if (isCrossOrigin(req)) {
    return { ok: false, response: new Response('Forbidden', { status: 403 }) };
  }

  let body: { messages?: unknown; chatId?: unknown; editingMessageId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return {
      ok: false,
      response: Response.json({ error: 'invalid_json' }, { status: 400 }),
    };
  }

  const validated = await safeValidateUIMessages<UIMessage>({ messages: body.messages });
  if (!validated.success) {
    return {
      ok: false,
      response: Response.json(
        { error: 'invalid_messages', detail: validated.error.message },
        { status: 400 },
      ),
    };
  }

  return {
    ok: true,
    prepared: {
      messages: validated.data,
      chatId: typeof body.chatId === 'string' ? body.chatId : undefined,
      editingMessageId:
        typeof body.editingMessageId === 'string' ? body.editingMessageId : undefined,
    },
  };
}

/**
 * Record the incoming turn: drop the tail being replaced when the user is
 * editing, then persist.
 *
 * Best-effort by design. A persistence failure must not fail the request — the
 * user still gets their answer, it just doesn't survive a reload — so both
 * steps swallow and log. No-ops without a chatId (an unsaved conversation).
 */
export async function persistTurn(opts: {
  chatId: string | undefined;
  editingMessageId?: string;
  surface: ChatSurface;
  messages: UIMessage[];
  /** Strip file payloads before they reach the database. */
  redactFiles?: boolean;
  /** Event-name prefix, e.g. "chat" -> "chat.persist_user_error". */
  logKey: string;
}): Promise<void> {
  const { chatId, editingMessageId, surface, messages, redactFiles, logKey } = opts;
  if (!chatId) return;

  if (editingMessageId) {
    try {
      await deleteMessageAndSubsequent(chatId, editingMessageId);
    } catch (err) {
      warnEvent(`${logKey}.delete_for_edit_error`, { err: errText(err) });
    }
  }

  try {
    await persistIncomingMessages({
      chatId,
      surface,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: (m.parts ?? []) as Array<{ type: string; [key: string]: unknown }>,
      })),
      redactFiles,
    });
  } catch (err) {
    warnEvent(`${logKey}.persist_user_error`, { err: errText(err) });
  }
}
