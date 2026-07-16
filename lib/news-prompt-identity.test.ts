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
// - orchestrator: still byte-identical to the pre-refactor output.
// - chat: re-baselined 2026-07-16 for fd80835, which deliberately added the
//   Human-interest tier to the scanBreakingNews flow (the tier list, plus its
//   "treat exactly like a Swap into the C-block close" handling) inside
//   CHAT_TOOLS_AND_VALIDATION. That commit changed the text without moving the
//   hash, so this guard failed until re-baselined here. The edit is chat-only,
//   which is why the orchestrator hash never moved.
const EXPECTED_SHA256 = {
  chat: '2456972d11f07d95350a6ccc7a6cd250cde22c117c95238b4bd362920f8422a2',
  orchestrator: '50a26086d7b81f170380d9fd42a71cb3e36f118b9e707985e411abaabf1e4700',
} as const;

describe('newsSystemPrompt byte identity', () => {
  it.each(['chat', 'orchestrator'] as const)('%s mode matches the recorded baseline', (mode) => {
    const hash = createHash('sha256').update(newsSystemPrompt(mode)).digest('hex');
    expect(hash).toBe(EXPECTED_SHA256[mode]);
  });

  // The Human-interest tier is a chat-only breaking-scan concern. If it ever
  // shows up in the orchestrator prompt, a shared section absorbed an edit that
  // was meant for CHAT_TOOLS_AND_VALIDATION — which is the exact drift the
  // hashes above exist to catch, stated in a form that names the culprit.
  it('keeps the Human-interest tier out of the orchestrator prompt', () => {
    expect(newsSystemPrompt('chat')).toContain('Human-interest');
    expect(newsSystemPrompt('orchestrator')).not.toContain('Human-interest');
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
