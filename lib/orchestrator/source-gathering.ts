import { generateText, type Tool } from 'ai';
import { google } from '@ai-sdk/google';

import { ensureEnglish } from '../translate';
import { cacheKey, getCached, setCached } from '../tool-cache';
import { isApprovedSource, newsSources } from '../news-sources';
import type { Article } from './types';

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

function freshnessContext(today: string): string {
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

async function extractArticle(url: string): Promise<ExtractResult> {
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

    const text = await ensureEnglish(r.raw_content ?? '');
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
    return { ok: false, note: String(err).slice(0, 200) };
  }
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

async function discoverCandidates(
  today: string,
  dateContext: string,
  extraGuidance: string,
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
    temperature: 0.2,
  });
  return parseCandidates(text);
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

export async function gatherSources(opts: {
  today: string;
  timezone?: string;
  extraGuidance?: string;
  maxArticles?: number;
}): Promise<Article[]> {
  const { today, extraGuidance = '', maxArticles = 15 } = opts;
  const dateContext = freshnessContext(today);

  const candidates = await discoverCandidates(today, dateContext, extraGuidance);
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

  const extracted = await Promise.all(
    deduped.map(async (c): Promise<Article> => {
      const result = await extractArticle(c.url);
      const isFlagged = !inAcceptableRange(today, c.publicationDate);
      if (!result.ok) {
        return {
          title: c.title,
          url: c.url,
          publicationDate: c.publicationDate,
          source: c.source,
          content: '',
          isFlagged,
          fetchError: result.note,
        };
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

  return extracted;
}
