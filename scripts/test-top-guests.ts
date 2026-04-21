import { listTopGuests } from '../lib/retrieval';
import { sql } from '../lib/db';

async function main() {
  const rows = (await sql`
    SELECT show_id FROM shows WHERE LOWER(name) = 'call me back'
  `) as unknown as Array<{ show_id: number }>;
  const cmbId = rows[0]?.show_id;
  if (!cmbId) throw new Error('Call me Back not found');

  const result = await listTopGuests({
    filters: { showIds: [cmbId] },
    limit: 10,
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('\n--- Summary ---');
  for (const r of result) {
    console.log(
      `${r.rank}. ${r.speakerName} — ${r.episodeCount} episodes`,
    );
    for (const ep of r.episodes) {
      console.log(`    • ${ep.date ?? '????-??-??'} — ${ep.title}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
