// Behavioral tests for the /topics route's cancellation path. We mock source
// gathering, persistence, and the rate limiter so the handler runs in
// isolation — the assertions focus on what happens when the writer cancels a
// slow gather: the run must not be committed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorRun } from '@/lib/orchestrator/types';

const gatherSources = vi.fn();
vi.mock('@/lib/orchestrator/source-gathering', () => ({
  gatherSources: (...args: unknown[]) => gatherSources(...args),
}));

const ensureOrchestratorTables = vi.fn(async () => {});
const loadRun = vi.fn<(chatId: string) => Promise<OrchestratorRun | null>>();
const saveRunIfUnchanged = vi.fn<() => Promise<boolean>>();
vi.mock('@/lib/orchestrator/state', () => ({
  ensureOrchestratorTables: () => ensureOrchestratorTables(),
  loadRun: (chatId: string) => loadRun(chatId),
  saveRunIfUnchanged: (...args: unknown[]) => saveRunIfUnchanged(...(args as [])),
}));

const checkRateLimit = vi.fn(async () => ({ ok: true, remaining: 10 }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => checkRateLimit(),
}));

// Import AFTER the mocks are registered.
import { POST } from './route';

const CHAT_ID = 'chat-xyz';

function makeRun(): OrchestratorRun {
  return {
    chatId: CHAT_ID,
    stage: 'checkpoint',
    today: '2026-05-14',
    timezone: 'America/New_York',
    articles: [],
    distill: {
      topics: [{ topic: 'Existing topic', description: 'desc', articles: [] }],
      rationale: 'because',
    },
    approvedTopics: null,
    finalScript: null,
    scriptVersions: [],
    refineHistory: [],
    iterations: 0,
    errorMessage: null,
    updatedAt: '2026-05-14T00:00:00.000Z',
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
  const req = new Request('https://app.example.com/api/news/orchestrator/topics', init);
  controller?.abort();
  return req;
}

describe('POST /api/news/orchestrator/topics — gather cancellation', () => {
  beforeEach(() => {
    loadRun.mockResolvedValue(makeRun());
    saveRunIfUnchanged.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('commits a gather that runs to completion', async () => {
    gatherSources.mockResolvedValue([]);

    const res = await POST(makeRequest({ chatId: CHAT_ID, action: 'gather', topicIndex: 0 }));

    expect(res.status).toBe(200);
    expect(saveRunIfUnchanged).toHaveBeenCalledTimes(1);
  });

  it('returns 499 and does not commit when gather throws on a cancelled request', async () => {
    // The writer aborted — gatherSources observed the signal and threw.
    gatherSources.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const res = await POST(
      makeRequest({ chatId: CHAT_ID, action: 'gather', topicIndex: 0 }, { aborted: true }),
    );

    expect(res.status).toBe(499);
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });

  it('does not commit when the abort lands after gather resolves (pre-commit race)', async () => {
    // gatherSources finished cleanly, but the request was cancelled in the
    // window before commit — the commit guard must still bail.
    gatherSources.mockResolvedValue([]);

    const res = await POST(
      makeRequest({ chatId: CHAT_ID, action: 'gather', topicIndex: 0 }, { aborted: true }),
    );

    expect(res.status).toBe(499);
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });

  it('returns 499 and does not commit when an auto-gather add is cancelled', async () => {
    gatherSources.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const res = await POST(
      makeRequest(
        { chatId: CHAT_ID, action: 'add', topic: 'New', description: 'd', autoGather: true },
        { aborted: true },
      ),
    );

    expect(res.status).toBe(499);
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });

  it('still re-throws non-abort gather failures', async () => {
    gatherSources.mockRejectedValue(new Error('discovery exploded'));

    await expect(
      POST(makeRequest({ chatId: CHAT_ID, action: 'gather', topicIndex: 0 })),
    ).rejects.toThrow('discovery exploded');
    expect(saveRunIfUnchanged).not.toHaveBeenCalled();
  });
});
