import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateObject } from 'ai';

import {
  classifyNewsRequest,
  heuristicNewsRequestRoute,
  newsRequestInstruction,
} from './news-request';

vi.mock('ai', () => ({ generateObject: vi.fn() }));

const mockedGenerateObject = vi.mocked(generateObject);

function messages(text: string, extra: { role?: string; parts?: unknown }[] = []) {
  return [...extra, { role: 'user', parts: [{ type: 'text', text }] }];
}

const SCAN_SUGGESTIONS_TURN = {
  role: 'assistant',
  parts: [
    { type: 'data-breaking-suggestions', data: {} },
    { type: 'text', text: 'Two suggestions: Swap (flotilla story), Update (A block).' },
  ],
};

beforeEach(() => {
  mockedGenerateObject.mockReset();
});

describe('classifyNewsRequest (LLM classifier)', () => {
  it('returns the model-classified route', async () => {
    mockedGenerateObject.mockResolvedValue({
      object: { intent: 'cleanup', block: null, immediateDraft: false },
    } as never);
    const route = await classifyNewsRequest(messages('Can you clean up this sentence?'));
    expect(route).toEqual({ intent: 'cleanup', block: undefined, immediateDraft: false });
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
  });

  it('tells the classifier whether a scan presented suggestions', async () => {
    mockedGenerateObject.mockResolvedValue({
      object: { intent: 'scan-integration', block: 'C', immediateDraft: false },
    } as never);
    await classifyNewsRequest(
      messages('Swap in the flotilla story.', [SCAN_SUGGESTIONS_TURN]),
    );
    const call = mockedGenerateObject.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('suggestions earlier in this conversation: yes');

    mockedGenerateObject.mockClear();
    mockedGenerateObject.mockResolvedValue({
      object: { intent: 'revision', block: 'C', immediateDraft: false },
    } as never);
    await classifyNewsRequest(messages('Swap in the flotilla story.'));
    const second = mockedGenerateObject.mock.calls[0][0] as { prompt: string };
    expect(second.prompt).toContain('suggestions earlier in this conversation: no');
  });

  it('falls back to the heuristic when the model call fails', async () => {
    mockedGenerateObject.mockRejectedValue(new Error('timeout'));
    const route = await classifyNewsRequest(messages('Write the A block from these notes.'));
    expect(route).toMatchObject({ intent: 'single-block-draft', block: 'A', immediateDraft: true });
  });

  it('skips the model call entirely for an empty conversation', async () => {
    const route = await classifyNewsRequest([]);
    expect(route).toEqual({ intent: 'draft', immediateDraft: false });
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });
});

describe('heuristicNewsRequestRoute (fallback)', () => {
  it('keeps sentence cleanup out of the script flow', () => {
    expect(heuristicNewsRequestRoute(messages('Can you clean up this sentence?')).intent).toBe(
      'cleanup',
    );
  });

  it('routes a one-block immediate draft to one block only', () => {
    expect(heuristicNewsRequestRoute(messages('Write the A block from these notes.'))).toMatchObject({
      intent: 'single-block-draft',
      block: 'A',
      immediateDraft: true,
    });
  });

  it('recognizes breaking-news scan phrasings', () => {
    expect(
      heuristicNewsRequestRoute(messages('Check for breaking news since I locked this script.'))
        .intent,
    ).toBe('scan');
    expect(
      heuristicNewsRequestRoute(
        messages("Let me make sure I didn't miss any breaking news on the blocks today."),
      ).intent,
    ).toBe('scan');
  });

  it('classifies acceptance as scan-integration ONLY after a scan presented suggestions', () => {
    const accept = 'I accept the Swap suggestion. Integrate that story into C block.';
    expect(
      heuristicNewsRequestRoute(messages(accept, [SCAN_SUGGESTIONS_TURN])).intent,
    ).toBe('scan-integration');
    // Without a prior scan, "update the B block with the story" is ordinary
    // block work, not integration of a nonexistent suggestion.
    expect(
      heuristicNewsRequestRoute(messages('Update the B block with the new hostage story.')).intent,
    ).not.toBe('scan-integration');
  });
});

describe('newsRequestInstruction', () => {
  it('marks every mode note as advisory — the writer’s words win', () => {
    for (const intent of [
      'cleanup',
      'outline',
      'revision',
      'single-block-draft',
      'full-episode-draft',
      'scan',
      'scan-integration',
      'draft',
    ] as const) {
      const note = newsRequestInstruction({ intent, immediateDraft: false });
      expect(note).toContain('auto-detected');
      expect(note).toContain('follow the workflow that matches their words');
    }
  });

  it('keeps single-block scope and the non-waivable readback', () => {
    const note = newsRequestInstruction({
      intent: 'single-block-draft',
      block: 'A',
      immediateDraft: true,
    });
    expect(note).toContain('[A BLOCK]');
    expect(note).toContain('Never add SONIC ID');
    expect(note).toContain('does not waive the understanding readback');
  });

  it('references the Breaking-News Integration workflow by its real name', () => {
    const note = newsRequestInstruction({ intent: 'scan-integration', immediateDraft: false });
    expect(note).toContain('Breaking-News Integration workflow');
    expect(note).not.toContain('Phase-2');
  });
});
