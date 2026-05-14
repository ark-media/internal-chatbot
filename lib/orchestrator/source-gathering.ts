import { generateText, type Tool } from 'ai';
import { google } from '@ai-sdk/google';

import { ensureEnglish } from '../translate';
import { cacheKey, getCached, setCached } from '../tool-cache';
import { approvedHostnames, isApprovedSource, newsSources } from '../news-sources';
import type { Article, Candidate } from './types';

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

// Gemini's grounded-search tool sometimes hands back its own redirect URLs
// (https://vertexaisearch.cloud.google.com/grounding-api-redirect/...) instead
// of the real article links. They're unusable downstream — `isApprovedSource`
// rejects the Google host, so a run full of them silently filters to zero.
// Drop them at parse time; `discoverCandidates` retries when discovery comes
// up short.
const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

// Pull the first balanced top-level JSON array out of `raw`. Gemini wraps the
// array in markdown fences and sometimes trails it with grounding prose that
// itself contains brackets ("Sources: [1], [2]"); a greedy /\[[\s\S]*\]/
// over-captures that trailing text and JSON.parse throws. Scan from the first
// `[` to its matching `]`, tracking string literals so brackets inside titles
// don't skew the depth count.
function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

// Exported for unit testing.
export function parseCandidates(raw: string): Candidate[] {
  const json = extractJsonArray(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((c): Candidate[] => {
    if (!c || typeof c !== 'object') return [];
    const o = c as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : null;
    const title = typeof o.title === 'string' ? o.title : null;
    if (!url || !title) return [];
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { return []; }
    if (parsedUrl.hostname === GROUNDING_REDIRECT_HOST) return [];
    return [{
      title,
      url,
      publicationDate: typeof o.publicationDate === 'string' ? o.publicationDate : null,
      source: typeof o.source === 'string' ? o.source : parsedUrl.hostname,
    }];
  });
}

// Discovery is non-deterministic and fails several silent ways: the AI
// Gateway times out, Gemini ends a grounded turn with no text to parse, or it
// returns only redirect URLs (dropped in parseCandidates). Each yields zero
// candidates, which the caller would otherwise surface as "no articles." Retry
// a few times — a fresh call usually succeeds.
const DISCOVERY_MAX_ATTEMPTS = 3;

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

  let lastError: unknown = null;
  let anyCompleted = false;
  for (let attempt = 1; attempt <= DISCOVERY_MAX_ATTEMPTS; attempt++) {
    try {
      const { text, finishReason } = await generateText({
        model: 'google/gemini-2.5-flash',
        tools: { google_search: googleSearchTool },
        prompt,
        // 0 to discourage URL paraphrasing — the model still hallucinates
        // sometimes, which is why we verify each candidate URL below.
        temperature: 0,
        abortSignal: signal,
      });
      anyCompleted = true;
      const candidates = parseCandidates(text);
      if (candidates.length > 0) {
        if (attempt > 1) {
          console.warn(
            JSON.stringify({
              event: 'orchestrator.discover.recovered',
              attempt,
              candidateCount: candidates.length,
            }),
          );
        }
        return candidates;
      }
      // Completed, but empty/unparseable text or all-redirect URLs — log the
      // miss so the failure mode is visible, then retry.
      console.warn(
        JSON.stringify({
          event: 'orchestrator.discover.empty',
          attempt,
          finishReason,
          textLength: text.length,
        }),
      );
    } catch (err) {
      // A cancelled gather must abort the whole run — don't retry past it.
      if (signal?.aborted) throw err;
      lastError = err;
      console.warn(
        JSON.stringify({
          event: 'orchestrator.discover.error',
          attempt,
          err: String(err).slice(0, 300),
        }),
      );
    }
  }

  // Every attempt threw (gateway down, etc.) — surface it so /start reports
  // the real failure instead of a generic empty-result message. If at least
  // one attempt completed but returned nothing, that's a genuine empty
  // discovery: return [] and let the caller handle it.
  if (!anyCompleted && lastError) throw lastError;
  return [];
}

// Exported for testing.
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

// Exported so triage-stage code (the /triage and /search routes) can flag
// freshness on candidates without re-implementing the window logic.
export function inAcceptableRange(today: string, publicationDate: string | null): boolean {
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
// approved hostname at once. Returns candidates only — adding one to the
// triage list is just an append; verification and Tavily extraction wait for
// /group, same as discovery candidates.
//
// Limitation: Tavily `include_domains` can't target specific X/Twitter
// handles, so this covers the news sites and think tanks but not the 15 X
// accounts — those stay Gemini-discovery-only. The UI surfaces this.
export async function keywordSearch(
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
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
  const hits: Candidate[] = [];
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

// Discover → approval-filter → dedupe/cap. No URL verification, no Tavily
// extraction — this is the raw candidate pool the writer triages. Verification
// and extraction are deferred to `extractCandidates`, run later on only the
// candidates that survive triage.
export async function gatherCandidates(opts: {
  today: string;
  extraGuidance?: string;
  maxArticles?: number;
  signal?: AbortSignal;
}): Promise<Candidate[]> {
  const { today, extraGuidance = '', maxArticles = 15, signal } = opts;
  const dateContext = freshnessContext(today);

  const candidates = await discoverCandidates(today, dateContext, extraGuidance, signal);

  // Drop anything Gemini returned from outside the approved outlet list —
  // belt-and-suspenders backup to the prompt-level constraint.
  const approved = candidates.filter((c) => isApprovedSource(c.url));

  // Dedupe by URL and cap. Freshness is flagged from Gemini's claimed date;
  // extraction can refine it later against the real publish date.
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of approved) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    deduped.push({ ...c, isFlagged: !inAcceptableRange(today, c.publicationDate) });
    if (deduped.length >= maxArticles) break;
  }

  // Log the funnel so a zero result is diagnosable from the logs alone —
  // distinguishes "discovery came up empty" (rawCount 0) from "found articles
  // but all from non-approved outlets" (rawCount > 0, approvedCount 0).
  console.log(
    JSON.stringify({
      event: 'orchestrator.gather_candidates',
      rawCount: candidates.length,
      approvedCount: approved.length,
      candidateCount: deduped.length,
    }),
  );

  return deduped;
}

// Verify (and recover hallucinated 404s), then Tavily-extract a candidate list
// into full Articles. This is where URL verification and per-article Tavily
// cost is paid — callers that defer it (triage → /group) only pay for the
// survivors. Extraction failures are dropped: the writer shouldn't cite a
// source we couldn't read.
export async function extractCandidates(
  candidates: Candidate[],
  today: string,
  signal?: AbortSignal,
): Promise<Article[]> {
  if (candidates.length === 0) return [];

  // Verify URLs (and recover hallucinated ones) before paying for Tavily
  // extract. Dedupe again in case recovery collapses two candidates to the
  // same canonical URL. allSettled so one verifyOrRecover throw can't
  // collapse the entire run to zero articles.
  const verifiedSeen = new Set<string>();
  const verified: Candidate[] = [];
  const settled = await Promise.allSettled(candidates.map((c) => verifyOrRecover(c, signal)));
  for (const s of settled) {
    if (s.status === 'rejected') {
      // A cancelled gather surfaces here as a rejected settle — propagate it
      // instead of skipping, so the run actually stops.
      if (signal?.aborted) throw s.reason;
      console.warn(`[extractCandidates] verify threw, skipping: ${String(s.reason)}`);
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
        console.warn(`[extractCandidates] extract failed; dropping: ${c.url} — ${result.note}`);
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

// Discover + verify + extract in one pass — the original behavior, kept for
// checkpoint-stage topic gathers (/start `topics` mode, /topics, /refetch),
// where the result drops straight into a topic and extraction can't be
// deferred. The `discover` /start path uses `gatherCandidates` instead.
export async function gatherSources(opts: {
  today: string;
  timezone?: string;
  extraGuidance?: string;
  maxArticles?: number;
  signal?: AbortSignal;
}): Promise<Article[]> {
  const candidates = await gatherCandidates({
    today: opts.today,
    extraGuidance: opts.extraGuidance,
    maxArticles: opts.maxArticles,
    signal: opts.signal,
  });
  return extractCandidates(candidates, opts.today, opts.signal);
}
