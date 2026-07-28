import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';

const persistIncomingMessages =
  vi.fn<(opts: Record<string, unknown>) => Promise<{ newCount: number }>>();
const deleteMessageAndSubsequent =
  vi.fn<(chatId: string, messageId: string) => Promise<void>>();
vi.mock('./chats', () => ({
  persistIncomingMessages: (o: Record<string, unknown>) => persistIncomingMessages(o),
  deleteMessageAndSubsequent: (a: string, b: string) =>
    deleteMessageAndSubsequent(a, b),
}));

vi.mock('./rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ ok: true, remaining: 10 })),
}));

import { persistTurn } from './chat-route';

const MESSAGES = [
  { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
] as unknown as UIMessage[];

beforeEach(() => {
  vi.clearAllMocks();
  persistIncomingMessages.mockResolvedValue({ newCount: 1 });
  deleteMessageAndSubsequent.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('persistTurn', () => {
  it('does nothing without a chatId — an unsaved conversation', async () => {
    await persistTurn({
      chatId: undefined,
      surface: 'archive',
      messages: MESSAGES,
      logKey: 'chat',
    });

    expect(persistIncomingMessages).not.toHaveBeenCalled();
    expect(deleteMessageAndSubsequent).not.toHaveBeenCalled();
  });

  it('persists under the given surface, without redaction by default', async () => {
    await persistTurn({
      chatId: 'c1',
      surface: 'archive',
      messages: MESSAGES,
      logKey: 'chat',
    });

    expect(persistIncomingMessages).toHaveBeenCalledWith({
      chatId: 'c1',
      surface: 'archive',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      redactFiles: undefined,
    });
    expect(deleteMessageAndSubsequent).not.toHaveBeenCalled();
  });

  it('passes redactFiles through for the file-carrying surfaces', async () => {
    await persistTurn({
      chatId: 'c1',
      surface: 'prep',
      messages: MESSAGES,
      redactFiles: true,
      logKey: 'prep',
    });

    expect(persistIncomingMessages).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'prep', redactFiles: true }),
    );
  });

  it('drops the replaced tail before persisting when editing', async () => {
    const order: string[] = [];
    deleteMessageAndSubsequent.mockImplementation(async () => {
      order.push('delete');
    });
    persistIncomingMessages.mockImplementation(async () => {
      order.push('persist');
      return { newCount: 1 };
    });

    await persistTurn({
      chatId: 'c1',
      editingMessageId: 'm0',
      surface: 'news',
      messages: MESSAGES,
      logKey: 'news',
    });

    expect(deleteMessageAndSubsequent).toHaveBeenCalledWith('c1', 'm0');
    // Persisting first would leave the edited turn behind the old tail.
    expect(order).toEqual(['delete', 'persist']);
  });

  it('substitutes an empty parts array when a message has none', async () => {
    await persistTurn({
      chatId: 'c1',
      surface: 'archive',
      messages: [{ id: 'm1', role: 'user' }] as unknown as UIMessage[],
      logKey: 'chat',
    });

    expect(persistIncomingMessages).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ id: 'm1', role: 'user', parts: [] }] }),
    );
  });

  // Persistence is best-effort: the user still gets their answer, it just
  // doesn't survive a reload. Neither failure may propagate.
  it('swallows and logs a delete failure, still persisting', async () => {
    deleteMessageAndSubsequent.mockRejectedValue(new Error('gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      persistTurn({
        chatId: 'c1',
        editingMessageId: 'm0',
        surface: 'prep',
        messages: MESSAGES,
        logKey: 'prep',
      }),
    ).resolves.toBeUndefined();

    expect(persistIncomingMessages).toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0][0] as string).event).toBe(
      'prep.delete_for_edit_error',
    );
  });

  it('swallows and logs a persist failure', async () => {
    persistIncomingMessages.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      persistTurn({
        chatId: 'c1',
        surface: 'scripts',
        messages: MESSAGES,
        logKey: 'scripts',
      }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(warn.mock.calls[0][0] as string).event).toBe(
      'scripts.persist_user_error',
    );
  });
});
