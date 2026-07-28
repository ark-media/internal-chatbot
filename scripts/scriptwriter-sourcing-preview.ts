/**
 * Live preview of the scriptwriter's Stage-1 sourcing: open-web discovery +
 * the story selector, printed without touching a run or burning Opus. Use it
 * to tune the beat queries and the selector prompt.
 *
 * Usage:
 *   tsx scripts/scriptwriter-sourcing-preview.ts                 # full-episode scope (3 stories)
 *   tsx scripts/scriptwriter-sourcing-preview.ts "Hormuz tolls"  # targeted single-block scope
 *
 * Writes `scripts/sourcing-preview.json` next to this file.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

// Dependency-free, so a static import here can't pull in lib/db before
// `.env.local` is loaded below.
import { todayISO } from '../lib/today-iso';

loadEnv({ path: resolve(__dirname, '..', '.env.local') });

async function main() {
  const storyHint = process.argv.slice(2).join(' ').trim();
  const today = todayISO();

  // Dynamic imports so `.env.local` is loaded before lib/db evaluates.
  const { discoverOpenWeb, rankAndSelect } = await import('../lib/scriptwriter/sourcing');
  const { getNewsExamples } = await import('../lib/news-prompt');
  const scope = storyHint
    ? ({ type: 'single', slot: 'B', storyHint } as const)
    : ({ type: 'episode' } as const);

  console.log(`Sourcing preview for ${today} — scope: ${scope.type}${storyHint ? ` ("${storyHint}")` : ''}\n`);

  const candidates = await discoverOpenWeb({ today, storyHint: storyHint || undefined });
  console.log(`Discovered ${candidates.length} open-web candidates.`);

  const examples = (await getNewsExamples()).slice(0, 8000);
  const selection = await rankAndSelect({ candidates, today, scope, examples });

  for (const s of selection.stories) {
    console.log(`\n[${s.blockSlot}] ${s.headline}  (${s.register})`);
    console.log(`    Angle: ${s.angle}`);
    console.log(`    Why:   ${s.rationale}`);
    for (const src of s.sources) {
      console.log(`    - [${src.credibility}] ${src.source} — ${src.title}`);
      console.log(`      ${src.url}`);
      console.log(`      ${src.credibilityNote}`);
    }
  }
  if (selection.backups.length > 0) {
    console.log('\nBackups:');
    for (const b of selection.backups) console.log(`  - ${b.headline}`);
  }

  const outPath = resolve(__dirname, 'sourcing-preview.json');
  writeFileSync(
    outPath,
    JSON.stringify({ today, scope, candidateCount: candidates.length, selection }, null, 2) + '\n',
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
