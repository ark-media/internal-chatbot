// Behavioral tests for the conversation summary route. We mock the AI SDK,
// persistence, and rate limiter so the handler runs in isolation and the
// assertions focus on routing/validation behavior, not LLM output.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatRecord } from '@/lib/chats';

const ensureChatTables = vi.fn(async () => {});
const loadChat = vi.fn<(id: string) => Promise<ChatRecord | null>>();
vi.mock('@/lib/chats', () => ({
  ensureChatTables: () => ensureChatTables(),
  loadChat: (id: string) => loadChat(id),
}));

const checkRateLimit = vi.fn<
  (id: string) => Promise<{ ok: boolean; remaining: number }>
>();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (id: string) => checkRateLimit(id),
}));

vi.mock('@/lib/strip-tool-outputs', () => ({
  stripStaleToolOutputs: (messages: unknown[]) => messages,
}));

const streamText = vi.fn();
vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamText(...args),
  convertToModelMessages: (messages: unknown[]) => messages,
}));

// Import AFTER the mocks are registered.
import { POST } from './route';

const CHAT_ID = 'chat-abc';

function makeRequest(init: { origin?: string; host?: string } = {}): Request {
  const headers = new Headers();
  if (init.origin) headers.set('origin', init.origin);
  if (init.host) headers.set('host', init.host);
  return new Request('https://app.example.com/api/chats/chat-abc/summary', {
    method: 'POST',
    headers,
  });
}

function params() {
  return { params: Promise.resolve({ id: CHAT_ID }) };
}

function chatWithAssistant(): ChatRecord {
  return {
    id: CHAT_ID,
    surface: 'archive',
    title: null,
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hello [id:42]' }],
      },
    ],
  };
}

beforeEach(() => {
  ensureChatTables.mockClear();
  loadChat.mockReset();
  checkRateLimit.mockReset();
  streamText.mockReset();
  checkRateLimit.mockResolvedValue({ ok: true, remaining: 10 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/chats/[id]/summary', () => {
  it('returns 429 when rate-limited', async () => {
    checkRateLimit.mockResolvedValue({ ok: false, remaining: 0 });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toMatch(/rate limit/i);
    expect(loadChat).not.toHaveBeenCalled();
  });

  it('returns 403 when origin and host disagree', async () => {
    const res = await POST(
      makeRequest({ origin: 'https://evil.example.com', host: 'app.example.com' }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
    expect(loadChat).not.toHaveBeenCalled();
  });

  it('allows same-origin requests through', async () => {
    loadChat.mockResolvedValue(chatWithAssistant());
    streamText.mockReturnValue({
      toTextStreamResponse: () => new Response('summary text'),
    });

    const res = await POST(
      makeRequest({ origin: 'https://app.example.com', host: 'app.example.com' }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(streamText).toHaveBeenCalledOnce();
  });

  it('returns 404 when the chat does not exist', async () => {
    loadChat.mockResolvedValue(null);

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not found/i);
    expect(streamText).not.toHaveBeenCalled();
  });

  it('returns 400 when there is no assistant reply yet', async () => {
    loadChat.mockResolvedValue({
      id: CHAT_ID,
      surface: 'archive',
      title: null,
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      ],
    });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/assistant reply/i);
    expect(streamText).not.toHaveBeenCalled();
  });

  it('streams a summary when the chat has at least one assistant turn', async () => {
    loadChat.mockResolvedValue(chatWithAssistant());
    streamText.mockReturnValue({
      toTextStreamResponse: () => new Response('summary text'),
    });

    const res = await POST(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('summary text');
    expect(ensureChatTables).toHaveBeenCalledOnce();

    expect(streamText).toHaveBeenCalledOnce();
    const args = streamText.mock.calls[0][0] as {
      model: string;
      system: string;
      temperature: number;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(args.model).toBe('anthropic/claude-sonnet-4-6');
    expect(args.system).toMatch(/preserve every \[id:N\]/i);
    expect(args.temperature).toBeLessThanOrEqual(0.3);
    // Final turn must be a user message — Anthropic rejects assistant prefill,
    // so the route appends a synthetic user instruction after the history.
    const last = args.messages[args.messages.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toMatch(/structured summary/i);
  });

  it('strips UI-only data-* parts before sending history to the model', async () => {
    loadChat.mockResolvedValue({
      id: CHAT_ID,
      surface: 'archive',
      title: null,
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        {
          id: 'm2',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'hello' },
            { type: 'data-sources', data: { chunks: [] } },
          ],
        },
      ],
    });
    streamText.mockReturnValue({
      toTextStreamResponse: () => new Response('ok'),
    });

    await POST(makeRequest(), params());

    const args = streamText.mock.calls[0][0] as {
      messages: Array<{ parts: Array<{ type: string }> }>;
    };
    const assistant = args.messages[1];
    expect(assistant.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
