import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { getNewsExamplesForBlock, newsSystemPrompt } from './news-prompt';

// The 2026-07 scriptwriter redesign split newsSystemPrompt's template into
// exported section constants (SIX_DIMENSIONS, CONTRACT_SEMANTICS, SCOPE_RULES,
// NEWS_CORE_A/B/C, ...) so the scriptwriter can reuse them. These hashes pin the
// assembled prompt so the news chat's behavior — and its prompt cache — cannot
// drift as a side effect of editing a shared section. If you intentionally edit
// the prompt text, re-baseline the affected hash IN THE SAME COMMIT and say why
// here; a stale hash is the guard working, not noise to silence.
//
// - chat: re-baselined 2026-07-28. The chat prompt is one stable string again:
//   the per-task prompt variants (one cache key per detected intent) were
//   collapsed back into a single prompt carrying every workflow module, because
//   per-turn variants invalidated the cached prefix — and the conversation
//   history behind it — on every intent switch. The per-turn Active Request
//   Mode note now rides after the history, outside the cached prefix.
// - orchestrator: unchanged through the whole redesign.
const EXPECTED_SHA256 = {
  chat: 'd8c42f0fbb7df4a9e8bed850dca613b328d38bfa4ba5d40ef52e5a78a61ae514',
  orchestrator: 'f29ab50f8218f3952225e058ac3f7ff09dccab3b0d978db1dba89dea5e7ae48c',
} as const;

describe('newsSystemPrompt byte identity', () => {
  it.each(['chat', 'orchestrator'] as const)('%s mode matches the recorded baseline', (mode) => {
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
