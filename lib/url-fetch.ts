// Tavily Extract — fetches the readable content of a URL the user pasted into
// a prep prompt (e.g. a CFR column the guest authored). Reuses TAVILY_API_KEY
// since the prep route already requires it for webSearch.
//
// We use extract_depth: 'advanced' because op-ed / longform pages routinely
// need it to defeat anti-scraping and pull the full body. Basic mode often
// returns 200 chars of nav + cookie banner.

export type ExtractedArticle = {
  url: string;
  content: string;
  // Tavily Extract does not always return a title in its response; surface
  // null rather than guess so the prompt template can fall back to the URL.
  title: string | null;
};

export type ExtractFailure = {
  url: string;
  error: string;
};

export type ExtractResponse = {
  ok: ExtractedArticle[];
  failed: ExtractFailure[];
};

const ARTICLE_CHAR_CAP = 12_000;
// Tavily extract on `advanced` depth occasionally hangs on bot-blocked URLs.
// Without a ceiling each stuck call burns ~120s of Node's default socket
// timeout, which serializes the orchestrator's per-article extraction.
const EXTRACT_TIMEOUT_MS = 30_000;

export async function extractArticles(
  urls: string[],
): Promise<ExtractResponse> {
  if (urls.length === 0) return { ok: [], failed: [] };

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      ok: [],
      failed: urls.map((url) => ({ url, error: 'not_configured' })),
    };
  }

  try {
    const resp = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        urls,
        extract_depth: 'advanced',
      }),
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const note = `tavily_${resp.status}: ${errText.slice(0, 200)}`;
      return {
        ok: [],
        failed: urls.map((url) => ({ url, error: note })),
      };
    }

    const data = (await resp.json()) as {
      results?: Array<{ url: string; raw_content?: string; title?: string }>;
      failed_results?: Array<{ url: string; error?: string }>;
    };

    const ok: ExtractedArticle[] = (data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? null,
      content: (r.raw_content ?? '').slice(0, ARTICLE_CHAR_CAP),
    }));

    const failed: ExtractFailure[] = (data.failed_results ?? []).map((r) => ({
      url: r.url,
      error: r.error ?? 'unknown_error',
    }));

    return { ok, failed };
  } catch (err) {
    return {
      ok: [],
      failed: urls.map((url) => ({ url, error: String(err).slice(0, 200) })),
    };
  }
}
