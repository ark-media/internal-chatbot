// Behavioral tests for the /search route — the triage-stage keyword-search
// escape hatch. The Tavily-backed search, the freshness helper, persistence,
// and the rate limiter are mocked so the handler runs in isolation. The focus
// is stage gating, freshness flagging of the returned hits, and that a
// cancelled search unwinds with 499 rather than a 500.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Candidate, OrchestratorRun } from '@/lib/orchestrator/types';

const keywordSearch = vi.fn();
// inAcceptableRange is pure; this stand-in makes only the '2026-05-13' date
// "fresh" so the flagging assertion has something to bite on.
vi.mock('@/lib/orchestrator/source-gathering', () => ({
  keywordSearch: (...args: unknown[]) => keywordSearch(...args),
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
  const req = new Request('https://app.example.com/api/news/orchestrator/search', init);
  controller?.abort();
  return req;
}

describe('POST /api/news/orchestrator/search', () => {
  beforeEach(() => {
    loadRun.mockResolvedValue(makeRun());
    keywordSearch.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the search hits with freshness flagged against the run date', async () => {
    const hits: Candidate[] = [
      { title: 'Fresh', url: 'https://www.reuters.com/a', source: 'Reuters', publicationDate: '2026-05-13' },
      { title: 'Stale', url: 'https://www.reuters.com/b', source: 'Reuters', publicationDate: '2026-04-01' },
    ];
    keywordSearch.mockResolvedValue(hits);

    const res = await POST(makeRequest({ chatId: CHAT_ID, query: 'hezbollah ceasefire' }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hits.map((h: Candidate) => h.isFlagged)).toEqual([false, true]);
    expect(keywordSearch).toHaveBeenCalledTimes(1);
  });

  it('rejects a search against a run that is not in triage', async () => {
    loadRun.mockResolvedValue(makeRun({ stage: 'checkpoint' }));

    const res = await POST(makeRequest({ chatId: CHAT_ID, query: 'anything' }));

    expect(res.status).toBe(409);
    expect(keywordSearch).not.toHaveBeenCalled();
  });

  it('returns 404 when the run does not exist', async () => {
    loadRun.mockResolvedValue(null);

    const res = await POST(makeRequest({ chatId: CHAT_ID, query: 'anything' }));

    expect(res.status).toBe(404);
    expect(keywordSearch).not.toHaveBeenCalled();
  });

  it('surfaces a search failure as 500', async () => {
    keywordSearch.mockRejectedValue(new Error('Tavily search 500'));

    const res = await POST(makeRequest({ chatId: CHAT_ID, query: 'anything' }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'search_failed' });
  });

  it('returns 499 when the search is cancelled mid-flight', async () => {
    keywordSearch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const res = await POST(makeRequest({ chatId: CHAT_ID, query: 'anything' }, { aborted: true }));

    expect(res.status).toBe(499);
  });

  it('rejects a too-short query with 400', async () => {
    const res = await POST(makeRequest({ chatId: CHAT_ID, query: 'a' }));

    expect(res.status).toBe(400);
    expect(keywordSearch).not.toHaveBeenCalled();
  });
});
