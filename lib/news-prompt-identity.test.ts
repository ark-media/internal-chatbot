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
//   Re-baselined again same day: the newschat eval's clean-output gate failed
//   at 0.778 (target 0.9) because the writer appended trailing [FLAG] notes
//   narrating its own sourcing decisions — the evidence-contract bullet now
//   pins FLAG content (evidence gap only) and placement (inline where spoken
//   or beside the SOURCES entry, never a trailing note).
//   Re-baselined 2026-07-29 after a Michigan-primary chat shipped a pronoun
//   misattribution and a false "combined" figure past the readback, then
//   confabulated a derivation when challenged: readback dimensions 1 and 6
//   now verify the sentence around each claim/figure (subject, action,
//   direction; no self-computed sums presented as sourced totals), and a new
//   non-negotiable requires re-opening the source and quoting it before
//   answering a writer's challenge or proposing a fix.
//   Re-baselined again 2026-07-29: comparing chat drafts against the aired
//   Michigan-primary block showed the depth guidance never reached chat mode.
//   The Script Draft Workflow now carries "explain, don't just present" for
//   people as well as events, "draw connections within our coverage", a
//   block-agnostic standards note (an unlabeled block gets every best
//   practice), and the contest-story shape (a one-line frame earned by the
//   block's reporting, an early clip — ambient scene audio counts — the
//   trigger stated plainly, per-side voice and numbers, and a close on the
//   date and the question the result answers, bookending the opening frame).
//   Re-baselined again 2026-07-29: comparing a chat draft against the aired
//   Trump–Netanyahu block showed two gaps. The Script Draft Workflow now
//   distinguishes writer questions ("is this worth including?") from contract
//   beats — investigate, answer in the readback with a recommendation, and
//   only include what earns its place — and adds the thin-trigger story
//   shape: when the writer flags the trigger as short on details, open on
//   the strongest sourced surrounding development, land the trigger
//   mid-block with only what is knowable (logistics, each side's
//   characterization, the telling absence), set one sourced note of
//   friction against a glowing readout, and close on the agreed point or
//   the next concrete thing to watch.
// - orchestrator: unchanged through the whole redesign.
const EXPECTED_SHA256 = {
  chat: '5b88e75c11429083f8d4214830dccf710807fa334f53a2e7d82f54056f9e8c8f',
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
