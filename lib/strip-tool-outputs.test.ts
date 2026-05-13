import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { stripStaleToolOutputs } from './strip-tool-outputs';

const stub = (id: string, role: 'user' | 'assistant', parts: UIMessage['parts']): UIMessage => ({
  id,
  role,
  parts,
});

const userText = (id: string, text: string) =>
  stub(id, 'user', [{ type: 'text', text }]);

const assistantText = (id: string, text: string) =>
  stub(id, 'assistant', [{ type: 'text', text }]);

// Cast to UIMessage['parts'] because the ToolUIPart variant is hard to
// hand-construct without naming the tool registry.
const toolPart = (overrides: Record<string, unknown>) =>
  ({
    type: 'tool-searchCorpus',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { query: 'hello' },
    output: { chunks: [{ id: 1, text: 'a'.repeat(50_000) }] },
    ...overrides,
  }) as unknown as UIMessage['parts'][number];

describe('stripStaleToolOutputs', () => {
  it('returns the same reference for empty input', () => {
    const messages: UIMessage[] = [];
    expect(stripStaleToolOutputs(messages)).toBe(messages);
  });

  it('returns the same reference when there are only user messages', () => {
    const messages = [userText('u1', 'hi'), userText('u2', 'still hi')];
    expect(stripStaleToolOutputs(messages)).toBe(messages);
  });

  it('leaves a single assistant message intact', () => {
    const a1 = stub('a1', 'assistant', [toolPart({})]);
    const messages = [userText('u1', 'q'), a1];
    const out = stripStaleToolOutputs(messages);
    expect(out[1]).toBe(a1);
    const part = out[1].parts[0] as { output: unknown };
    expect(part.output).toEqual({ chunks: [{ id: 1, text: 'a'.repeat(50_000) }] });
  });

  it('strips output on prior assistant, preserves most-recent assistant', () => {
    const stale = toolPart({ toolCallId: 'stale' });
    const fresh = toolPart({ toolCallId: 'fresh' });
    const messages = [
      userText('u1', 'q1'),
      stub('a1', 'assistant', [stale]),
      userText('u2', 'q2'),
      stub('a2', 'assistant', [fresh]),
    ];
    const out = stripStaleToolOutputs(messages);
    const stalePart = out[1].parts[0] as { output: { note: string } };
    const freshPart = out[3].parts[0] as { output: unknown };
    expect(stalePart.output).toEqual({
      note: expect.stringContaining('Output omitted'),
    });
    expect(freshPart.output).toEqual({
      chunks: [{ id: 1, text: 'a'.repeat(50_000) }],
    });
  });

  it('strips with new-user-as-tail (preserves prior assistant)', () => {
    // Typical request shape: last message is the incoming user turn.
    const olderTool = toolPart({ toolCallId: 'older' });
    const recentTool = toolPart({ toolCallId: 'recent' });
    const messages = [
      userText('u1', 'q1'),
      stub('a1', 'assistant', [olderTool]),
      userText('u2', 'q2'),
      stub('a2', 'assistant', [recentTool]),
      userText('u3', 'follow-up'),
    ];
    const out = stripStaleToolOutputs(messages);
    const olderPart = out[1].parts[0] as { output: { note: string } };
    const recentPart = out[3].parts[0] as { output: unknown };
    expect(olderPart.output).toMatchObject({ note: expect.any(String) });
    expect(recentPart.output).toEqual({
      chunks: [{ id: 1, text: 'a'.repeat(50_000) }],
    });
  });

  it('rewrites errorText for output-error parts', () => {
    const errorTool = toolPart({
      state: 'output-error',
      output: undefined,
      errorText: 'database timeout: connection reset by peer',
    });
    const messages = [
      userText('u1', 'q1'),
      stub('a1', 'assistant', [errorTool]),
      userText('u2', 'q2'),
      assistantText('a2', 'tail'),
    ];
    const out = stripStaleToolOutputs(messages);
    const stripped = out[1].parts[0] as { errorText: string; output?: unknown };
    expect(stripped.errorText).toContain('Error message omitted');
    expect(stripped.errorText).not.toContain('database timeout');
  });

  it('preserves provider-executed tool parts', () => {
    const providerTool = toolPart({ providerExecuted: true });
    const messages = [
      userText('u1', 'q1'),
      stub('a1', 'assistant', [providerTool]),
      userText('u2', 'q2'),
      assistantText('a2', 'tail'),
    ];
    const out = stripStaleToolOutputs(messages);
    const part = out[1].parts[0] as { output: unknown; providerExecuted: boolean };
    expect(part.providerExecuted).toBe(true);
    expect(part.output).toEqual({ chunks: [{ id: 1, text: 'a'.repeat(50_000) }] });
  });

  it('preserves non-tool parts on stripped messages', () => {
    const messages = [
      userText('u1', 'q1'),
      stub('a1', 'assistant', [
        { type: 'text', text: 'synthesis text' },
        toolPart({}),
      ]),
      userText('u2', 'q2'),
      assistantText('a2', 'tail'),
    ];
    const out = stripStaleToolOutputs(messages);
    const parts = out[1].parts as Array<{ type: string; text?: string; output?: unknown }>;
    expect(parts[0]).toEqual({ type: 'text', text: 'synthesis text' });
    expect(parts[1].output).toMatchObject({ note: expect.any(String) });
  });

  it('skips messages with undefined parts', () => {
    const broken = { id: 'a1', role: 'assistant' } as unknown as UIMessage;
    const messages = [userText('u1', 'q1'), broken, userText('u2', 'q2'), assistantText('a2', 'tail')];
    const out = stripStaleToolOutputs(messages);
    expect(out[1]).toBe(broken);
  });

  it('returns the same outer message reference when no parts are strippable', () => {
    const a1 = stub('a1', 'assistant', [{ type: 'text', text: 'no tools here' }]);
    const messages = [userText('u1', 'q1'), a1, userText('u2', 'q2'), assistantText('a2', 'tail')];
    const out = stripStaleToolOutputs(messages);
    expect(out[1]).toBe(a1);
  });

  it('ignores input-streaming / input-available states (no output yet)', () => {
    const inputOnly = toolPart({ state: 'input-available', output: undefined });
    const messages = [
      userText('u1', 'q1'),
      stub('a1', 'assistant', [inputOnly]),
      userText('u2', 'q2'),
      assistantText('a2', 'tail'),
    ];
    const out = stripStaleToolOutputs(messages);
    // Pre-check via .some() short-circuits, so the message reference is preserved.
    expect(out[1]).toBe(messages[1]);
  });
});
