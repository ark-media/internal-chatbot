// Tests for the X API client. ⚠ The client has not yet been exercised against
// a live key — these tests pin the deterministic logic (URL construction,
// date/title mapping, pagination, the partial-vs-total failure policy) against
// the documented X API v2 response shapes. If the live API disagrees with a
// fixture here, the fixture is what needs updating.
//
// `freshnessWindow` is mocked so this stays a true unit of `x-api.ts` — the
// window only feeds `start_time`, which the fetch fixtures ignore anyway. The
// real 15-handle list from `news-sources` is used as-is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./orchestrator/source-gathering', () => ({
  freshnessWindow: () => ['2026-05-14', '2026-05-13'],
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

// The client caches handle→id in module state, so each test re-imports it
// fresh against a clean cache.
async function loadXApi() {
  return import('./x-api');
}

// Stand-in for /2/users/by: one resolved user per requested username, id
// derived from the name so timeline routing downstream is predictable.
function usersByResponse(url: string): Response {
  const usernames = new URL(url).searchParams.get('usernames')!.split(',');
  return jsonResponse({
    data: usernames.map((username) => ({
      id: `id-${username}`,
      name: `${username} Display`,
      username,
    })),
  });
}

const TODAY = '2026-05-14';

describe('isXApiConfigured', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true when X_API_BEARER_TOKEN is set', async () => {
    vi.stubEnv('X_API_BEARER_TOKEN', 'token');
    const { isXApiConfigured } = await loadXApi();
    expect(isXApiConfigured()).toBe(true);
  });

  it('is false when X_API_BEARER_TOKEN is unset', async () => {
    vi.stubEnv('X_API_BEARER_TOKEN', '');
    const { isXApiConfigured } = await loadXApi();
    expect(isXApiConfigured()).toBe(false);
  });
});

describe('discoverXPostsViaApi', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('X_API_BEARER_TOKEN', 'test-token');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('throws when the X API is not configured', async () => {
    vi.stubEnv('X_API_BEARER_TOKEN', '');
    const { discoverXPostsViaApi } = await loadXApi();
    await expect(discoverXPostsViaApi(TODAY)).rejects.toThrow(/not configured/);
  });

  it("maps each handle's tweets to canonical-URL candidates", async () => {
    installFetchMock((url) => {
      const u = new URL(url);
      if (u.pathname === '/2/users/by') return usersByResponse(url);
      // /2/users/:id/tweets — one tweet per handle.
      const id = u.pathname.split('/')[3];
      return jsonResponse({
        data: [
          {
            id: `tweet-${id}`,
            text: 'A newsworthy post',
            created_at: '2026-05-14T09:30:00.000Z',
          },
        ],
        meta: { result_count: 1 },
      });
    });

    const { discoverXPostsViaApi } = await loadXApi();
    const hits = await discoverXPostsViaApi(TODAY);

    // news-sources has 15 approved handles → one tweet each.
    expect(hits).toHaveLength(15);
    const ravid = hits.find(
      (h) => h.url === 'https://x.com/BarakRavid/status/tweet-id-BarakRavid',
    );
    expect(ravid).toEqual({
      title: 'A newsworthy post',
      url: 'https://x.com/BarakRavid/status/tweet-id-BarakRavid',
      source: 'Barak Ravid',
      publicationDate: '2026-05-14',
    });
  });

  it('follows pagination until the next_token runs out', async () => {
    installFetchMock((url) => {
      const u = new URL(url);
      if (u.pathname === '/2/users/by') return usersByResponse(url);
      const id = u.pathname.split('/')[3];
      const token = u.searchParams.get('pagination_token');
      if (!token) {
        return jsonResponse({
          data: [{ id: `t1-${id}`, text: 'page one', created_at: '2026-05-14T08:00:00.000Z' }],
          meta: { result_count: 1, next_token: 'pg2' },
        });
      }
      return jsonResponse({
        data: [{ id: `t2-${id}`, text: 'page two', created_at: '2026-05-13T08:00:00.000Z' }],
        meta: { result_count: 1 },
      });
    });

    const { discoverXPostsViaApi } = await loadXApi();
    const hits = await discoverXPostsViaApi(TODAY);

    // 15 handles × 2 pages.
    expect(hits).toHaveLength(30);
    expect(hits.some((h) => h.url.endsWith('/status/t1-id-BarakRavid'))).toBe(true);
    expect(hits.some((h) => h.url.endsWith('/status/t2-id-BarakRavid'))).toBe(true);
  });

  it('tolerates a partial failure and returns the handles that came back', async () => {
    installFetchMock((url) => {
      const u = new URL(url);
      if (u.pathname === '/2/users/by') return usersByResponse(url);
      const id = u.pathname.split('/')[3];
      if (id === 'id-AmitSegal') return new Response('nope', { status: 500 });
      return jsonResponse({
        data: [{ id: `tweet-${id}`, text: 'a post', created_at: '2026-05-14T09:00:00.000Z' }],
        meta: { result_count: 1 },
      });
    });

    const { discoverXPostsViaApi } = await loadXApi();
    const hits = await discoverXPostsViaApi(TODAY);

    // 15 handles, one timeline failed → 14 hits, none from @AmitSegal.
    expect(hits).toHaveLength(14);
    expect(hits.some((h) => h.url.startsWith('https://x.com/AmitSegal/'))).toBe(false);
  });

  it('throws when every handle timeline fails', async () => {
    installFetchMock((url) => {
      if (new URL(url).pathname === '/2/users/by') return usersByResponse(url);
      return new Response('down', { status: 503 });
    });

    const { discoverXPostsViaApi } = await loadXApi();
    await expect(discoverXPostsViaApi(TODAY)).rejects.toThrow(/X API 503/);
  });

  it('throws when handle resolution fails', async () => {
    installFetchMock((url) => {
      if (new URL(url).pathname === '/2/users/by') {
        return new Response('bad token', { status: 401 });
      }
      throw new Error('timeline should not be reached');
    });

    const { discoverXPostsViaApi } = await loadXApi();
    await expect(discoverXPostsViaApi(TODAY)).rejects.toThrow(/X API 401/);
  });

  it('propagates a caller-initiated abort', async () => {
    installFetchMock((_url, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return jsonResponse({ data: [] });
    });
    const controller = new AbortController();
    controller.abort();

    const { discoverXPostsViaApi } = await loadXApi();
    await expect(discoverXPostsViaApi(TODAY, controller.signal)).rejects.toThrow();
  });

  it('collapses whitespace and truncates long tweet text into the title', async () => {
    const longText = 'x'.repeat(200);
    installFetchMock((url) => {
      const u = new URL(url);
      if (u.pathname === '/2/users/by') return usersByResponse(url);
      const id = u.pathname.split('/')[3];
      const text = id === 'id-BarakRavid' ? longText : 'line one\n\n  line   two';
      return jsonResponse({
        data: [{ id: `tweet-${id}`, text, created_at: '2026-05-14T09:00:00.000Z' }],
        meta: { result_count: 1 },
      });
    });

    const { discoverXPostsViaApi } = await loadXApi();
    const hits = await discoverXPostsViaApi(TODAY);

    const ravid = hits.find((h) => h.url.includes('/BarakRavid/'))!;
    expect(ravid.title).toHaveLength(140);
    expect(ravid.title.endsWith('…')).toBe(true);

    const other = hits.find((h) => !h.url.includes('/BarakRavid/'))!;
    expect(other.title).toBe('line one line two');
  });
});
