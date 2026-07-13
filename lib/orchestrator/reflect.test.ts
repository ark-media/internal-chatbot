import { describe, expect, it, vi, beforeEach } from 'vitest';
import { generateObject } from 'ai';

vi.mock('ai', () => ({ generateObject: vi.fn() }));
vi.mock('./script-craft', () => ({ craftScript: vi.fn() }));

// Import AFTER the mocks are registered.
import { buildReviewerSystemContent, reflectLoop, truncateAtParagraph } from './reflect';
import { craftScript } from './script-craft';

const mockGen = vi.mocked(generateObject);
const mockCraft = vi.mocked(craftScript);

describe('truncateAtParagraph', () => {
  it('returns the input unchanged when shorter than the limit', () => {
    expect(truncateAtParagraph('short text', 100)).toBe('short text');
  });

  it('truncates at a paragraph boundary near the limit', () => {
    const text = 'a'.repeat(50) + '\n\n' + 'b'.repeat(50) + '\n\n' + 'c'.repeat(50);
    const result = truncateAtParagraph(text, 110);
    // Should cut at the second \n\n (index 102), leaving the first two paragraphs.
    expect(result).toBe('a'.repeat(50) + '\n\n' + 'b'.repeat(50));
  });

  it('falls back to a line boundary when no paragraph boundary is near enough', () => {
    const text = 'a'.repeat(80) + '\n' + 'b'.repeat(40);
    const result = truncateAtParagraph(text, 100);
    // No \n\n at all; nearest \n is at 80, which is > 0.6 * 100 = 60.
    expect(result).toBe('a'.repeat(80));
  });

  it('hard-cuts when no boundary is near enough', () => {
    const text = 'a'.repeat(200);
    const result = truncateAtParagraph(text, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toBe('a'.repeat(100));
  });

  it('never returns a string longer than the limit', () => {
    // Pathological case: limit just under the first paragraph boundary.
    const text = 'a'.repeat(200) + '\n\n' + 'b'.repeat(200);
    const result = truncateAtParagraph(text, 150);
    expect(result.length).toBeLessThanOrEqual(150);
  });
});

describe('buildReviewerSystemContent', () => {
  // Cache hit-rate on Opus calls depends on byte-stable output across
  // reflect iterations — these tests guard the determinism contract.
  const exampleScripts = 'EXAMPLE A\n\nEXAMPLE B';

  it('produces byte-identical output for identical inputs', async () => {
    const a = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: 'short sentences; active voice',
    });
    const b = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: 'short sentences; active voice',
    });
    expect(a).toBe(b);
  });

  it('omits the style block when styleProfile is empty, whitespace, or undefined', async () => {
    const undef = await buildReviewerSystemContent({ exampleScripts });
    const empty = await buildReviewerSystemContent({ exampleScripts, styleProfile: '' });
    const whitespace = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: '   \n  ',
    });
    expect(undef).not.toContain('WRITER STYLE PREFERENCES');
    expect(empty).not.toContain('WRITER STYLE PREFERENCES');
    expect(whitespace).not.toContain('WRITER STYLE PREFERENCES');
    expect(undef).toBe(empty);
    expect(undef).toBe(whitespace);
  });

  it('includes the style block when styleProfile has content', async () => {
    const result = await buildReviewerSystemContent({
      exampleScripts,
      styleProfile: 'short sentences',
    });
    expect(result).toContain('WRITER STYLE PREFERENCES');
    expect(result).toContain('short sentences');
  });
});

describe('reflectLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCraft.mockImplementation(async ({ previousScript }) => ({
      fullText: `${previousScript}+revised`,
      metadata: {} as never,
    }));
  });

  const soft = (issue: string) => ({ type: 'soft' as const, issue, detail: 'd' });
  const hard = (issue: string) => ({ type: 'hard' as const, issue, detail: 'd' });

  // Queue one reviewer verdict per iteration.
  function queueReviews(...rounds: Array<Array<{ type: string; issue: string }>>) {
    for (const problems of rounds) {
      mockGen.mockResolvedValueOnce({
        object: { problems, decision: 'loop', corrections: [] },
      } as never);
    }
  }

  const run = () =>
    reflectLoop({
      initialScript: { fullText: 'draft', metadata: {} as never },
      sourceList: '- Reuters (2026-07-09): https://reuters.com/x',
      cachedSystemContent: 'sys',
      cachedReviewerSystemContent: 'reviewer-sys',
    });

  // The production bug: the reviewer reliably found exactly 3 stylistic tells,
  // so `problems.length >= 3` fired on every pass and the loop ran to
  // MAX_ITERATIONS every time — 3 reviews + 2 re-crafts, ~150s of added
  // latency, then shipped a draft still marked "loop". Observed in the logs as
  // history: [loop(3), loop(4), loop(3)].
  it('spends only one revision pass on a soft-only draft', async () => {
    queueReviews(
      [soft('cadence tell'), soft('em-dash overuse'), soft('jargon')],
      [soft('cadence tell'), soft('em-dash overuse'), soft('jargon')],
    );

    const outcome = await run();

    expect(outcome.iterations).toBe(2);
    expect(outcome.history.at(-1)?.decision).toBe('exit');
    expect(mockCraft).toHaveBeenCalledTimes(1);
    expect(outcome.finalScript.fullText).toBe('draft+revised');
  });

  it('exits immediately when a soft-only draft is under the threshold', async () => {
    queueReviews([soft('one nit')]);

    const outcome = await run();

    expect(outcome.iterations).toBe(1);
    expect(mockCraft).not.toHaveBeenCalled();
  });

  // Hard failures are factual / source-fidelity defects — those must keep
  // looping until fixed or capped, which is the whole point of the reviewer.
  it('keeps looping on hard failures up to the cap', async () => {
    queueReviews(
      [hard('unsupported claim')],
      [hard('unsupported claim')],
      [hard('unsupported claim')],
    );

    const outcome = await run();

    expect(outcome.iterations).toBe(3);
    expect(mockCraft).toHaveBeenCalledTimes(2);
  });

  it('still revises for soft problems after a hard failure is cleared', async () => {
    queueReviews([hard('bad cite')], [soft('a'), soft('b'), soft('c')], [soft('a')]);

    const outcome = await run();

    // Hard pass revises, then the soft-only pass spends its single revision.
    expect(mockCraft).toHaveBeenCalledTimes(2);
    expect(outcome.iterations).toBe(3);
  });

});
