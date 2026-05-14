// Behavioral tests for the /x-posts route — the triage-stage X/Twitter pull.
// The X API client, the freshness helper, persistence, and the rate limiter
// are mocked so the handler runs in isolation. The focus is the not-configured
// gate, stage gating, freshness flagging of the returned hits, and that a
// cancelled pull unwinds with 499 rather than a 500.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Candidate, OrchestratorRun } from '@/lib/orchestrator/types';

const discoverXPostsViaApi = vi.fn();
const isXApiConfigured = vi.fn();
vi.mock('@/lib/x-api', () => ({
  discoverXPostsViaApi: (...args: unknown[]) => discoverXPostsViaApi(...args),
  isXApiConfigured: () => isXApiConfigured(),
}));

// inAcceptableRange is pure; this stand-in makes only the '2026-05-13' date
// "fresh" so the flagging assertion has something to bite on.
vi.mock('@/lib/orchestrator/source-gathering', () => ({
  inAcceptableRange: (_today: string, date: string | null) => date === '2026-05-13',
}));

const ensureOrchestratorTables = vi.fn(async () => {});
const loadRun = vi.fn<(chatId: string) => Promise<OrchestratorRun | null>>();
vi.mock('@/lib/orchestrator/state', () => ({
  ensureOrchestratorTables: () => ensureOrchestratorTables(),
  loadRun: (chatId: string) => loadRun(chatId),
}));

const checkRateLimit = vi.fn(async () => ({ ok: true, remaining: 10 }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => checkRateLimit(),
}));

// Import AFTER the mocks are registered.
import { POST } from './route';

const CHAT_ID = 'chat-xyz';

function makeRun(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    chatId: CHAT_ID,
    stage: 'triage',
    today: '2026-05-14',
    timezone: 'America/New_York',
    candidates: [],
    articles: [],
    distill: null,
    approvedTopics: null,
    finalScript: null,
    scriptVersions: [],
    refineHistory: [],
    iterations: 0,
    errorMessage: null,
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(body: unknown, opts: { aborted?: boolean } = {}): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  let controller: AbortController | undefined;
  if (opts.aborted) {
    controller = new AbortController();
    init.signal = controller.signal;
  }
  const req = new Request('https://app.example.com/api/news/orchestrator/x-posts', init);
  controller?.abort();
  return req;
}

describe('POST /api/news/orchestrator/x-posts', () => {
  beforeEach(() => {
    isXApiConfigured.mockReturnValue(true);
    loadRun.mockResolvedValue(makeRun());
    discoverXPostsViaApi.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the X-post hits with freshness flagged against the run date', async () => {
    const hits: Candidate[] = [
      {
        title: 'Fresh post',
        url: 'https://x.com/BarakRavid/status/111',
        source: 'Barak Ravid',
        publicationDate: '2026-05-13',
      },
      {
        title: 'Stale post',
        url: 'https://x.com/AmitSegal/status/222',
        source: 'Amit Segal',
        publicationDate: '2026-04-01',
      },
    ];
    discoverXPostsViaApi.mockResolvedValue(hits);

    const res = await POST(makeRequest({ chatId: CHAT_ID }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hits.map((h: Candidate) => h.isFlagged)).toEqual([false, true]);
    expect(discoverXPostsViaApi).toHaveBeenCalledTimes(1);
  });

  it('returns 503 not_configured when the X API key is absent', async () => {
    isXApiConfigured.mockReturnValue(false);

    const res = await POST(makeRequest({ chatId: CHAT_ID }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_configured' });
    // The capability gate short-circuits before any run-specific work.
    expect(loadRun).not.toHaveBeenCalled();
    expect(discoverXPostsViaApi).not.toHaveBeenCalled();
  });

  it('rejects a pull against a run that is not in triage', async () => {
    loadRun.mockResolvedValue(makeRun({ stage: 'checkpoint' }));

    const res = await POST(makeRequest({ chatId: CHAT_ID }));

    expect(res.status).toBe(409);
    expect(discoverXPostsViaApi).not.toHaveBeenCalled();
  });

  it('returns 404 when the run does not exist', async () => {
    loadRun.mockResolvedValue(null);

    const res = await POST(makeRequest({ chatId: CHAT_ID }));

    expect(res.status).toBe(404);
    expect(discoverXPostsViaApi).not.toHaveBeenCalled();
  });

  it('surfaces a discovery failure as 500', async () => {
    discoverXPostsViaApi.mockRejectedValue(new Error('X API 401 on /2/users/by'));

    const res = await POST(makeRequest({ chatId: CHAT_ID }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'x_posts_failed' });
  });

  it('returns 499 when the pull is cancelled mid-flight', async () => {
    discoverXPostsViaApi.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const res = await POST(makeRequest({ chatId: CHAT_ID }, { aborted: true }));

    expect(res.status).toBe(499);
  });

  it('rejects a body with no chatId as 400', async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    expect(discoverXPostsViaApi).not.toHaveBeenCalled();
  });
});
