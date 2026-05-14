import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keywordSearch, verifyOrRecover } from './source-gathering';

type FetchMock = ReturnType<typeof vi.fn>;

const candidate = {
  title: 'China Looks to Ease Iran Into Resolution of War with U.S.',
  url: 'https://www.fdd.org/analysis/2026/05/07/china-looks-to-ease-iran-into-resolution-of-war-with-us/',
  publicationDate: '2026-05-07',
  source: 'fdd.org',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchMock {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('verifyOrRecover', () => {
  beforeEach(() => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    // Silence the warn lines emitted by the recovery path.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes a 200 OK candidate through unchanged without calling Tavily', async () => {
    const fetchMock = installFetchMock((url, init) => {
      expect(init?.method).toBe('HEAD');
      expect(url).toBe(candidate.url);
      return new Response(null, { status: 200 });
    });

    const result = await verifyOrRecover(candidate);
    expect(result).toEqual(candidate);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a 404 candidate via Tavily Search when the title matches', async () => {
    const goodUrl =
      'https://www.fdd.org/analysis/2026/05/06/china-looks-to-ease-iran-into-resolution-of-war-with-u-s/';
    const fetchMock = installFetchMock((url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      // Tavily search call
      expect(url).toBe('https://api.tavily.com/search');
      const body = JSON.parse(init?.body as string);
      expect(body.include_domains).toEqual(['www.fdd.org']);
      expect(body.query).toBe(candidate.title);
      return jsonResponse({
        results: [
          {
            url: goodUrl,
            title: 'China Looks to Ease Iran Into Resolution of War with U.S.',
          },
        ],
      });
    });

    const result = await verifyOrRecover(candidate);
    expect(result).not.toBeNull();
    expect(result!.url).toBe(goodUrl);
    expect(result!.title).toBe(candidate.title);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops a 404 candidate when Tavily Search returns no results', async () => {
    installFetchMock((_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return jsonResponse({ results: [] });
    });

    const result = await verifyOrRecover(candidate);
    expect(result).toBeNull();
  });

  it('drops a 404 candidate when Tavily Search returns the same broken URL', async () => {
    installFetchMock((_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return jsonResponse({
        results: [{ url: candidate.url, title: candidate.title }],
      });
    });

    const result = await verifyOrRecover(candidate);
    expect(result).toBeNull();
  });

  it('drops a 404 candidate when the recovered article has a divergent title', async () => {
    installFetchMock((_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return jsonResponse({
        results: [
          {
            url: 'https://www.fdd.org/analysis/2026/04/15/iranian-drones-strike-saudi-arabia/',
            title: 'Iranian Drone Strikes Hit Saudi Arabia',
          },
        ],
      });
    });

    const result = await verifyOrRecover(candidate);
    expect(result).toBeNull();
  });

  it('passes through transient HEAD failures (network error / 5xx) so extract can retry', async () => {
    installFetchMock((_url, init) => {
      if (init?.method === 'HEAD') throw new TypeError('network');
      throw new Error('Tavily search should not be called');
    });

    const result = await verifyOrRecover(candidate);
    expect(result).toEqual(candidate);
  });
});

describe('verifyOrRecover — cancellation', () => {
  beforeEach(() => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects instead of swallowing when the caller signal is aborted', async () => {
    installFetchMock((_url, init) => {
      // Real fetch rejects on an aborted signal — mirror that so the
      // signal-aware catch in headStatus has something to observe.
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response(null, { status: 200 });
    });

    const controller = new AbortController();
    controller.abort();

    await expect(verifyOrRecover(candidate, controller.signal)).rejects.toThrow();
  });

  it('still swallows the internal 5s verify timeout (not a caller abort)', async () => {
    // The verify timeout aborts with a TimeoutError, distinct from the
    // caller's signal — headStatus should treat it as a dead URL (status 0)
    // and pass the candidate through for extract to retry, not propagate.
    installFetchMock((_url, init) => {
      if (init?.method === 'HEAD') throw new DOMException('Timed out', 'TimeoutError');
      throw new Error('Tavily search should not be called');
    });

    const controller = new AbortController();
    const result = await verifyOrRecover(candidate, controller.signal);
    expect(result).toEqual(candidate);
  });
});

describe('keywordSearch', () => {
  beforeEach(() => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('scopes the Tavily query to the approved hostnames', async () => {
    const fetchMock = installFetchMock((url, init) => {
      expect(url).toBe('https://api.tavily.com/search');
      const body = JSON.parse(init?.body as string);
      expect(Array.isArray(body.include_domains)).toBe(true);
      expect(body.include_domains).toContain('reuters.com');
      expect(body.query).toBe('hezbollah ceasefire');
      return jsonResponse({ results: [] });
    });

    const hits = await keywordSearch('hezbollah ceasefire');
    expect(hits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps results to hits and carries through the publication date', async () => {
    installFetchMock(() =>
      jsonResponse({
        results: [
          {
            url: 'https://www.reuters.com/world/middle-east/story',
            title: 'A Reuters story',
            source_name: 'Reuters',
            published_date: '2026-05-13',
          },
        ],
      }),
    );

    const hits = await keywordSearch('anything');
    expect(hits).toEqual([
      {
        title: 'A Reuters story',
        url: 'https://www.reuters.com/world/middle-east/story',
        source: 'Reuters',
        publicationDate: '2026-05-13',
      },
    ]);
  });

  it('drops results from non-approved domains and dedupes by URL', async () => {
    installFetchMock(() =>
      jsonResponse({
        results: [
          { url: 'https://www.bbc.com/news/story', title: 'Not approved' },
          { url: 'https://www.timesofisrael.com/story', title: 'Approved' },
          { url: 'https://www.timesofisrael.com/story', title: 'Approved duplicate' },
        ],
      }),
    );

    const hits = await keywordSearch('anything');
    expect(hits.map((h) => h.url)).toEqual(['https://www.timesofisrael.com/story']);
    expect(hits[0].publicationDate).toBeNull();
  });

  it('skips malformed results missing a url or title', async () => {
    installFetchMock(() =>
      jsonResponse({
        results: [
          { title: 'No url' },
          { url: 'https://www.jpost.com/story' },
          { url: 'https://www.jpost.com/good', title: 'Good' },
        ],
      }),
    );

    const hits = await keywordSearch('anything');
    expect(hits.map((h) => h.url)).toEqual(['https://www.jpost.com/good']);
  });

  it('throws when TAVILY_API_KEY is missing', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    await expect(keywordSearch('anything')).rejects.toThrow(/TAVILY_API_KEY/);
  });

  it('throws when Tavily returns a non-OK response', async () => {
    installFetchMock(() => new Response('nope', { status: 500 }));
    await expect(keywordSearch('anything')).rejects.toThrow(/Tavily search 500/);
  });
});
