import { generateText, type Tool } from 'ai';
import { google } from '@ai-sdk/google';

import { ensureEnglish } from '../translate';
import { cacheKey, getCached, setCached } from '../tool-cache';
import {
  approvedHostnames,
  hardPaywallHostnames,
  isApprovedSource,
  isHardPaywallSource,
  newsSources,
} from '../news-sources';
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

// The freshness window expressed as Tavily's `days` parameter — how many days
// back from "now" to include. Tavily's `start_date`/`end_date` filter is anchored
// to midnight UTC and ranks the window by relevance, which means yesterday's
// articles (which have had ~24h longer to accumulate relevance signals) crowd
// out today's stories before our per-query cap is hit. `days` is anchored to
// "now" and weights toward the freshest indexed content, so today's articles
// actually surface. `inAcceptableRange` still does the authoritative per-candidate
// flagging downstream.
function freshnessDays(today: string): number {
  return freshnessWindow(today).length;
}

// -- Tavily Extract (full-text fetch) ----------------------------------------

type ExtractResult =
  | { ok: true; title: string; text: string; date: string | null; source: string }
  | { ok: false; note: string };

// How much of the article head to hand the date-derivation model. The
// publication date lives in the dateline / byline / "Updated …" line near the
// top; 2k chars is plenty and keeps the call cheap.
const DATE_DERIVE_CHARS = 2000;

// Tavily Extract often omits `publish_date` even when the body carries a clear
// dateline. Rather than hand the breaking scan an undated article (which its
// cutoff filter now drops fail-closed), read the date out of the body with a
// fast model. The prompt is pinned to the ARTICLE'S OWN publication date — not
// any date the story happens to mention — and returns null when the text
// doesn't establish one. Best-effort: any failure yields null (→ undated →
// dropped downstream), never a wrong date. `toIsoDate` is hoisted, so the parse
// guard below rejects a well-formed-but-unparseable hallucination. The match is
// anchored to the START of the (trimmed) output, so we only accept the date the
// model gives as its answer — not one it echoes out of the article prose, which
// is where a mentioned event date or a prompt-injected "Published:" line would
// otherwise slip in.
async function deriveDateFromText(text: string, signal?: AbortSignal): Promise<string | null> {
  const head = text.trim().slice(0, DATE_DERIVE_CHARS);
  if (!head) return null;
  try {
    const { text: out } = await generateText({
      model: 'google/gemini-2.5-flash',
      abortSignal: signal,
      prompt: `Below is the top of a news article. Return ONLY the date the ARTICLE ITSELF was published, formatted as YYYY-MM-DD — the article's own publication/posted date from its dateline, byline timestamp, or "Published"/"Updated" line. Do NOT return a date merely mentioned in the story's events. If the text does not establish the article's publication date, return exactly "unknown".\n\n---\n${head}`,
    });
    const m = out.trim().match(/^\d{4}-\d{2}-\d{2}/);
    return m ? toIsoDate(m[0]) : null;
  } catch (err) {
    // A cancelled gather must abort the whole run, not fall back to null.
    if (signal?.aborted) throw err;
    return null;
  }
}

async function extractArticle(url: string, signal?: AbortSignal): Promise<ExtractResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return { ok: false, note: 'TAVILY_API_KEY missing' };

  // v2: bumped when body-date derivation was added, so pre-derivation entries
  // cached with date:null re-extract (and get a derived date) instead of being
  // dropped fail-closed downstream.
  const key = cacheKey('orch:article:v2', { url });
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
    // Prefer Tavily's own date; fall back to reading it out of the body when
    // Tavily didn't return one, so undated-but-datable articles aren't dropped.
    const date = r.publish_date ?? (await deriveDateFromText(text, signal));
    const result: ExtractResult = {
      ok: true,
      title: r.title ?? 'Untitled',
      text,
      date,
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

// -- Gemini X/Twitter discovery ----------------------------------------------
// Article discovery moved to Tavily (see `discoverCandidates` below) — fast,
// and it returns real date-filtered URLs. But Tavily's `include_domains`
// can't target specific X/Twitter handles, so posts from the approved
// handles still need grounded Gemini search. This prompt is scoped to *only*
// those handles, so it's far narrower than the old all-outlet discovery.

const X_DISCOVERY_PROMPT = (
  today: string,
  dateContext: string,
  handleList: string,
) => `You are a news researcher gathering recent X/Twitter posts for the *Ark News Daily* briefing — a 6–10 minute show on Israel, Jews, and the Middle East. Today is ${today}.

${dateContext}

Find the most newsworthy recent posts from ONLY these X/Twitter accounts:
${handleList}

Hard constraints:
- ONLY return posts from the handles listed above. Do not include posts from any other account, however relevant.
- Return individual post URLs — status links of the form https://x.com/{handle}/status/{id}. Not profile pages, not search pages.
- Prioritize posts that break news, add original reporting, or give sharp analysis on Israel, Jews, and the Middle East.
- Posts must fall within the acceptable date range above.

Return a strict JSON array. No prose, no markdown fencing — just valid JSON. Each element:

{ "title": string, "url": string, "publicationDate": "YYYY-MM-DD" or null, "source": string }

"title" is a one-line summary of what the post says. "source" is the account's display name. Use the google_search tool to find posts. Cite real status URLs only.`;

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

// parseCandidates flattens every failure into [], so it can't tell the model
// genuinely reporting no posts from a turn that produced nothing to parse.
// A well-formed JSON array — even an empty one — is an answer; anything else
// (no array, malformed JSON, a non-array) is not. null means "not an answer".
function parsedArrayLength(raw: string): number | null {
  const json = extractJsonArray(raw);
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
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

// Grounded Gemini is non-deterministic and fails several silent ways: the AI
// Gateway times out, Gemini ends a grounded turn with no text to parse, or it
// returns only redirect URLs (dropped in parseCandidates). Each yields zero
// candidates, which the caller would otherwise surface as "no posts." Retry a
// few times — a fresh call usually succeeds.
//
// This covers *failures* only. A well-formed empty array is a real answer, and
// retrying it re-rolls the same temperature-0 grounded search at ~a minute an
// attempt — which is what pushed /api/news/orchestrator/chat past its 300s
// ceiling. See the empty-array early return below.
const DISCOVERY_MAX_ATTEMPTS = 3;

// Recent posts from the approved X/Twitter handles. Kept on grounded Gemini
// because Tavily can't target specific handles — but scoped to *only* the 15
// handles instead of the full outlet list, so it's far narrower (and faster)
// than the old all-source discovery. Runs behind its own triage-stage button,
// off the main "pull today's stories" path.
export async function discoverXPosts(
  today: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const dateContext = freshnessContext(today);
  const handleList = newsSources.xAccounts
    .map((a) => `  - ${a.handle} (${a.name}${a.role ? `, ${a.role}` : ''})`)
    .join('\n');
  const prompt = X_DISCOVERY_PROMPT(today, dateContext, handleList);

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
        // sometimes, which is why isApprovedSource re-checks every URL.
        temperature: 0,
        abortSignal: signal,
      });
      anyCompleted = true;
      // parseCandidates drops grounding-redirect URLs; isApprovedSource then
      // rejects anything that isn't a canonical /{handle}/status/{id} URL from
      // a listed handle — the backstop for Gemini straying off the handle list.
      const candidates = parseCandidates(text).filter((c) => isApprovedSource(c.url));
      if (candidates.length > 0) {
        if (attempt > 1) {
          console.warn(
            JSON.stringify({
              event: 'orchestrator.discover_x.recovered',
              attempt,
              candidateCount: candidates.length,
            }),
          );
        }
        return candidates;
      }
      // A well-formed empty array is the model's actual answer — nothing on the
      // handle list today. Accept it and let the caller degrade to "no X posts"
      // rather than burning two more grounded searches to hear it again.
      if (parsedArrayLength(text) === 0) {
        console.warn(
          JSON.stringify({
            event: 'orchestrator.discover_x.none',
            attempt,
            finishReason,
          }),
        );
        return [];
      }
      // Completed, but unparseable text or only redirect/off-handle URLs — one
      // of the silent failures above. Log the miss so it stays visible, retry.
      console.warn(
        JSON.stringify({
          event: 'orchestrator.discover_x.empty',
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
          event: 'orchestrator.discover_x.error',
          attempt,
          err: String(err).slice(0, 300),
        }),
      );
    }
  }

  // Every attempt threw (gateway down, etc.) — surface it so the route reports
  // the real failure. If at least one attempt completed but returned nothing,
  // that's a genuine empty result: return [] and let the caller handle it.
  if (!anyCompleted && lastError) throw lastError;
  return [];
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
// applied everywhere a candidate can enter the pool. `days` is optional:
// discovery scopes to the freshness window, keyword search and WSJ mirror
// lookups don't. `includeDomains` overrides the default approved-list scope —
// used by the WSJ mirror lookup to search every approved outlet *except* WSJ.
async function tavilySearch(opts: {
  query: string;
  maxResults: number;
  days?: number;
  includeDomains?: string[];
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
      include_domains: opts.includeDomains ?? approvedHostnames,
      max_results: opts.maxResults,
      ...(opts.days ? { days: opts.days } : {}),
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

// -- paywall → free-mirror substitution --------------------------------------
// Hard-paywall outlets (WSJ, NYT, Washington Post, FT) return only a headline +
// teaser from Tavily Extract, not the body, so the writer can't actually cite
// them. Their scoops typically get re-reported by Reuters/Bloomberg/AP/the
// Guardian/Times of Israel within hours, so when discovery surfaces a paywalled
// URL we search the other approved outlets for the same story by title and
// substitute the free version. If no mirror is found, the paywalled candidate
// is dropped — better than letting the writer triage an article we can't read.
// Only runs during automatic discovery, not the writer's manual `keywordSearch`
// escape hatch (where a paywalled URL is opt-in). See hardPaywallHostnames /
// isHardPaywallSource in news-sources.

// Same-event window for cross-outlet mirror matching. Re-reports usually drop
// within hours; ±1 day catches late filings on either side of midnight UTC
// without admitting a related-but-different story from later in the week.
const MIRROR_DATE_WINDOW_DAYS = 1;

function withinMirrorDateWindow(a: string | null, b: string | null): boolean {
  // If either side is dateless, don't enforce — Tavily occasionally omits
  // published_date on otherwise-good results, and the relevance ranking is
  // still a strong same-event signal.
  if (!a || !b) return true;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return true;
  return Math.abs(aMs - bMs) / 86_400_000 <= MIRROR_DATE_WINDOW_DAYS;
}

// Look up a free mirror of a paywalled article by title. Tavily news-topic
// relevance ranking on the title query handles same-event matching; we trust
// the top result that's within the date window. The search excludes every
// hard-paywall outlet so we never mirror one paywall to another. Returns null
// when no candidate survives — caller drops the paywalled entry.
async function findFreeMirror(
  paywalled: Candidate,
  signal?: AbortSignal,
): Promise<Candidate | null> {
  const freeHostnames = approvedHostnames.filter((h) => !hardPaywallHostnames.includes(h));
  let mirrors: Candidate[];
  try {
    mirrors = await tavilySearch({
      query: paywalled.title,
      maxResults: 5,
      includeDomains: freeHostnames,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  for (const m of mirrors) {
    // Defense-in-depth: tavilySearch already excludes paywalled outlets via
    // include_domains, but the post-fetch isApprovedSource check would still
    // accept a paywalled URL returned by mistake.
    if (isHardPaywallSource(m.url)) continue;
    if (!withinMirrorDateWindow(paywalled.publicationDate, m.publicationDate)) continue;
    return m;
  }
  return null;
}

// Map paywalled candidates to their free-outlet mirrors. Free entries pass
// through. Mirror lookups run in parallel; the result is deduped by URL since
// a mirror might already exist in the pool from another beat query.
export async function substitutePaywallMirrors(
  candidates: Candidate[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const resolved = await Promise.all(
    candidates.map(async (c) => {
      if (!isHardPaywallSource(c.url)) return c;
      const mirror = await findFreeMirror(c, signal);
      if (mirror) {
        console.log(
          JSON.stringify({
            event: 'orchestrator.paywall_mirror.substituted',
            paywalledUrl: c.url,
            mirrorUrl: mirror.url,
          }),
        );
      } else {
        console.warn(
          JSON.stringify({
            event: 'orchestrator.paywall_mirror.dropped',
            paywalledUrl: c.url,
            title: c.title.slice(0, 120),
          }),
        );
      }
      return mirror;
    }),
  );

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of resolved) {
    if (!c || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

// The show's beat — Israel, Jews, and the Middle East — as durable thematic
// queries. Deliberately broad and evergreen: outlet-scoping (include_domains)
// and the freshness window do the narrowing, and distillTopics scores the
// survivors downstream. No event-specific terms ("hostages", "Gaza war") —
// those go stale and would need constant re-tuning. Query *count* per theme
// doubles as the weighting knob: discoverCandidates merges these round-robin,
// so the three Israel queries hand the show's core beat ~1/3 of the triaged
// pool. Tune the set here if coverage gaps show up. X/Twitter is intentionally
// absent — it comes in through `discoverXPosts`.
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
  const days = freshnessDays(today);
  // Topic gathers (/start topics, /topics, /refetch) pass the topic as
  // extraGuidance — search for exactly that. Plain discovery fans out across
  // the show's beat.
  const queries = extraGuidance.trim() ? [extraGuidance.trim()] : DISCOVERY_QUERIES;

  const settled = await Promise.allSettled(
    queries.map((query) =>
      tavilySearch({
        query,
        maxResults: DISCOVERY_RESULTS_PER_QUERY,
        days,
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
    // Sort each query's hits newest-first before the round-robin merge below.
    // Tavily ranks results by relevance, not date, so yesterday's top story
    // can sit at index 0 of multiple lists and crowd out today's coverage
    // before gatherCandidates hits its 20-article cap. YYYY-MM-DD compares
    // correctly as a string; null-dated entries sort below the oldest dated
    // one (a deliberate trade — freshness wins over preserving Tavily's
    // relevance order for undated stragglers).
    const sorted = [...s.value].sort((a, b) => {
      const da = a.publicationDate ?? '';
      const db = b.publicationDate ?? '';
      return db.localeCompare(da);
    });
    lists.push(sorted);
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

  // Hard-paywall articles (WSJ, NYT, WaPo, FT) can't be extracted; swap them for
  // free-outlet mirrors before the survivors hit triage. See
  // substitutePaywallMirrors above.
  return substitutePaywallMirrors(merged, signal);
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

// Recency-scoped approved-outlet search. Like a keyword search but bounded to the
// last `days`, so results skew to fresh developments rather than the most
// relevant all-time coverage. Used by the breaking scan's per-story follow-up
// discovery, where the point is "what's the latest on this story", not a general
// lookup.
export async function searchRecentApproved(
  query: string,
  opts: { days: number; maxResults?: number; signal?: AbortSignal },
): Promise<Candidate[]> {
  return tavilySearch({
    query,
    maxResults: opts.maxResults ?? 6,
    days: opts.days,
    signal: opts.signal,
  });
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
