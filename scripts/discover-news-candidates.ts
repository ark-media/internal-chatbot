/**
 * Dumps the raw Gemini discovery output for the news orchestrator — the list
 * of article candidates Gemini surfaces *before* approval filtering, URL
 * verification, and Tavily extraction. Use it to preview what a run would
 * pull right now without spending Tavily calls.
 *
 * Prints to the terminal and writes `scripts/articles.json` next to this file.
 *
 * Usage:
 *   tsx scripts/discover-news-candidates.ts
 *   tsx scripts/discover-news-candidates.ts "focus on the Lebanon ceasefire"
 *
 * The optional argument is passed through as `extraGuidance` — the same field
 * the orchestrator uses for topic-specific gathers.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(__dirname, '..', '.env.local') });

// Mirrors `todayISO()` in the orchestrator page: local-calendar YYYY-MM-DD.
const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

async function main() {
  const extraGuidance = process.argv.slice(2).join(' ').trim();
  const today = todayISO();

  // Dynamic imports so `.env.local` is loaded before these modules evaluate —
  // `source-gathering` transitively pulls in `lib/db`, which throws at import
  // time if `DATABASE_URL` is unset.
  const { discoverCandidates, freshnessContext } = await import(
    '../lib/orchestrator/source-gathering'
  );
  const { isApprovedSource } = await import('../lib/news-sources');

  console.log(`Discovering candidates for ${today}`);
  if (extraGuidance) console.log(`Extra guidance: ${extraGuidance}`);
  console.log(
    '(raw Gemini output — before approval filter / URL verify / extraction)\n',
  );

  const candidates = await discoverCandidates(
    today,
    freshnessContext(today),
    extraGuidance,
  );

  const articles = candidates.map((c) => ({
    title: c.title,
    url: c.url,
    source: c.source,
    publicationDate: c.publicationDate,
    approved: isApprovedSource(c.url),
  }));

  const outPath = resolve(__dirname, 'articles.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      { today, extraGuidance: extraGuidance || null, count: articles.length, articles },
      null,
      2,
    ) + '\n',
  );

  if (articles.length === 0) {
    console.log('No candidates returned.');
    console.log(`\nWrote ${outPath}`);
    return;
  }

  articles.forEach((a, i) => {
    console.log(`${i + 1}. ${a.title}`);
    console.log(`   ${a.url}`);
    console.log(
      `   ${a.source} · ${a.publicationDate ?? 'no date'}` +
        (a.approved ? '' : ' · ⚠ NOT on approved list — would be dropped'),
    );
    console.log('');
  });

  const approvedCount = articles.filter((a) => a.approved).length;
  console.log(
    `${articles.length} candidates — ${approvedCount} approved, ` +
      `${articles.length - approvedCount} would be dropped by the approval filter.`,
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
