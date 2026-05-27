// Behavioral tests for the /triage route. Persistence, the rate limiter, and
// the (pure) freshness helper are mocked so the handler runs in isolation;
// `isApprovedSource` and `reorderByUrl` run for real since they're pure and
// the approval guard is one of the things under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Candidate, OrchestratorRun } from '@/lib/orchestrator/types';

// inAcceptableRange is pure but lives in source-gathering, which transitively
// pulls in heavier deps — stub it so the import stays cheap.
vi.mock('@/lib/orchestrator/source-gathering', () => ({
  inAcceptableRange: () => true,
}));

const ensureOrchestratorTables = vi.fn(async () => {});
const loadRun = vi.fn<(chatId: string) => Promise<OrchestratorRun | null>>();
const saveRunIfUnchanged =
  vi.fn<(run: OrchestratorRun, expectedUpdatedAt: string) => Promise<boolean>>();
vi.mock('@/lib/orchestrator/state', () => ({
  ensureOrchestratorTables: () => ensureOrchestratorTables(),
  loadRun: (chatId: string) => loadRun(chatId),
  saveRunIfUnchanged: (...args: unknown[]) =>
    saveRunIfUnchanged(...(args as [OrchestratorRun, string])),
}));

const checkRateLimit = vi.fn(async () => ({ ok: true, remaining: 10 }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => checkRateLimit(),
}));

// Import AFTER the mocks are registered.
import { POST } from './route';

const CHAT_ID = 'chat-xyz';
const APPROVED_URL = 'https://www.reuters.com/world/middle-east/story';
const APPROVED_URL_2 = 'https://www.timesofisrael.com/another-story';
const UNAPPROVED_URL = 'https://www.bbc.com/news/story';

function candidate(url: string): Candidate {
  return { title: `title ${url}`, url, source: 'example', publicationDate: null };
}

function makeRun(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    chatId: CHAT_ID,
    stage: 'triage',
    today: '2026-05-14',
    timezone: 'America/New_York',
    candidates: [candidate(APPROVED_URL), candidate(APPROVED_URL_2)],
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

function makeRequest(body: unknown): Request {
  return new Request('https://app.example.com/api/news/orchestrator/triage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The OrchestratorRun the handler tried to persist (first arg of the last
// saveRunIfUnchanged call).
function savedRun(): OrchestratorRun {
  return saveRunIfUnchanged.mock.calls.at(-1)![0] as OrchestratorRun;
}

describe('POST /api/news/orchestrator/triage', () => {
  beforeEach(() => {
    loadRun.mockResolvedValue(makeRun());
    saveRunIfUnchanged.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reorder — persists the candidate list in the requested URL order', async () => {
    const res = await POST(
      makeRequest({ action: 'reorder', chatId: CHAT_ID, order: [APPROVED_URL_2, APPROVED_URL] }),
    );

    expect(res.status).toBe(200);
    expect(savedRun().candidates.map((c) => c.url)).toEqual([APPROVED_URL_2, APPROVED_URL]);
  });

  it('remove — drops the candidate with the given URL', async () => {
    const res = await POST(
      makeRequest({ action: 'remove', chatId: CHAT_ID, url: APPROVED_URL }),
    );

    expect(res.status).toBe(200);
    expect(savedRun().candidates.map((c) => c.url)).toEqual([APPROVED_URL_2]);
  });

  it('add — appends an approved candidate to the pool', async () => {
    const newUrl = 'https://www.jpost.com/breaking-news/article';
    const res = await POST(
      makeRequest({
        action: 'add',
        chatId: CHAT_ID,
        candidate: { title: 'New', url: newUrl, source: 'JPost', publicationDate: '2026-05-13' },
      }),
    );

    expect(res.status).toBe(200);
    expect(savedRun().candidates.map((c) => c.url)).toContain(newUrl);
  });

  it('add — rejects a URL from a non-approved outlet with 422 and does not persist', async () => {
    const res = await POST(
      makeRequest({
        action: 'add',
        chatId: CHAT_ID,
        candidate: { title: 'Nope', url: UNAPPROVED_URL, source: 'BBC', publicationDate: null },
      }),
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_approved' });
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });

  it('add — promotes a candidate from extraCandidates and drops it from the overflow list', async () => {
    const extraUrl = 'https://www.jpost.com/extra-story';
    loadRun.mockResolvedValue(
      makeRun({
        extraCandidates: [candidate(extraUrl), candidate('https://www.reuters.com/other-extra')],
      }),
    );
    const res = await POST(
      makeRequest({
        action: 'add',
        chatId: CHAT_ID,
        candidate: { title: 'Extra', url: extraUrl, source: 'JPost', publicationDate: null },
      }),
    );

    expect(res.status).toBe(200);
    expect(savedRun().candidates.map((c) => c.url)).toContain(extraUrl);
    expect(savedRun().extraCandidates?.map((c) => c.url)).toEqual([
      'https://www.reuters.com/other-extra',
    ]);
  });

  it('add — short-circuits a duplicate URL without persisting', async () => {
    const res = await POST(
      makeRequest({
        action: 'add',
        chatId: CHAT_ID,
        candidate: { title: 'Dup', url: APPROVED_URL, source: 'Reuters', publicationDate: null },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ note: 'already_added' });
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });

  it('rejects an action against a run that is no longer in triage', async () => {
    loadRun.mockResolvedValue(makeRun({ stage: 'checkpoint' }));

    const res = await POST(
      makeRequest({ action: 'remove', chatId: CHAT_ID, url: APPROVED_URL }),
    );

    expect(res.status).toBe(409);
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });

  it('returns 404 when the run does not exist', async () => {
    loadRun.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ action: 'remove', chatId: CHAT_ID, url: APPROVED_URL }),
    );

    expect(res.status).toBe(404);
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });

  it('returns 409 when the optimistic-lock write loses the race', async () => {
    saveRunIfUnchanged.mockResolvedValue(false);

    const res = await POST(
      makeRequest({ action: 'remove', chatId: CHAT_ID, url: APPROVED_URL }),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'stale_state' });
  });

  it('rejects a malformed body with 400', async () => {
    const res = await POST(makeRequest({ action: 'reorder', chatId: CHAT_ID, order: [] }));

    expect(res.status).toBe(400);
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });
});
