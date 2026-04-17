/**
 * Ad-hoc retrieval inspector. Useful for iterating on chunk size, rerank, etc.
 *
 * Usage:
 *   pnpm eval:inspect "What has Nadav Eyal said about the Houthis recently?"
 */

import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(__dirname, '..', '.env.local') });

import { lookupCorpus } from '../lib/retrieval';

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('usage: pnpm eval:inspect <query>');
    process.exit(1);
  }

  const chunks = await lookupCorpus({ query, finalK: 8 });
  if (chunks.length === 0) {
    console.log('(no results)');
    return;
  }
  for (const c of chunks) {
    console.log(
      `[${c.chunkId}] score=${c.score.toFixed(3)} ${c.showName} · ${c.date ?? '?'} · ${c.section ?? '?'}`,
    );
    console.log(`      ${c.title}`);
    console.log(`      ${c.text.slice(0, 180).replace(/\n/g, ' ')}...\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
