// Behavioral tests for the /group route — the triage ↔ checkpoint boundary.
// Extraction, distillation, the example-script fetch, persistence, and the
// rate limiter are all mocked so the handler runs in isolation. The focus is
// stage gating, the extraction-failure path, and cancellation: a writer who
// walks away mid-group must not get a committed run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Article, DistillResult, OrchestratorRun } from '@/lib/orchestrator/types';

const extractCandidates = vi.fn();
vi.mock('@/lib/orchestrator/source-gathering', () => ({
  extractCandidates: (...args: unknown[]) => extractCandidates(...args),
}));

const distillTopics = vi.fn();
vi.mock('@/lib/orchestrator/distill', () => ({
  distillTopics: (...args: unknown[]) => distillTopics(...args),
}));

vi.mock('@/lib/news-prompt', () => ({
  getNewsExamples: vi.fn(async () => 'example scripts'),
}));

const ensureOrchestratorTables = vi.fn(async () => {});
const loadRun = vi.fn<(chatId: string) => Promise<OrchestratorRun | null>>();
const saveRunIfStage =
  vi.fn<(run: OrchestratorRun, stages: string[]) => Promise<boolean>>();
vi.mock('@/lib/orchestrator/state', () => ({
  ensureOrchestratorTables: () => ensureOrchestratorTables(),
  loadRun: (chatId: string) => loadRun(chatId),
  saveRunIfStage: (...args: unknown[]) =>
    saveRunIfStage(...(args as [OrchestratorRun, string[]])),
}));

const checkRateLimit = vi.fn(async () => ({ ok: true, remaining: 10 }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => checkRateLimit(),
}));

// Import AFTER the mocks are registered.
import { POST } from './route';

const CHAT_ID = 'chat-xyz';

const ARTICLE: Article = {
  title: 'Extracted story',
  url: 'https://www.reuters.com/world/middle-east/story',
  publicationDate: '2026-05-13',
  source: 'Reuters',
  content: 'body text',
};

const DISTILL: DistillResult = {
  topics: [{ topic: 'A topic', description: 'desc', articles: [] }],
  rationale: 'because',
};

function makeRun(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    chatId: CHAT_ID,
    stage: 'triage',
    today: '2026-05-14',
    timezone: 'America/New_York',
    candidates: [
      { title: 'A candidate', url: ARTICLE.url, source: 'Reuters', publicationDate: '2026-05-13' },
    ],
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
  const req = new Request('https://app.example.com/api/news/orchestrator/group', init);
  controller?.abort();
  return req;
}

function savedRun(): OrchestratorRun {
  return saveRunIfStage.mock.calls.at(-1)![0] as OrchestratorRun;
}

describe('POST /api/news/orchestrator/group — mode: group', () => {
  beforeEach(() => {
    loadRun.mockResolvedValue(makeRun());
    saveRunIfStage.mockResolvedValue(true);
    extractCandidates.mockResolvedValue([ARTICLE]);
    distillTopics.mockResolvedValue(DISTILL);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extracts, distills, and advances triage → checkpoint', async () => {
    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ stage: 'checkpoint' });
    expect(saveRunIfStage).toHaveBeenCalledTimes(1);
    expect(savedRun().stage).toBe('checkpoint');
    expect(savedRun().articles).toEqual([ARTICLE]);
    expect(savedRun().distill).toEqual(DISTILL);
  });

  it('defaults mode to group when omitted', async () => {
    const res = await POST(makeRequest({ chatId: CHAT_ID }));

    expect(res.status).toBe(200);
    expect(distillTopics).toHaveBeenCalledTimes(1);
  });

  it('rejects a run that is not in triage', async () => {
    loadRun.mockResolvedValue(makeRun({ stage: 'checkpoint' }));

    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }));

    expect(res.status).toBe(409);
    expect(extractCandidates).not.toHaveBeenCalled();
    expect(saveRunIfStage).not.toHaveBeenCalled();
  });

  it('rejects a run with an empty candidate pool', async () => {
    loadRun.mockResolvedValue(makeRun({ candidates: [] }));

    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'no_articles' });
    expect(extractCandidates).not.toHaveBeenCalled();
  });

  it('returns 502 and does not distill when every candidate fails extraction', async () => {
    extractCandidates.mockResolvedValue([]);

    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: 'extraction_failed' });
    expect(distillTopics).not.toHaveBeenCalled();
    expect(saveRunIfStage).not.toHaveBeenCalled();
  });

  it('returns 499 and does not commit when distill throws on a cancelled request', async () => {
    distillTopics.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }, { aborted: true }));

    expect(res.status).toBe(499);
    expect(saveRunIfStage).not.toHaveBeenCalled();
  });

  it('does not commit when the abort lands after distill resolves (pre-commit race)', async () => {
    // distill finished cleanly, but the request was cancelled in the window
    // before the CAS write — the commit guard must still bail.
    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }, { aborted: true }));

    expect(res.status).toBe(499);
    expect(saveRunIfStage).not.toHaveBeenCalled();
  });

  it('returns 409 when the CAS write loses to a concurrent group', async () => {
    saveRunIfStage.mockResolvedValue(false);

    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }));

    expect(res.status).toBe(409);
  });

  it('surfaces a non-abort distill failure as 500 and leaves the run in triage', async () => {
    distillTopics.mockRejectedValue(new Error('distill exploded'));

    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'group' }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'group_failed' });
    expect(saveRunIfStage).not.toHaveBeenCalled();
  });
});

describe('POST /api/news/orchestrator/group — mode: regroup', () => {
  beforeEach(() => {
    loadRun.mockResolvedValue(
      makeRun({ stage: 'checkpoint', articles: [ARTICLE], distill: DISTILL }),
    );
    saveRunIfStage.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('drops the distill and article pool and moves checkpoint → triage', async () => {
    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'regroup' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ stage: 'triage' });
    expect(savedRun().stage).toBe('triage');
    expect(savedRun().articles).toEqual([]);
    expect(savedRun().distill).toBeNull();
    // The candidate list is what the writer re-triages — it must survive.
    expect(savedRun().candidates).toHaveLength(1);
    expect(extractCandidates).not.toHaveBeenCalled();
    expect(distillTopics).not.toHaveBeenCalled();
  });

  it('rejects a regroup against a run that is not in checkpoint', async () => {
    loadRun.mockResolvedValue(makeRun({ stage: 'triage' }));

    const res = await POST(makeRequest({ chatId: CHAT_ID, mode: 'regroup' }));

    expect(res.status).toBe(409);
    expect(saveRunIfStage).not.toHaveBeenCalled();
  });
});
