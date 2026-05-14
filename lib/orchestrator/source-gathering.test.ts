import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

import {
  discoverCandidates,
  discoverXPosts,
  keywordSearch,
  parseCandidates,
  verifyOrRecover,
} from './source-gathering';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('@ai-sdk/google', () => ({
  google: { tools: { googleSearch: () => ({}) } },
}));

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

  it("normalizes Tavily's RFC date string to YYYY-MM-DD", async () => {
    // The `news` topic returns published_date as an RFC-2822-ish string;
    // inAcceptableRange and the UI badge both need a plain calendar date.
    installFetchMock(() =>
      jsonResponse({
        results: [
          {
            url: 'https://www.timesofisrael.com/story',
            title: 'Dated story',
            source_name: 'Times of Israel',
            published_date: 'Wed, 13 May 2026 14:28:00 GMT',
          },
        ],
      }),
    );

    const hits = await keywordSearch('anything');
    expect(hits[0].publicationDate).toBe('2026-05-13');
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

describe('parseCandidates', () => {
  const one = {
    title: 'A story',
    url: 'https://www.timesofisrael.com/a-story/',
    publicationDate: '2026-05-14',
    source: 'Times of Israel',
  };

  it('parses a bare JSON array', () => {
    expect(parseCandidates(JSON.stringify([one]))).toEqual([one]);
  });

  it('parses an array wrapped in a markdown code fence', () => {
    const raw = '```json\n' + JSON.stringify([one], null, 2) + '\n```';
    expect(parseCandidates(raw)).toEqual([one]);
  });

  it('parses past leading prose before the array', () => {
    expect(parseCandidates(`Here are the articles:\n\n${JSON.stringify([one])}`)).toEqual([
      one,
    ]);
  });

  it('ignores trailing prose with bracket characters after the array', () => {
    // The old greedy /\[[\s\S]*\]/ over-captured this and JSON.parse threw,
    // collapsing the whole run to zero candidates.
    const raw = `${JSON.stringify([one])}\n\nSources: [1] timesofisrael.com, [2] jpost.com`;
    expect(parseCandidates(raw)).toEqual([one]);
  });

  it('handles bracket characters inside a title string', () => {
    const tricky = { ...one, title: 'Report [updated]: the story ]' };
    expect(parseCandidates(JSON.stringify([tricky]))[0].title).toBe(
      'Report [updated]: the story ]',
    );
  });

  it('drops Gemini grounding-redirect URLs', () => {
    const redirect = {
      ...one,
      url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123',
    };
    expect(parseCandidates(JSON.stringify([redirect, one]))).toEqual([one]);
  });

  it('returns [] when there is no array at all', () => {
    expect(parseCandidates('I could not find any articles today.')).toEqual([]);
  });

  it('returns [] when the array is malformed JSON', () => {
    expect(parseCandidates('[{ "title": "x", url: missing-quotes }]')).toEqual([]);
  });

  it('skips entries missing a url or title', () => {
    const raw = JSON.stringify([
      { title: 'no url' },
      { url: 'https://www.jpost.com/x' },
      one,
    ]);
    expect(parseCandidates(raw).map((c) => c.url)).toEqual([one.url]);
  });
});

describe('discoverCandidates', () => {
  beforeEach(() => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    // Silence the per-query diagnostic logging.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fans out the beat queries scoped to the freshness window and merges deduped hits', async () => {
    const seenQueries: string[] = [];
    let calls = 0;
    installFetchMock((url, init) => {
      expect(url).toBe('https://api.tavily.com/search');
      const body = JSON.parse(init?.body as string);
      seenQueries.push(body.query);
      // 2026-05-14 is a Thursday, so the window is [yesterday, today].
      expect(body.topic).toBe('news');
      expect(body.start_date).toBe('2026-05-13');
      expect(body.end_date).toBe('2026-05-14');
      calls += 1;
      // A per-query story plus one URL repeated across every query, to
      // exercise the cross-query dedupe in the merge.
      return jsonResponse({
        results: [
          {
            url: `https://www.timesofisrael.com/story-${calls}`,
            title: `Story ${calls}`,
            published_date: '2026-05-14',
            source_name: 'Times of Israel',
          },
          {
            url: 'https://www.reuters.com/shared',
            title: 'Shared story',
            published_date: '2026-05-14',
            source_name: 'Reuters',
          },
        ],
      });
    });

    const result = await discoverCandidates('2026-05-14', '');

    // All nine beat queries fanned out.
    expect(seenQueries).toHaveLength(9);
    const urls = result.map((c) => c.url);
    // The shared URL is merged down to one; each per-query story survives.
    expect(urls.filter((u) => u === 'https://www.reuters.com/shared')).toHaveLength(1);
    expect(urls).toHaveLength(10);
  });

  it('uses extraGuidance as a single query when provided', async () => {
    const seenQueries: string[] = [];
    installFetchMock((_url, init) => {
      seenQueries.push(JSON.parse(init?.body as string).query);
      return jsonResponse({ results: [] });
    });

    await discoverCandidates('2026-05-14', 'Lebanon ceasefire talks');

    expect(seenQueries).toEqual(['Lebanon ceasefire talks']);
  });

  it('tolerates a partial query failure and returns the hits that came back', async () => {
    let calls = 0;
    installFetchMock(() => {
      calls += 1;
      // The first query 500s; the rest succeed.
      if (calls === 1) return new Response('nope', { status: 500 });
      return jsonResponse({
        results: [
          {
            url: `https://www.jpost.com/story-${calls}`,
            title: `Story ${calls}`,
            published_date: '2026-05-14',
            source_name: 'Jerusalem Post',
          },
        ],
      });
    });

    const result = await discoverCandidates('2026-05-14', '');
    // Nine queries, one failed → eight hits.
    expect(result).toHaveLength(8);
  });

  it('throws when every query fails, so /start can report the real failure', async () => {
    installFetchMock(() => new Response('down', { status: 503 }));
    await expect(discoverCandidates('2026-05-14', '')).rejects.toThrow(/Tavily search 503/);
  });

  it('propagates a caller-initiated abort instead of swallowing it', async () => {
    const controller = new AbortController();
    controller.abort();
    installFetchMock(() => {
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(
      discoverCandidates('2026-05-14', '', controller.signal),
    ).rejects.toThrow();
  });
});

describe('discoverXPosts', () => {
  // A valid status URL from an approved handle (@BarakRavid is on the list).
  const validArray = JSON.stringify([
    {
      title: 'Barak Ravid reports on ceasefire talks',
      url: 'https://x.com/BarakRavid/status/1234567890',
      publicationDate: '2026-05-14',
      source: 'Barak Ravid',
    },
  ]);

  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    // Silence the per-attempt diagnostic logging.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed X-post candidates on the first successful attempt', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: validArray,
      finishReason: 'stop',
    } as never);

    const result = await discoverXPosts('2026-05-14');
    expect(result.map((c) => c.url)).toEqual([
      'https://x.com/BarakRavid/status/1234567890',
    ]);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('drops posts that are not canonical status URLs from approved handles', async () => {
    const mixed = JSON.stringify([
      {
        title: 'Approved handle, real post',
        url: 'https://x.com/BarakRavid/status/111',
        publicationDate: '2026-05-14',
        source: 'Barak Ravid',
      },
      {
        title: 'Unlisted handle',
        url: 'https://x.com/SomeRandom/status/222',
        publicationDate: '2026-05-14',
        source: 'Random',
      },
      {
        title: 'Bare profile, not a post',
        url: 'https://x.com/AmitSegal',
        publicationDate: null,
        source: 'Amit Segal',
      },
    ]);
    vi.mocked(generateText).mockResolvedValueOnce({
      text: mixed,
      finishReason: 'stop',
    } as never);

    const result = await discoverXPosts('2026-05-14');
    expect(result.map((c) => c.url)).toEqual(['https://x.com/BarakRavid/status/111']);
  });

  it('retries when an attempt yields no usable handle URLs', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: 'no json here', finishReason: 'stop' } as never)
      .mockResolvedValueOnce({ text: validArray, finishReason: 'stop' } as never);

    const result = await discoverXPosts('2026-05-14');
    expect(result).toHaveLength(1);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('returns [] when every attempt completes but yields nothing usable', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'nothing parseable here',
      finishReason: 'stop',
    } as never);

    const result = await discoverXPosts('2026-05-14');
    expect(result).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('throws when every attempt throws, so the route can report the real failure', async () => {
    vi.mocked(generateText).mockRejectedValue(
      new Error('GatewayTimeoutError: timed out'),
    );

    await expect(discoverXPosts('2026-05-14')).rejects.toThrow(/GatewayTimeoutError/);
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('does not retry past a caller-initiated abort', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.mocked(generateText).mockRejectedValue(
      new DOMException('Aborted', 'AbortError'),
    );

    await expect(discoverXPosts('2026-05-14', controller.signal)).rejects.toThrow();
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
