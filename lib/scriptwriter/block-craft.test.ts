import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../orchestrator/reflect', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/reflect')>(
    '../orchestrator/reflect',
  );
  return { ...actual, reviewScript: vi.fn() };
});
vi.mock('ai', () => ({ streamText: vi.fn() }));

// Import AFTER the mocks are registered.
import { reviewScript } from '../orchestrator/reflect';
import { streamText } from 'ai';
import { reviewBlock } from './block-craft';
import type { StorySource } from './types';

const mockReview = vi.mocked(reviewScript);
const mockStream = vi.mocked(streamText);

const DRAFT = '[B BLOCK]\nHOST:\nSo why does this matter? That is not the usual friction.';
const FIXED = '[B BLOCK]\nHOST:\nThe friction here is unusual, and it matters.';

const SOURCES: StorySource[] = [
  {
    url: 'https://www.ynetnews.com/article/sjyjztremg',
    title: 'Vance on Iran deal',
    source: 'www.ynetnews.com',
    publicationDate: '2026-07-16',
    isFlagged: false,
    credibility: 80,
    credibilityNote: 'Established outlet.',
  },
];

// The correction pass re-drafts via draftBlock -> streamText; stub it to yield
// the corrected text so reviewBlock's return value is what's under test.
function stubRedraft(text: string) {
  mockStream.mockReturnValue({
    fullStream: (async function* () {
      yield { type: 'text-delta', text };
    })(),
  } as never);
}

const soft = (issue: string) => ({ type: 'soft' as const, issue, detail: `${issue} detail` });
const hard = (issue: string) => ({ type: 'hard' as const, issue, detail: `${issue} detail` });

function callReviewBlock() {
  return reviewBlock({
    slot: 'B',
    draftText: DRAFT,
    sources: SOURCES,
    cachedSystemContent: 'writer system',
    reviewerSystemContent: 'reviewer system',
    contract: 'the contract',
  });
}

describe('reviewBlock — fix gate', () => {
  beforeEach(() => {
    mockReview.mockReset();
    mockStream.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('heals a pile-up of soft-only problems instead of just reporting them', async () => {
    // The reported case: three AI-cadence tells, no hard failure. reviewScript
    // returns decision "loop" on 3+ problems of any kind.
    mockReview.mockResolvedValue({
      problems: [
        soft('Rhetorical question answered by a fragment'),
        soft('Dramatic one-clause sentence for effect'),
        soft('Stock connector / naming the tension'),
      ],
      decision: 'loop',
      corrections: [
        { blockOrSection: 'B', problem: 'Rhetorical question answered by a fragment', suggestedFix: 'Fold into prose.' },
        { blockOrSection: 'B', problem: 'Dramatic one-clause sentence for effect', suggestedFix: 'Merge with prior sentence.' },
        { blockOrSection: 'B', problem: 'Stock connector / naming the tension', suggestedFix: 'Let the facts carry it.' },
      ],
    } as never);
    stubRedraft(FIXED);

    const result = await callReviewBlock();

    expect(result.finalText).toBe(FIXED);
    expect(result.hardFixApplied).toBe(true);
    // Healed notes must not resurface as outstanding work against fixed text.
    expect(result.editorNotes).toEqual([]);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it('applies every correction on a soft pile-up, not just hard-matched ones', async () => {
    mockReview.mockResolvedValue({
      problems: [soft('Tell one'), soft('Tell two'), soft('Tell three')],
      decision: 'loop',
      corrections: [
        { blockOrSection: 'B', problem: 'Tell one', suggestedFix: 'Fix one.' },
        { blockOrSection: 'B', problem: 'Tell two', suggestedFix: 'Fix two.' },
        { blockOrSection: 'B', problem: 'Tell three', suggestedFix: 'Fix three.' },
      ],
    } as never);
    stubRedraft(FIXED);

    await callReviewBlock();

    const corrections = mockStream.mock.calls[0][0].prompt as string;
    expect(corrections).toContain('Fix one.');
    expect(corrections).toContain('Fix two.');
    expect(corrections).toContain('Fix three.');
  });

  it('leaves one or two isolated soft tells as notes without redrafting', async () => {
    // Below the pile-up threshold: the voice-flattening guard still holds.
    mockReview.mockResolvedValue({
      problems: [soft('Dramatic one-clause sentence for effect'), soft('Em-dash overuse')],
      decision: 'exit',
      corrections: [
        { blockOrSection: 'B', problem: 'Dramatic one-clause sentence for effect', suggestedFix: 'Merge it.' },
      ],
    } as never);

    const result = await callReviewBlock();

    expect(result.finalText).toBe(DRAFT);
    expect(result.hardFixApplied).toBe(false);
    expect(result.editorNotes).toEqual([
      'Dramatic one-clause sentence for effect: Dramatic one-clause sentence for effect detail',
      'Em-dash overuse: Em-dash overuse detail',
    ]);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('withholds soft corrections when an isolated hard failure drives the fix', async () => {
    mockReview.mockResolvedValue({
      problems: [hard('Claim not supported by sources'), soft('Em-dash overuse')],
      decision: 'loop',
      corrections: [
        { blockOrSection: 'B', problem: 'Claim not supported by sources', suggestedFix: 'Attribute to Ynet.' },
        { blockOrSection: 'B', problem: 'Em-dash overuse', suggestedFix: 'Use commas.' },
      ],
    } as never);
    stubRedraft(FIXED);

    const result = await callReviewBlock();

    const prompt = mockStream.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Attribute to Ynet.');
    expect(prompt).not.toContain('Use commas.');
    // The withheld soft problem stays a note for the writer.
    expect(result.editorNotes).toEqual(['Em-dash overuse: Em-dash overuse detail']);
  });

  it('falls back to the unreviewed draft when the review itself fails', async () => {
    mockReview.mockRejectedValue(new Error('gateway down'));

    const result = await callReviewBlock();

    expect(result.finalText).toBe(DRAFT);
    expect(result.hardFixApplied).toBe(false);
    expect(result.editorNotes).toEqual([]);
  });
});
