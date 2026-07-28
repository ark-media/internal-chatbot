// Contract tests for the preamble every chat-shaped route runs before it
// reaches the model: table bootstrap, rate limit, CSRF origin check, body
// parse, and message validation.
//
// These four routes had no tests at all. The assertions here are written
// against the behaviour as it shipped, so they guard the extraction of
// `prepareChatRoute` rather than describing it.
//
// Error *shapes* matter beyond the status code: `lib/chat-fetch.ts` turns a
// non-2xx into `[<status> <statusText>] <body>` and `ChatErrorBanner` parses
// that back apart, so the body is user-visible.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkRateLimit =
  vi.fn<(id: string) => Promise<{ ok: boolean; remaining: number }>>();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (id: string) => checkRateLimit(id),
}));

const persistIncomingMessages = vi.fn(async () => {});
const deleteMessageAndSubsequent = vi.fn(async () => {});
vi.mock('@/lib/chats', () => ({
  ensureChatTables: vi.fn(async () => {}),
  persistIncomingMessages: (...a: unknown[]) => persistIncomingMessages(...(a as [])),
  deleteMessageAndSubsequent: (...a: unknown[]) =>
    deleteMessageAndSubsequent(...(a as [])),
  persistAssistantMessage: vi.fn(async () => {}),
  loadChat: vi.fn(async () => null),
}));

vi.mock('@/lib/tool-cache', () => ({
  ensureTable: vi.fn(async () => {}),
  getCached: vi.fn(async () => null),
  setCached: vi.fn(async () => {}),
  cacheKey: (...a: unknown[]) => JSON.stringify(a),
}));

const loadRun = vi.fn<(id: string) => Promise<unknown>>();
vi.mock('@/lib/scriptwriter/state', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureScriptRunTables: vi.fn(async () => {}),
  loadRun: (id: string) => loadRun(id),
}));

// Keep `safeValidateUIMessages` real — it is the thing under test in the
// validation cases. Only the streaming entry points are stubbed.
vi.mock('ai', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamText: vi.fn(() => {
    throw new Error('streamText should not be reached by a preamble test');
  }),
}));

import { POST as chatPOST } from './chat/route';
import { POST as prepPOST } from './prep/route';
import { POST as newsPOST } from './news/route';
import { POST as scriptsPOST } from './news/orchestrator/chat/route';

type RouteCase = {
  name: string;
  post: (req: Request) => Promise<Response>;
  url: string;
  /** Prefix of the rate-limit bucket key. */
  rateKey: string;
};

const ROUTES: RouteCase[] = [
  { name: 'chat', post: chatPOST, url: 'https://app.test/api/chat', rateKey: 'chat' },
  { name: 'prep', post: prepPOST, url: 'https://app.test/api/prep', rateKey: 'prep' },
  { name: 'news', post: newsPOST, url: 'https://app.test/api/news', rateKey: 'news' },
  {
    name: 'scripts',
    post: scriptsPOST,
    url: 'https://app.test/api/news/orchestrator/chat',
    rateKey: 'scripts',
  },
];

function makeRequest(
  url: string,
  opts: {
    body?: unknown;
    rawBody?: string;
    origin?: string;
    host?: string;
    forwardedFor?: string;
    realIp?: string;
  } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.origin) headers.set('origin', opts.origin);
  if (opts.host) headers.set('host', opts.host);
  if (opts.forwardedFor) headers.set('x-forwarded-for', opts.forwardedFor);
  if (opts.realIp) headers.set('x-real-ip', opts.realIp);
  return new Request(url, {
    method: 'POST',
    headers,
    body: opts.rawBody ?? JSON.stringify(opts.body ?? {}),
  });
}

// A body that parses as JSON but is not a valid UIMessage list, so every route
// stops at message validation without reaching the model.
const INVALID_MESSAGES = { chatId: 'c1', messages: [{ nope: true }] };

// A valid list, for cases that need to get *past* validation. An empty array
// does not validate, so it can't stand in here.
const VALID_MESSAGES = [
  { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ ok: true, remaining: 10 });
  loadRun.mockResolvedValue(null);
});

describe.each(ROUTES)('$name route preamble', ({ post, url, rateKey }) => {
  it('returns 429 with a plain-text body when rate limited', async () => {
    checkRateLimit.mockResolvedValue({ ok: false, remaining: 0 });

    const res = await post(makeRequest(url, { body: INVALID_MESSAGES }));

    expect(res.status).toBe(429);
    expect(await res.text()).toBe('Rate limit exceeded');
  });

  it('buckets the rate limit by surface and client IP', async () => {
    await post(
      makeRequest(url, {
        body: INVALID_MESSAGES,
        forwardedFor: '203.0.113.7, 70.41.3.18',
      }),
    );

    // First entry of x-forwarded-for is the client; the rest are proxies.
    expect(checkRateLimit).toHaveBeenCalledWith(`${rateKey}:203.0.113.7`);
  });

  it('falls back to x-real-ip, then to "unknown"', async () => {
    await post(makeRequest(url, { body: INVALID_MESSAGES, realIp: '198.51.100.4' }));
    expect(checkRateLimit).toHaveBeenCalledWith(`${rateKey}:198.51.100.4`);

    checkRateLimit.mockClear();
    await post(makeRequest(url, { body: INVALID_MESSAGES }));
    expect(checkRateLimit).toHaveBeenCalledWith(`${rateKey}:unknown`);
  });

  it('rejects a cross-origin post with 403', async () => {
    const res = await post(
      makeRequest(url, {
        body: INVALID_MESSAGES,
        origin: 'https://evil.test',
        host: 'app.test',
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
  });

  it('rejects an unparseable origin with 403', async () => {
    const res = await post(
      makeRequest(url, {
        body: INVALID_MESSAGES,
        origin: 'not-a-url',
        host: 'app.test',
      }),
    );

    expect(res.status).toBe(403);
  });

  it('allows a same-origin post through the CSRF check', async () => {
    const res = await post(
      makeRequest(url, {
        body: INVALID_MESSAGES,
        origin: 'https://app.test',
        host: 'app.test',
      }),
    );

    // Reaches message validation instead of being turned away at 403.
    expect(res.status).toBe(400);
  });

  it('allows a post with no origin header (non-browser client)', async () => {
    const res = await post(makeRequest(url, { body: INVALID_MESSAGES, host: 'app.test' }));

    expect(res.status).toBe(400);
  });

  it('rejects malformed messages with a JSON 400 the banner can parse', async () => {
    const res = await post(makeRequest(url, { body: INVALID_MESSAGES }));

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(body.error).toBe('invalid_messages');
    // ChatErrorBanner surfaces `error`; `detail` is the diagnostic behind it.
    expect(typeof body.detail).toBe('string');
  });

  it('does not persist anything when the preamble rejects the request', async () => {
    checkRateLimit.mockResolvedValue({ ok: false, remaining: 0 });
    await post(makeRequest(url, { body: INVALID_MESSAGES }));

    expect(persistIncomingMessages).not.toHaveBeenCalled();
    expect(deleteMessageAndSubsequent).not.toHaveBeenCalled();
  });
});

// The scripts route requires a chat id because a turn is meaningless without a
// run to attach it to; the other three treat it as optional and skip
// persistence when it is absent.
describe('scripts route chat-id requirement', () => {
  it('rejects a missing chatId with 400 missing_chat_id', async () => {
    const res = await scriptsPOST(
      makeRequest('https://app.test/api/news/orchestrator/chat', {
        body: { messages: VALID_MESSAGES },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_chat_id' });
  });

  it('rejects an unknown run with 404 run_not_found', async () => {
    loadRun.mockResolvedValue(null);
    const res = await scriptsPOST(
      makeRequest('https://app.test/api/news/orchestrator/chat', {
        body: { chatId: 'nope', messages: VALID_MESSAGES },
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'run_not_found' });
  });
});
