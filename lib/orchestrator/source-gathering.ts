import { ensureEnglish } from '../translate';
import { cacheKey, getCached, setCached } from '../tool-cache';
import { approvedHostnames, isApprovedSource } from '../news-sources';
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

// Acceptable publication dates, in writer-local calendar terms. Exported so
// the X API client (`lib/x-api.ts`) can derive a `start_time` from the same
// window the rest of the orchestrator flags freshness against.
export function freshnessWindow(today: string): string[] {
  const anchor = parseLocalDate(today);
  const dates = [offsetDay(anchor, 0), offsetDay(anchor, -1)];
  // On Monday, also accept Saturday so the show catches the full weekend
  // (Sunday is already covered by yesterday).
  if (anchor.getUTCDay() === 1) dates.push(offsetDay(anchor, -2));
  return dates;
}

// The freshness window as a Tavily `start_date`/`end_date` pair. `window[0]`
// is today; the last element is the earliest acceptable date (yesterday, or
// Saturday on Mondays). Tavily filters on publish/update date — `inAcceptableRange`
// still does the authoritative per-candidate flagging downstream.
function freshnessRange(today: string): { startDate: string; endDate: string } {
  const window = freshnessWindow(today);
  return { startDate: window[window.length - 1], endDate: window[0] };
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

// -- Tavily article discovery ------------------------------------------------
// Article discovery used to be a single grounded Gemini call that ran dozens
// of internal google_search round-trips to satisfy "12-15 articles across the
// whole outlet list" — 1–2.5 min of wall clock, and it routinely handed back
// hallucinated or duplicated URLs. Tavily /search scoped to the approved
// hostnames returns real, date-filtered URLs in seconds; we fan out a handful
// of beat queries in parallel and merge. Editorial "most newsworthy" judgment
// isn't lost — distillTopics still groups + scores the survivors downstream.

type TavilySearchHit = {
  url?: string;
  title?: string;
  published_date?: string | null;
  source_name?: string;
};

// Tavily's `published_date` comes back as an RFC-2822-ish string
// ("Wed, 13 May 2026 14:28:00 GMT"). Everything downstream — `inAcceptableRange`,
// the triage UI's date badge — expects `YYYY-MM-DD`, so normalize here. An
// unparseable or absent date becomes null, which `inAcceptableRange` treats as
// out-of-window: the writer sees an "older story" flag and can check it.
function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// A single Tavily /search call scoped to the approved outlets, mapped to a
// deduped Candidate[]. `include_domains` is a soft scope, so every result is
// re-checked against the approved list — the same belt-and-suspenders backstop
// applied everywhere a candidate can enter the pool. `startDate`/`endDate` are
// optional: discovery scopes to the freshness window, keyword search doesn't.
async function tavilySearch(opts: {
  query: string;
  maxResults: number;
  startDate?: string;
  endDate?: string;
  signal?: AbortSignal;
}): Promise<Candidate[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY missing');

  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: opts.query,
      topic: 'news',
      include_domains: approvedHostnames,
      max_results: opts.maxResults,
      ...(opts.startDate ? { start_date: opts.startDate } : {}),
      ...(opts.endDate ? { end_date: opts.endDate } : {}),
    }),
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`Tavily search ${resp.status}`);

  const data = (await resp.json()) as { results?: TavilySearchHit[] };
  const seen = new Set<string>();
  const hits: Candidate[] = [];
  for (const r of data.results ?? []) {
    if (typeof r.url !== 'string' || typeof r.title !== 'string') continue;
    if (seen.has(r.url)) continue;
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
      publicationDate: toIsoDate(r.published_date),
    });
  }
  return hits;
}

// The show's beat — Israel, Jews, and the Middle East — as durable thematic
// queries. Deliberately broad and evergreen: outlet-scoping (include_domains)
// and the freshness window do the narrowing, and distillTopics scores the
// survivors downstream. No event-specific terms ("hostages", "Gaza war") —
// those go stale and would need constant re-tuning. Query *count* per theme
// doubles as the weighting knob: discoverCandidates merges these round-robin,
// so the three Israel queries hand the show's core beat ~1/3 of the triaged
// pool. Tune the set here if coverage gaps show up. X/Twitter is intentionally
// absent — recent posts from the 15 X handles come in via the X API client
// (`lib/x-api.ts`), behind the triage-stage "Pull recent X posts" button.
const DISCOVERY_QUERIES = [
  'Israel',
  'Israeli politics',
  'Israeli security',
  'Iran',
  'Middle East geopolitics',
  'Israel international relations',
  'antisemitism',
  'Jewish diaspora life',
  'Jewish identity',
];

// Per-query result cap — the depth of each query's list feeding the round-robin
// merge in discoverCandidates. Nine queries × 12 ≈ 108 raw hits; the merge
// interleaves and dedupes them, and gatherCandidates caps the survivors at
// maxArticles (20). Deeper than the cap strictly needs on purpose — headroom
// for dedupe collapse and queries that come back short.
const DISCOVERY_RESULTS_PER_QUERY = 12;

// Exported for the `scripts/discover-news-candidates.ts` preview tool — it
// dumps this raw output before approval filtering / verification / extraction.
export async function discoverCandidates(
  today: string,
  extraGuidance: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const { startDate, endDate } = freshnessRange(today);
  // Topic gathers (/start topics, /topics, /refetch) pass the topic as
  // extraGuidance — search for exactly that. Plain discovery fans out across
  // the show's beat.
  const queries = extraGuidance.trim() ? [extraGuidance.trim()] : DISCOVERY_QUERIES;

  const settled = await Promise.allSettled(
    queries.map((query) =>
      tavilySearch({
        query,
        maxResults: DISCOVERY_RESULTS_PER_QUERY,
        startDate,
        endDate,
        signal,
      }),
    ),
  );

  // Keep each fulfilled query's hits as its own list so the merge below can
  // interleave them; track errors the same way as before.
  const lists: Candidate[][] = [];
  let anyFulfilled = false;
  let lastError: unknown = null;
  for (const s of settled) {
    if (s.status === 'rejected') {
      // A cancelled gather surfaces as a rejection — propagate it instead of
      // burying it as one query's bad luck.
      if (signal?.aborted) throw s.reason;
      lastError = s.reason;
      console.warn(
        JSON.stringify({
          event: 'orchestrator.discover.query_error',
          err: String(s.reason).slice(0, 300),
        }),
      );
      continue;
    }
    anyFulfilled = true;
    lists.push(s.value);
  }

  // Interleave round-robin — hit 0 from every query, then hit 1, and so on —
  // deduping by URL as we go. gatherCandidates fills its cap in iteration
  // order, so a plain concatenation would let the first query or two crowd the
  // rest out; interleaving gives every query (every beat) a fair share.
  const seen = new Set<string>();
  const merged: Candidate[] = [];
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const c = list[i];
      if (!c || seen.has(c.url)) continue;
      seen.add(c.url);
      merged.push(c);
    }
  }

  // Every query threw (Tavily down, key missing) — surface it so /start
  // reports the real failure instead of a generic empty-result message. A
  // fulfilled-but-empty run is a genuine empty discovery: return [].
  if (!anyFulfilled && lastError) throw lastError;
  return merged;
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
// escape hatch for triage when automatic discovery comes up short. Returns
// candidates only — adding one to the triage list is just an append;
// verification and Tavily extraction wait for /group, same as discovery
// candidates. Unlike discovery, it isn't date-scoped: the writer may be
// reaching for an older story on purpose.
//
// Limitation: Tavily `include_domains` can't target specific X/Twitter
// handles, so this covers the news sites and think tanks but not the 15 X
// accounts — those come in via the X API client (`lib/x-api.ts`). The UI
// surfaces this.
export async function keywordSearch(
  query: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  return tavilySearch({ query, maxResults: 12, signal });
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
  const { today, extraGuidance = '', maxArticles = 20, signal } = opts;

  const candidates = await discoverCandidates(today, extraGuidance, signal);

  // `tavilySearch` already re-checks `isApprovedSource` per result, but keep
  // the filter here too — it's the funnel's belt-and-suspenders backstop and
  // keeps `rawCount` vs `approvedCount` meaningful in the log below.
  const approved = candidates.filter((c) => isApprovedSource(c.url));

  // Dedupe by URL and cap. Freshness is flagged from Tavily's claimed date;
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
