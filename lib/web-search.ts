export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
};

export type WebSearchResponse =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; reason: 'not_configured' | 'error'; note: string };

// Tavily Search — simple REST, free tier covers internal-tool usage.
// https://docs.tavily.com/docs/rest-api/api-reference
export async function webSearch(
  query: string,
  opts: { maxResults?: number; daysBack?: number } = {},
): Promise<WebSearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: 'not_configured',
      note: 'Web search not configured (TAVILY_API_KEY missing). Proceeding without web augmentation.',
    };
  }

  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.min(opts.maxResults ?? 6, 10),
        search_depth: 'basic',
        include_answer: false,
        days: opts.daysBack,
      }),
    });
    if (!resp.ok) {
      return {
        ok: false,
        reason: 'error',
        note: `Tavily ${resp.status}: ${await resp.text().catch(() => '')}`.slice(0, 300),
      };
    }
    const data = (await resp.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        published_date?: string;
      }>;
    };
    const results = (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 600),
      publishedDate: r.published_date,
    }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, reason: 'error', note: String(err).slice(0, 300) };
  }
}
