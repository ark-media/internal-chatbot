import { generateText, type Tool } from 'ai';
import { google } from '@ai-sdk/google';

import { ensureEnglish } from '../translate';
import { cacheKey, getCached, setCached } from '../tool-cache';
import { newsContextForDate } from '../news-prompt';
import { newsSources } from '../news-sources';
import type { Article } from './types';

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
- Reputable outlets, especially: ${outletList}
- A mix of perspectives where the story is contested

${extraGuidance ? `Additional guidance from the writer:\n${extraGuidance}\n` : ''}For each article return a strict JSON array. No prose, no markdown fencing — just valid JSON. Each element:

{ "title": string, "url": string, "publicationDate": "YYYY-MM-DD" or null, "source": string }

Use the google_search tool to find articles. Cite real URLs only.`;

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
    ...newsSources.englishSites.slice(0, 6),
    ...newsSources.hebrewSites.slice(0, 4),
    ...newsSources.xAccounts.slice(0, 4).map((a) => a.handle),
  ].join(', ');

  const prompt = DISCOVERY_PROMPT(today, dateContext, outletList, extraGuidance);

  // @ai-sdk/google's googleSearch tool returns Tool<{}, never> which doesn't
  // satisfy ai v6's stricter Tool<never, never> tools-record constraint —
  // narrow the cast rather than disabling type checking on the whole call.
  const googleSearchTool = google.tools.googleSearch({}) as unknown as Tool;
  const { text } = await generateText({
    model: google('gemini-2.5-flash'),
    tools: { google_search: googleSearchTool },
    prompt,
    temperature: 0.2,
  });
  return parseCandidates(text);
}

// -- Public API --------------------------------------------------------------

function inAcceptableRange(today: string, publicationDate: string | null): boolean {
  if (!publicationDate) return false;
  const todayDate = new Date(today);
  const yesterday = new Date(todayDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const dayBefore = new Date(todayDate);
  dayBefore.setDate(dayBefore.getDate() - 2);
  const isMonday = todayDate.getDay() === 1;

  const pub = publicationDate.slice(0, 10);
  const yStr = yesterday.toISOString().slice(0, 10);
  if (pub === yStr) return true;
  if (isMonday && pub === dayBefore.toISOString().slice(0, 10)) return true;
  if (isMonday && pub === today.slice(0, 10)) return true;
  return false;
}

export async function gatherSources(opts: {
  today: string;
  timezone?: string;
  extraGuidance?: string;
  maxArticles?: number;
}): Promise<Article[]> {
  const { today, extraGuidance = '', maxArticles = 15 } = opts;
  const dateContext = newsContextForDate(today);

  const candidates = await discoverCandidates(today, dateContext, extraGuidance);
  if (candidates.length === 0) return [];

  // Dedupe by URL, cap before extraction (Tavily charges per call).
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
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
