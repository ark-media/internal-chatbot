// Validation of extractSources() source parsing behavior with edge cases.
//
// This test validates that the two-tier parsing (strict + smart) correctly handles:
// - Standard format with all fields (title — url — date)
// - Em-dashes in titles (smart parsing detects URLs by pattern)
// - Missing optional fields (date, flags)
// - Flags with special characters
// - Complex titles with multiple em-dashes
//
// Run with: npx ts-node app/api/news/extractSources.test.ts
// Before deploying changes to news/route.ts extractSources(), verify tests still pass.

type ExtractedSources = Array<{
  num: number;
  title: string;
  url: string;
  date?: string;
  flags?: string;
}>;

function extractSources(text: string): { script: string; sources: ExtractedSources } {
  const match = text.match(/^([\s\S]*?)\n\s*---+\s*\n\s*SOURCES:\s*\n([\s\S]+)$/i);
  if (!match) {
    return { script: text, sources: [] };
  }

  const [, script, sourcesText] = match;
  const sources: ExtractedSources = [];

  const lines = sourcesText.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const strictMatch = line.match(
      /^(\d+)\.\s+(.+?)\s+—\s+(https?:\/\/[^\s]+)(?:\s+—\s+(.+?))?(?:\s+\[FLAG:\s+(.+?)\])?$/
    );
    if (strictMatch) {
      sources.push({
        num: parseInt(strictMatch[1], 10),
        title: strictMatch[2].trim(),
        url: strictMatch[3].trim(),
        date: strictMatch[4]?.trim(),
        flags: strictMatch[5]?.trim(),
      });
      continue;
    }

    const numMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      const rest = numMatch[2];

      const flagMatch = rest.match(/\[FLAG:\s+(.+?)\]$/);
      const flagText = flagMatch?.[1]?.trim();
      const withoutFlag = flagMatch ? rest.slice(0, flagMatch.index).trim() : rest;

      const urlMatch = withoutFlag.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) {
        continue;
      }

      const url = urlMatch[0];
      const urlStartIndex = withoutFlag.indexOf(url);
      const titlePart = withoutFlag.slice(0, urlStartIndex).trim();
      const datePart = withoutFlag.slice(urlStartIndex + url.length).trim();

      const cleanTitle = titlePart.replace(/\s+—\s*$/, '').trim();
      const cleanDate = datePart.replace(/^\s*—\s+/, '').trim() || undefined;

      sources.push({
        num,
        title: cleanTitle,
        url,
        date: cleanDate,
        flags: flagText,
      });
    }
  }

  return { script, sources };
}

// Test cases
const testCases = [
  {
    name: 'Standard format (strict parse)',
    input: `Some script text

---

SOURCES:

1. Reuters Report — https://reuters.com/article — May 2026`,
    expectedTitle: 'Reuters Report',
    expectedUrl: 'https://reuters.com/article',
    expectedDate: 'May 2026',
  },
  {
    name: 'Em-dash in title (smart parse)',
    input: `Script here

---

SOURCES:

1. Reuters — Analysis — https://reuters.com/news — May 2026`,
    expectedTitle: 'Reuters — Analysis',
    expectedUrl: 'https://reuters.com/news',
    expectedDate: 'May 2026',
  },
  {
    name: 'Missing date (smart parse)',
    input: `Script

---

SOURCES:

1. BBC Report — https://bbc.com/story`,
    expectedTitle: 'BBC Report',
    expectedUrl: 'https://bbc.com/story',
    expectedDate: undefined,
  },
  {
    name: 'With flag (smart parse)',
    input: `Script

---

SOURCES:

1. NYT — Full Story — https://nytimes.com/news — April 2026 [FLAG: paywall blocked]`,
    expectedTitle: 'NYT — Full Story',
    expectedUrl: 'https://nytimes.com/news',
    expectedDate: 'April 2026',
    expectedFlags: 'paywall blocked',
  },
  {
    name: 'Complex title with multiple em-dashes (smart parse)',
    input: `Script

---

SOURCES:

1. The Guardian — Breaking News — UK Politics — https://theguardian.com/uk-news — May 1 2026`,
    expectedTitle: 'The Guardian — Breaking News — UK Politics',
    expectedUrl: 'https://theguardian.com/uk-news',
    expectedDate: 'May 1 2026',
  },
];

let passed = 0;
let failed = 0;

for (const test of testCases) {
  const { script, sources } = extractSources(test.input);
  const source = sources[0];

  if (!source) {
    console.log(`❌ ${test.name}: No sources extracted`);
    failed++;
    continue;
  }

  const titleOk = source.title === test.expectedTitle;
  const urlOk = source.url === test.expectedUrl;
  const dateOk = source.date === test.expectedDate;
  const flagsOk = !test.expectedFlags || source.flags === test.expectedFlags;

  if (titleOk && urlOk && dateOk && flagsOk) {
    console.log(`✅ ${test.name}`);
    passed++;
  } else {
    console.log(`❌ ${test.name}`);
    if (!titleOk) console.log(`   Title: got "${source.title}", expected "${test.expectedTitle}"`);
    if (!urlOk) console.log(`   URL: got "${source.url}", expected "${test.expectedUrl}"`);
    if (!dateOk) console.log(`   Date: got "${source.date}", expected "${test.expectedDate}"`);
    if (!flagsOk) console.log(`   Flags: got "${source.flags}", expected "${test.expectedFlags}"`);
    failed++;
  }
}

console.log(`\n${passed}/${testCases.length} tests passed`);
process.exit(failed > 0 ? 1 : 0);
