// X (Twitter) API v2 — recent posts from the 15 approved X/Twitter handles.
//
// This replaces the old grounded-Gemini `discoverXPosts`, which couldn't
// reliably surface recent, canonical status URLs: Google's index of X is thin
// and laggy (X blocks crawlers), so Gemini returned redirect/hallucinated URLs
// that filtered to zero. The official API is the source of truth — real status
// IDs, real timestamps, no hallucination.
//
// ⚠ SCAFFOLD — NOT YET EXERCISED AGAINST A LIVE KEY. Written against the X API
// v2 docs (https://docs.x.com/x-api). There is no API key yet, so:
//   - `isXApiConfigured()` returns false,
//   - the /x-posts route returns `not_configured`, and
//   - the triage UI shows a disabled "Coming soon" button.
// To go live:
//   1. set `X_API_BEARER_TOKEN` in the deployment env (App-only Bearer token),
//   2. flip `X_POSTS_ENABLED` in the orchestrator page,
//   3. verify the response-shape assumptions in this file against the live API.
//
// Endpoints (App-only Bearer auth):
//   GET /2/users/by?usernames=...   handle → numeric id (ids are stable; cached)
//   GET /2/users/:id/tweets         recent posts for one handle, since start_time

import { newsSources } from './news-sources';
import { freshnessWindow } from './orchestrator/source-gathering';
import type { Candidate } from './orchestrator/types';

// Also reachable at api.twitter.com; api.x.com is the current host.
const X_API_BASE = 'https://api.x.com';

// Per-handle page size for the timeline endpoint. The API caps this at 100;
// `start_time` already scopes results to the freshness window, so one page
// covers all but the most prolific accounts — pagination handles the rest.
const TIMELINE_PAGE_SIZE = 100;

// Hard cap on timeline pages per handle, so a runaway account (or a bad
// `start_time`) can't fan out into hundreds of billed reads.
const MAX_TIMELINE_PAGES = 5;

// Tweets have no title; `Candidate.title` is the triage list's link text, so
// collapse the tweet body to one line and truncate it to stay scannable.
const TITLE_MAX_LEN = 140;

// Replies and retweets are excluded — the briefing wants original posts and
// analysis from the handle, not its reply threads or amplifications. Tunable
// if coverage feels thin (X API v2 `exclude` accepts `replies`, `retweets`).
const TIMELINE_EXCLUDE = 'replies,retweets';

type XUser = { id: string; name: string; username: string };
type XTweet = { id: string; text: string; created_at?: string };
type XUsersByResponse = {
  data?: XUser[];
  errors?: Array<{ value?: string; title?: string }>;
};
type XTimelineResponse = {
  data?: XTweet[];
  meta?: { next_token?: string; result_count?: number };
};

type Account = { handle: string; name: string; role: string; bare: string };

export function isXApiConfigured(): boolean {
  return !!process.env.X_API_BEARER_TOKEN;
}

// One authenticated GET against the X API. Non-2xx responses throw with the
// status and a snippet of the body so the route's catch can report the real
// failure (bad token → 401, rate limited → 429, etc.).
async function xGet<T>(
  path: string,
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<T> {
  const token = process.env.X_API_BEARER_TOKEN;
  if (!token) throw new Error('X_API_BEARER_TOKEN missing');

  const resp = await fetch(`${X_API_BASE}${path}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(
      `X API ${resp.status} on ${path}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  return resp.json() as Promise<T>;
}

// Handle → numeric id. X user ids never change, so a process-lifetime cache is
// safe — on Fluid Compute the instance is reused across requests, so most pulls
// skip the resolution call entirely.
const idCache = new Map<string, string>();

async function resolveHandleIds(
  bareHandles: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const h of bareHandles) {
    const key = h.toLowerCase();
    const cached = idCache.get(key);
    if (cached) resolved.set(key, cached);
    else missing.push(h);
  }
  if (missing.length === 0) return resolved;

  // /2/users/by takes up to 100 usernames per call — 15 handles is one call.
  const params = new URLSearchParams({ usernames: missing.join(',') });
  const body = await xGet<XUsersByResponse>('/2/users/by', params, signal);

  for (const u of body.data ?? []) {
    const key = u.username.toLowerCase();
    idCache.set(key, u.id);
    resolved.set(key, u.id);
  }
  // A renamed or suspended handle comes back in `errors`. Log it, don't throw —
  // one bad handle shouldn't sink the pull for the other 14.
  for (const e of body.errors ?? []) {
    console.warn(
      JSON.stringify({ event: 'x_api.handle_unresolved', value: e.value, title: e.title }),
    );
  }
  return resolved;
}

// Tweet body → a one-line, length-capped title for the triage list.
function toTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > TITLE_MAX_LEN
    ? `${oneLine.slice(0, TITLE_MAX_LEN - 1)}…`
    : oneLine;
}

function tweetToCandidate(account: Account, tweet: XTweet): Candidate {
  return {
    title: toTitle(tweet.text),
    url: `https://x.com/${account.bare}/status/${tweet.id}`,
    source: account.name || account.bare,
    // `created_at` is a UTC ISO timestamp; the calendar-date slice matches how
    // the rest of the orchestrator stores `publicationDate`. The route re-flags
    // freshness against the run's writer-local window via `inAcceptableRange`.
    publicationDate: tweet.created_at ? tweet.created_at.slice(0, 10) : null,
  };
}

// One handle's posts since `startTime`, following pagination up to the page
// cap. Results come back newest-first and `start_time` bounds the low end, so
// the cap is just a safety valve against an unexpectedly chatty account.
async function fetchHandleTimeline(
  account: Account,
  id: string,
  startTime: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_TIMELINE_PAGES; page++) {
    const params = new URLSearchParams({
      'tweet.fields': 'created_at',
      max_results: String(TIMELINE_PAGE_SIZE),
      exclude: TIMELINE_EXCLUDE,
      start_time: startTime,
    });
    if (pageToken) params.set('pagination_token', pageToken);

    const body = await xGet<XTimelineResponse>(
      `/2/users/${id}/tweets`,
      params,
      signal,
    );
    for (const tweet of body.data ?? []) {
      out.push(tweetToCandidate(account, tweet));
    }
    pageToken = body.meta?.next_token;
    if (!pageToken) break;
  }
  return out;
}

// Recent posts from the 15 approved X/Twitter handles, within the run's
// freshness window. Resolves handle ids (cached), then fans the per-handle
// timeline calls out in parallel. Mirrors `discoverCandidates`' error policy:
// a partial failure returns what came back; an all-fail surfaces the real
// error so the route can report it instead of a misleading empty list.
export async function discoverXPostsViaApi(
  today: string,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  if (!isXApiConfigured()) {
    // The route guards on `isXApiConfigured()` before calling this, so reaching
    // here is a programming error — fail loudly rather than returning [].
    throw new Error('X API is not configured — set X_API_BEARER_TOKEN');
  }

  // `freshnessWindow` is newest-first; the last entry is the earliest
  // acceptable date. `start_time` must be an ISO 8601 timestamp — anchoring at
  // 00:00Z is slightly wider than the writer-local day boundary, which only
  // means a few extra posts that `inAcceptableRange` then flags downstream.
  const window = freshnessWindow(today);
  const startTime = `${window[window.length - 1]}T00:00:00Z`;

  const accounts: Account[] = newsSources.xAccounts.map((a) => ({
    ...a,
    bare: a.handle.replace(/^@/, ''),
  }));
  const ids = await resolveHandleIds(
    accounts.map((a) => a.bare),
    signal,
  );
  const resolved = accounts.filter((a) => ids.has(a.bare.toLowerCase()));

  const settled = await Promise.allSettled(
    resolved.map((a) =>
      fetchHandleTimeline(a, ids.get(a.bare.toLowerCase())!, startTime, signal),
    ),
  );

  const hits: Candidate[] = [];
  let anyFulfilled = false;
  let lastError: unknown = null;
  for (const s of settled) {
    if (s.status === 'rejected') {
      // A cancelled pull surfaces here as a rejection — propagate it instead of
      // burying it as one handle's bad luck.
      if (signal?.aborted) throw s.reason;
      lastError = s.reason;
      console.warn(
        JSON.stringify({
          event: 'x_api.timeline_error',
          err: String(s.reason).slice(0, 300),
        }),
      );
      continue;
    }
    anyFulfilled = true;
    hits.push(...s.value);
  }

  // Every handle's call failed (bad token, X API down) — surface it. A
  // fulfilled-but-empty run is a genuine "nobody posted in the window": [].
  if (!anyFulfilled && lastError) throw lastError;

  // Dedupe by URL (defensive — pagination shouldn't repeat a tweet).
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const h of hits) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    deduped.push(h);
  }

  console.log(
    JSON.stringify({
      event: 'x_api.discover',
      handlesRequested: accounts.length,
      handlesResolved: resolved.length,
      postCount: deduped.length,
    }),
  );
  return deduped;
}
