import { generateText, type Tool } from 'ai';
import { google } from '@ai-sdk/google';

import { ensureEnglish } from '../translate';
import { cacheKey, getCached, setCached } from '../tool-cache';
import { approvedHostnames, isApprovedSource, newsSources } from '../news-sources';
import type { Article, SearchHit } from './types';

// -- Freshness window --------------------------------------------------------
// `today` is YYYY-MM-DD anchored in the writer's local timezone — the client
// builds it via `todayISO()` in the orchestrator page, which uses local-time
// getters (`getMonth`, `getDate`). Once we have that string, we treat it as a
// UTC calendar date so subsequent arithmetic and `getUTCDay()` match the
// writer's calendar regardless of the server runtime's local zone. The same
// reasoning is mirrored in `newsContextForDate` in `lib/news-prompt.ts`; if
// you change the date semantics here, change it there too.

function parseLocalDate(today: string): Date {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function offsetDay(anchor: Date, delta: number): string {
  const x = new Date(anchor);
  x.setUTCDate(x.getUTCDate() + delta);
  return x.toISOString().slice(0, 10);
}

// Acceptable publication dates, in writer-local calendar terms.
function freshnessWindow(today: string): string[] {
  const anchor = parseLocalDate(today);
  const dates = [offsetDay(anchor, 0), offsetDay(anchor, -1)];
  // On Monday, also accept Saturday so the show catches the full weekend
  // (Sunday is already covered by yesterday).
  if (anchor.getUTCDay() === 1) dates.push(offsetDay(anchor, -2));
  return dates;
}

export function freshnessContext(today: string): string {
  const anchor = parseLocalDate(today);
  const dow = anchor.getUTCDay();
  const isMonday = dow === 1;
  const window = freshnessWindow(today);
  const list = isMonday
    ? `${window[2]} (Saturday), ${window[1]} (Sunday), or ${window[0]} (today, Monday)`
    : `${window[1]} (yesterday) or ${window[0]} (today)`;
  return `Today is ${today}.\n\nAcceptable publication dates: ${list}. Prioritize the freshest stories — articles from the last ~24 hours.`;
}

// -- Tavily Extract (full-text fetch) ----------------------------------------

type ExtractResult =
  | { ok: true; title: string; text: string; date: string | null; source: string }
  | { ok: false; note: string };

async function extractArticle(url: string, signal?: AbortSignal): Promise<ExtractResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { ok: false, note: 'TAVILY_API_KEY missing' };

  const key = cacheKey('orch:article', { url });
  const cached = await getCached<ExtractResult>(key, 72);
  if (cached) return cached;

  try {
    const resp = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, urls: [url], extract_depth: 'advanced' }),
      signal,
    });
    if (!resp.ok) {
      return { ok: false, note: `Tavily ${resp.status}` };
    }
    const data = (await resp.json()) as {
      results?: Array<{
        url?: string;
        title?: string;
        raw_content?: string;
        publish_date?: string | null;
        source_name?: string;
      }>;
    };
    const r = data.results?.[0];
    if (!r) return { ok: false, note: 'no content' };

    const text = await ensureEnglish(r.raw_content ?? '', signal);
    const result: ExtractResult = {
      ok: true,
      title: r.title ?? 'Untitled',
      text,
      date: r.publish_date ?? null,
      source: r.source_name ?? new URL(url).hostname,
    };
    await setCached(key, result);
    return result;
  } catch (err) {
    // A cancelled gather must abort the whole run — don't bury it as a
    // per-article failure.
    if (signal?.aborted) throw err;
    return { ok: false, note: String(err).slice(0, 200) };
  }
}

// -- URL verification + recovery --------------------------------------------
// Gemini occasionally writes URLs from its own understanding rather than the
// actual search result — e.g. normalizing `with-u-s` → `with-us` or drifting
// the path date by a day. We HEAD-check every candidate; on a 404 we ask
// Tavily Search to find the real URL on the same domain by title.

const VERIFY_TIMEOUT_MS = 5000;
// Jaccard similarity threshold (lowercased word-tokens, length > 3) above
// which a recovered article is accepted as the same story. ~0.4 keeps real
// matches with paraphrased headlines and rejects unrelated same-domain
// articles that happen to mention shared keywords.
const TITLE_SIMILARITY_THRESHOLD = 0.4;

async function headStatus(url: string, signal?: AbortSignal): Promise<number> {
  const timeout = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    return r.status;
  } catch (err) {
    // The 5s timeout aborting is an expected dead-URL signal — fall through
    // to 0. A caller-initiated abort means the whole gather was cancelled.
    if (signal?.aborted) throw err;
    return 0;
  }
}

async function searchByTitle(
  title: string,
  domain: string,
  signal?: AbortSignal,
): Promise<{ url: string; title: string } | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  const timeout = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: title,
        include_domains: [domain],
        max_results: 3,
      }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      results?: Array<{ url?: string; title?: string }>;
    };
    const top = data.results?.[0];
    if (!top || typeof top.url !== 'string') return null;
    return {
      url: top.url,
      title: typeof top.title === 'string' ? top.title : '',
    };
  } catch (err) {
    // Timeout → treat as no recovery found. Caller-initiated abort → propagate.
    if (signal?.aborted) throw err;
    return null;
  }
}

function titleSimilarity(a: string, b: string): number {
  // Stopwords (the / and / etc.) are filtered out, but keep short high-signal
  // tokens — "IDF", "UN", "war", "Gaza" — that previously fell under a
  // length-> 3 filter and made short headlines score artificially low.
  const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that',
    'are', 'was', 'were', 'has', 'have', 'had', 'but',
    'not', 'you', 'your', 'his', 'her', 'its', 'our',
  ]);
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !STOPWORDS.has(w)),
    );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

// -- Gemini google search discovery ------------------------------------------

type Candidate = {
  title: string;
  url: string;
  publicationDate: string | null;
  source: string;
};

const DISCOVERY_PROMPT = (
  today: string,
  dateContext: string,
  outletList: string,
  extraGuidance: string,
) => `You are a news researcher gathering source candidates for the *Ark News Daily* briefing — a 6–10 minute show on Israel, Jews, and the Middle East. Today is ${today}.

${dateContext}

Find the most newsworthy 12–15 articles about Israel, Jews, and the Middle East from the acceptable date range above. Prioritize:
- Major policy shifts, military or diplomatic developments
- Stories with broader significance (not just incremental updates)
- A mix of perspectives where the story is contested

APPROVED OUTLETS (hard constraint — only these are allowed):
${outletList}

ONLY return articles from the approved outlets above. Do not include articles from any other publication, regardless of how reputable or relevant they are — including The Guardian, BBC, CNN, Middle East Eye, or any outlet not on this list. If a search result is from a non-approved outlet, exclude it. If you cannot find enough approved-outlet articles, return fewer than 12 rather than padding with non-approved sources.

For X/Twitter accounts on the list, individual posts (status URLs) from those handles count as approved.

${extraGuidance ? `Additional guidance from the writer:\n${extraGuidance}\n\n` : ''}For each article return a strict JSON array. No prose, no markdown fencing — just valid JSON. Each element:

{ "title": string, "url": string, "publicationDate": "YYYY-MM-DD" or null, "source": string }

The "source" field must match the outlet name from the approved list. Use the google_search tool to find articles. Cite real URLs only.`;

const candidateArrayRegex = /\[[\s\S]*\]/;

function parseCandidates(raw: string): Candidate[] {
  const match = raw.match(candidateArrayRegex);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((c): Candidate[] => {
      if (!c || typeof c !== 'object') return [];
      const o = c as Record<string, unknown>;
      const url = typeof o.url === 'string' ? o.url : null;
      const title = typeof o.title === 'string' ? o.title : null;
      if (!url || !title) return [];
      try { new URL(url); } catch { return []; }
      return [{
        title,
        url,
        publicationDate: typeof o.publicationDate === 'string' ? o.publicationDate : null,
        source: typeof o.source === 'string' ? o.source : new URL(url).hostname,
      }];
    });
  } catch {
    return [];
  }
}

// Exported for the `scripts/discover-news-candidates.ts` preview tool — it
// dumps this raw output before approval filtering / verification / extraction.
export async function discoverCandidates(
  today: string,
  dateContext: string,
  extraGuidance: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const outletList = [
    `English-language outlets:\n${newsSources.englishSites.map((s) => `  - ${s}`).join('\n')}`,
    `Hebrew-language outlets:\n${newsSources.hebrewSites.map((s) => `  - ${s}`).join('\n')}`,
    `X/Twitter accounts:\n${newsSources.xAccounts.map((a) => `  - ${a.handle} (${a.name})`).join('\n')}`,
    `Analysis and think tanks:\n${newsSources.analysisAndThinkTanks.map((s) => `  - ${s}`).join('\n')}`,
  ].join('\n\n');

  const prompt = DISCOVERY_PROMPT(today, dateContext, outletList, extraGuidance);

  // @ai-sdk/google's googleSearch tool returns Tool<{}, never> which doesn't
  // satisfy ai v6's stricter Tool<never, never> tools-record constraint —
  // narrow the cast rather than disabling type checking on the whole call.
  const googleSearchTool = google.tools.googleSearch({}) as unknown as Tool;
  const { text } = await generateText({
    model: 'google/gemini-2.5-flash',
    tools: { google_search: googleSearchTool },
    prompt,
    // 0 to discourage URL paraphrasing — the model still hallucinates
    // sometimes, which is why we verify each candidate URL below.
    temperature: 0,
    abortSignal: signal,
  });
  return parseCandidates(text);
}

// Exported for testing. The Candidate type is file-local; tests pass a plain
// object with the same shape.
export async function verifyOrRecover(
  c: Candidate,
  signal?: AbortSignal,
): Promise<Candidate | null> {
  const status = await headStatus(c.url, signal);
  // Treat only a definitive 404 as a hallucinated URL. 405 (HEAD not allowed),
  // network errors (status 0), and 5xx responses fall through to extract,
  // which has its own retry/timeout semantics and a structured failure path.
  if (status !== 404) return c;

  let domain: string;
  try {
    domain = new URL(c.url).hostname;
  } catch {
    return null;
  }

  const recovered = await searchByTitle(c.title, domain, signal);
  if (!recovered || recovered.url === c.url) {
    console.warn(`[gatherSources] dropping unrecoverable 404: ${c.url}`);
    return null;
  }

  // Sanity-check: searches constrained to a domain still surface unrelated
  // articles that happen to share keywords with the title. Drop low-similarity
  // recoveries to avoid citing the wrong article under a valid URL.
  const similarity = titleSimilarity(c.title, recovered.title);
  if (similarity < TITLE_SIMILARITY_THRESHOLD) {
    console.warn(
      `[gatherSources] dropping low-similarity recovery (${similarity.toFixed(2)}): ${c.url} -> ${recovered.url}`,
    );
    return null;
  }

  console.warn(`[gatherSources] URL recovered: ${c.url} -> ${recovered.url}`);
  return { ...c, url: recovered.url };
}

// -- Public API --------------------------------------------------------------

function inAcceptableRange(today: string, publicationDate: string | null): boolean {
  if (!publicationDate) return false;
  return freshnessWindow(today).includes(publicationDate.slice(0, 10));
}

// Extract a single writer-supplied URL into an Article. Used by manual-attach
// flows that bypass discovery; freshness-window flagging still applies.
export async function extractUrlToArticle(
  url: string,
  today: string,
): Promise<Article> {
  const result = await extractArticle(url);
  if (!result.ok) {
    return {
      title: url,
      url,
      publicationDate: null,
      source: (() => { try { return new URL(url).hostname; } catch { return 'unknown'; } })(),
      content: '',
      isFlagged: true,
      fetchError: result.note,
    };
  }
  return {
    title: result.title,
    url,
    publicationDate: result.date,
    source: result.source,
    content: result.text,
    isFlagged: !inAcceptableRange(today, result.date),
  };
}

// Multi-domain keyword search across the approved outlets — the writer-facing
// escape hatch for triage when Gemini discovery comes up short. Generalizes
// `searchByTitle` (single-domain, used for URL recovery) to query every
// approved hostname at once. Returns lightweight hits only; extraction is
// deferred to `extractUrlToArticle` when the writer clicks "Add", so a search
// that surfaces 12 results doesn't pay for 12 Tavily extracts.
//
// Limitation: Tavily `include_domains` can't target specific X/Twitter
// handles, so this covers the news sites and think tanks but not the 15 X
// accounts — those stay Gemini-discovery-only. The UI surfaces this.
export async function keywordSearch(
  query: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY missing');

  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      include_domains: approvedHostnames,
      max_results: 12,
    }),
    signal,
  });
  if (!resp.ok) throw new Error(`Tavily search ${resp.status}`);

  const data = (await resp.json()) as {
    results?: Array<{
      url?: string;
      title?: string;
      published_date?: string | null;
      source_name?: string;
    }>;
  };

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of data.results ?? []) {
    if (typeof r.url !== 'string' || typeof r.title !== 'string') continue;
    if (seen.has(r.url)) continue;
    // `include_domains` is a soft scope — re-check against the approved list,
    // the same belt-and-suspenders backstop gatherSources applies to Gemini.
    if (!isApprovedSource(r.url)) continue;
    let source: string;
    try {
      source = r.source_name ?? new URL(r.url).hostname;
    } catch {
      continue;
    }
    seen.add(r.url);
    hits.push({
      title: r.title,
      url: r.url,
      source,
      publicationDate: r.published_date ?? null,
    });
  }
  return hits;
}

export async function gatherSources(opts: {
  today: string;
  timezone?: string;
  extraGuidance?: string;
  maxArticles?: number;
  signal?: AbortSignal;
}): Promise<Article[]> {
  const { today, extraGuidance = '', maxArticles = 15, signal } = opts;
  const dateContext = freshnessContext(today);

  const candidates = await discoverCandidates(today, dateContext, extraGuidance, signal);
  if (candidates.length === 0) return [];

  // Drop anything Gemini returned from outside the approved outlet list —
  // belt-and-suspenders backup to the prompt-level constraint.
  const approved = candidates.filter((c) => isApprovedSource(c.url));
  if (approved.length === 0) return [];

  // Dedupe by URL, cap before extraction (Tavily charges per call).
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of approved) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    deduped.push(c);
    if (deduped.length >= maxArticles) break;
  }

  // Verify URLs (and recover hallucinated ones) before paying for Tavily
  // extract. Dedupe again in case recovery collapses two candidates to the
  // same canonical URL. allSettled so one verifyOrRecover throw can't
  // collapse the entire run to zero articles.
  const verifiedSeen = new Set<string>();
  const verified: Candidate[] = [];
  const settled = await Promise.allSettled(deduped.map((c) => verifyOrRecover(c, signal)));
  for (const s of settled) {
    if (s.status === 'rejected') {
      // A cancelled gather surfaces here as a rejected settle — propagate it
      // instead of skipping, so the run actually stops.
      if (signal?.aborted) throw s.reason;
      console.warn(`[gatherSources] verify threw, skipping: ${String(s.reason)}`);
      continue;
    }
    const c = s.value;
    if (!c || verifiedSeen.has(c.url)) continue;
    verifiedSeen.add(c.url);
    verified.push(c);
  }

  const extracted = await Promise.all(
    verified.map(async (c): Promise<Article | null> => {
      const result = await extractArticle(c.url, signal);
      const isFlagged = !inAcceptableRange(today, c.publicationDate);
      if (!result.ok) {
        // Backstop: even after URL verification, Tavily can fail (paywall,
        // bot block, transient). Drop rather than letting the writer cite a
        // source we couldn't read.
        console.warn(`[gatherSources] extract failed; dropping: ${c.url} — ${result.note}`);
        return null;
      }
      return {
        title: result.title || c.title,
        url: c.url,
        publicationDate: result.date ?? c.publicationDate,
        source: result.source || c.source,
        content: result.text,
        isFlagged: isFlagged || !inAcceptableRange(today, result.date ?? c.publicationDate),
      };
    }),
  );

  return extracted.filter((a): a is Article => a !== null);
}
