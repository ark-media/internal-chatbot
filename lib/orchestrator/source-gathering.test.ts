import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyOrRecover } from './source-gathering';

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
