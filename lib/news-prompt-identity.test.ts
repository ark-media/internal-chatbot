import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { getNewsExamplesForBlock, newsSystemPrompt } from './news-prompt';

// The 2026-07 scriptwriter redesign split newsSystemPrompt's template into
// exported section constants (SIX_DIMENSIONS, CONTRACT_SEMANTICS, SCOPE_RULES,
// NEWS_CORE_A/B/C, ...) so the scriptwriter can reuse them. These hashes were
// captured from the pre-refactor output; the reassembled prompt must stay
// byte-identical so the news chat's behavior (and its prompt cache) is
// untouched. If you intentionally edit the prompt text, update the hashes.
const EXPECTED_SHA256 = {
  chat: '6cce3799fc195ab5551550003a81df27ecd705bb910fd964f94f3c7f82e76f7a',
  orchestrator: '50a26086d7b81f170380d9fd42a71cb3e36f118b9e707985e411abaabf1e4700',
} as const;

describe('newsSystemPrompt byte identity', () => {
  it.each(['chat', 'orchestrator'] as const)('%s mode matches the pre-refactor output', (mode) => {
    const hash = createHash('sha256').update(newsSystemPrompt(mode)).digest('hex');
    expect(hash).toBe(EXPECTED_SHA256[mode]);
  });
});

describe('getNewsExamplesForBlock', () => {
  it('returns only the requested block section', async () => {
    const a = await getNewsExamplesForBlock('A');
    expect(a).toMatch(/^## A BLOCKS/);
    expect(a).not.toContain('## B BLOCKS');
    expect(a).not.toContain('## C BLOCKS');
    expect(a).toContain('IRGC');

    const c = await getNewsExamplesForBlock('C');
    expect(c).toMatch(/^## C BLOCKS/);
    expect(c).toContain('Mel Brooks');
    expect(c).not.toContain('## A BLOCKS');
  });

  it('the three sections partition the examples body', async () => {
    const [a, b, c] = await Promise.all([
      getNewsExamplesForBlock('A'),
      getNewsExamplesForBlock('B'),
      getNewsExamplesForBlock('C'),
    ]);
    for (const section of [a, b, c]) {
      expect(section.length).toBeGreaterThan(500);
    }
  });
});
