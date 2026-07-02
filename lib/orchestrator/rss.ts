// RSS discovery for the breaking-news scan. Polls a small allowlist of outlet
// feeds and maps their items to Candidates that flow into the same gates as
// Tavily/X discovery. Two roles:
//   - 'beat'  feeds carry Israel / Middle East coverage → on-beat Swap/Update.
//   - 'world' feeds carry global coverage so a global-shock event elsewhere (a
//     natural disaster, mass-casualty terror attack, head-of-state death, war
//     between major powers, a US constitutional shock) has an entry path to the
//     Can't-ignore tier via Gate 3's globalShock grading.
//
// RSS items are NOT run through Tavily extraction: the scan's gates classify
// from headline + source + date, and the feed already hands us a real article
// URL and a precise publish timestamp. That timestamp is RFC-2822 (same shape
// Tavily Extract returns), so breaking-scan's filterByCutoff compares it at
// instant granularity — a story that published this morning, before the lock,
// is dropped rather than kept as "same day".

import { isApprovedSource } from '../news-sources';
import type { Candidate } from './types';

// Feeds verified to be live, fresh, and timestamped. Every item domain here is
// an approved source; items are re-checked against isApprovedSource regardless,
// as a belt-and-suspenders backstop. Grow this list only with feeds confirmed
// to return current items with per-item pubDates.
export const RSS_FEEDS: ReadonlyArray<{ url: string; source: string; role: 'beat' | 'world' }> = [
  { url: 'https://www.timesofisrael.com/feed/', source: 'Times of Israel', role: 'beat' },
  { url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', source: 'BBC', role: 'beat' },
  { url: 'https://www.theguardian.com/world/israel/rss', source: 'The Guardian', role: 'beat' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC', role: 'world' },
  { url: 'https://www.theguardian.com/world/rss', source: 'The Guardian', role: 'world' },
];

// Cap items taken per feed (newest first) so a high-volume world feed can't
// balloon the candidate pool or the gate prompts. The cutoff filter trims
// further downstream; this just bounds the pre-filter fetch.
const MAX_ITEMS_PER_FEED = 15;
const FETCH_TIMEOUT_MS = 8000;

export type RssItem = { title: string; link: string; pubDate: string | null };

// Unwrap a CDATA section if the tag content is wrapped in one.
function stripCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}

// Decode the XML entities that appear in feed titles/links: the named five plus
// decimal (`&#8217;`) and hex (`&#x2019;`) numeric character references, which
// ToI's feed uses heavily for curly quotes, dashes, and ellipses. `&amp;` is
// decoded last so an already-encoded entity isn't double-decoded.
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// Guard fromCodePoint against out-of-range values in malformed feeds: emit the
// replacement character rather than throwing.
function codePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�';
}

// First `<tag>…</tag>` (or a namespaced `<ns:tag>`) content within a block,
// CDATA-unwrapped and trimmed; '' when absent.
function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  return m ? stripCdata(m[1]).trim() : '';
}

// Parse RSS 2.0 `<item>` blocks into title/link/pubDate. Deliberately narrow —
// the scan's feeds are all RSS 2.0, so this pulls the three fields the gates
// need rather than pulling in a general XML parser. Atom (`<entry>` with
// `<link href>`) is not handled; add feeds only in RSS 2.0 form. Items with no
// resolvable link are skipped.
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const link = decodeXml(pickTag(block, 'link'));
    if (!link) continue;
    const title = decodeXml(pickTag(block, 'title')) || '(untitled)';
    const pubDate = pickTag(block, 'pubDate') || pickTag(block, 'dc:date') || null;
    items.push({ title, link, pubDate });
  }
  return items;
}

// Normalize a feed link to a clean article URL: drop the tracking query string
// and fragment feeds append (e.g. BBC's ?at_medium=RSS). Article URLs on these
// outlets are path-based, so this is safe and improves dedup. null on unparseable.
function cleanUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// Map parsed feed items to Candidates: clean each URL, keep only approved
// sources, and dedupe by URL across all feeds (a story carried by both a beat
// and a world feed collapses to one). Pure so it can be unit-tested without
// network. publicationDate is the raw feed timestamp — filterByCutoff parses it.
export function rssItemsToCandidates(
  feeds: Array<{ source: string; items: RssItem[] }>,
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const { source, items } of feeds) {
    for (const it of items) {
      const url = cleanUrl(it.link);
      if (!url || seen.has(url) || !isApprovedSource(url)) continue;
      seen.add(url);
      out.push({ title: it.title, url, source, publicationDate: it.pubDate });
    }
  }
  return out;
}

async function fetchFeed(url: string, signal?: AbortSignal): Promise<RssItem[]> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const resp = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (ArkNewsDaily breaking-scan)' },
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!resp.ok) throw new Error(`RSS ${resp.status}`);
  return parseRssItems(await resp.text());
}

// Fetch the allowlisted feeds concurrently and return deduped, approved
// Candidates. A single feed's failure (timeout, 404, malformed XML) is logged
// and skipped rather than sinking the whole scan; a caller-initiated abort
// propagates. Injectable `feeds` for testing.
export async function discoverRssCandidates(
  opts: { signal?: AbortSignal; feeds?: typeof RSS_FEEDS } = {},
): Promise<Candidate[]> {
  const feeds = opts.feeds ?? RSS_FEEDS;
  const fetched = await Promise.all(
    feeds.map(async (f) => {
      try {
        const items = await fetchFeed(f.url, opts.signal);
        return { source: f.source, items: items.slice(0, MAX_ITEMS_PER_FEED) };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        console.warn(`[rss] feed failed, skipping: ${f.url} — ${String(err).slice(0, 120)}`);
        return { source: f.source, items: [] as RssItem[] };
      }
    }),
  );
  return rssItemsToCandidates(fetched);
}
