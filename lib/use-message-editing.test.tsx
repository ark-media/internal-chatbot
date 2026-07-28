// @vitest-environment jsdom
// Exercises a hook that owns a window-level keydown listener; needs a DOM.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageEditing } from './use-message-editing';

const chatFetch = vi.hoisted(() =>
  vi.fn<typeof fetch>(async () => new Response('ok')),
);
vi.mock('./chat-fetch', () => ({ chatFetch }));

// Mirrors what the pages pass: a setInput from useState and a scroll container ref.
function setup() {
  const setInput = vi.fn();
  const scrollRef = { current: { scrollTo: vi.fn(), scrollHeight: 900 } };
  const view = renderHook(() =>
    useMessageEditing({
      setInput,
      scrollRef: scrollRef as never,
    }),
  );
  return { ...view, setInput, scrollRef };
}

const message = (id: string, ...texts: string[]) => ({
  id,
  parts: texts.map((text) => ({ type: 'text' as const, text })),
});

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  });
}

beforeEach(() => {
  chatFetch.mockClear();
});

describe('useMessageEditing', () => {
  it('starts with no message under edit', () => {
    const { result } = setup();
    expect(result.current.editingMessageId).toBeNull();
  });

  it('startEditing loads the message text into the composer and scrolls', () => {
    const { result, setInput, scrollRef } = setup();

    act(() => result.current.startEditing(message('m1', 'hello')));

    expect(result.current.editingMessageId).toBe('m1');
    expect(setInput).toHaveBeenCalledWith('hello');
    expect(scrollRef.current.scrollTo).toHaveBeenCalledWith({
      top: 900,
      behavior: 'smooth',
    });
  });

  it('joins multiple text parts with a blank line', () => {
    const { result, setInput } = setup();

    act(() => result.current.startEditing(message('m1', 'first', 'second')));

    expect(setInput).toHaveBeenCalledWith('first\n\nsecond');
  });

  it('ignores a message with no text parts', () => {
    const { result, setInput } = setup();

    act(() =>
      result.current.startEditing({
        id: 'm1',
        parts: [{ type: 'tool-lookupCorpus' }],
      }),
    );

    expect(result.current.editingMessageId).toBeNull();
    expect(setInput).not.toHaveBeenCalled();
  });

  it('Escape cancels the edit and clears the composer', () => {
    const { result, setInput } = setup();
    act(() => result.current.startEditing(message('m1', 'hello')));
    setInput.mockClear();

    pressEscape();

    expect(result.current.editingMessageId).toBeNull();
    expect(setInput).toHaveBeenCalledWith('');
  });

  // The listener is scoped to an active edit so Escape keeps its normal
  // meaning (closing panels) the rest of the time.
  it('does not touch the composer on Escape when no edit is active', () => {
    const { result, setInput } = setup();

    pressEscape();

    expect(setInput).not.toHaveBeenCalled();
    expect(result.current.editingMessageId).toBeNull();
  });

  it('removes the keydown listener on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { result, unmount } = setup();
    act(() => result.current.startEditing(message('m1', 'hello')));

    unmount();

    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    remove.mockRestore();
  });

  it('cancelEditing clears both the id and the composer', () => {
    const { result, setInput } = setup();
    act(() => result.current.startEditing(message('m1', 'hello')));
    setInput.mockClear();

    act(() => result.current.cancelEditing());

    expect(result.current.editingMessageId).toBeNull();
    expect(setInput).toHaveBeenCalledWith('');
  });

  // Called from useChat's onFinish, where the composer was already cleared by
  // submit — clearing it again would wipe anything typed while streaming.
  it('finishEditing clears the id but leaves the composer alone', () => {
    const { result, setInput } = setup();
    act(() => result.current.startEditing(message('m1', 'hello')));
    setInput.mockClear();

    act(() => result.current.finishEditing());

    expect(result.current.editingMessageId).toBeNull();
    expect(setInput).not.toHaveBeenCalled();
  });

  describe('editingFetch', () => {
    const bodyOf = () => JSON.parse(chatFetch.mock.calls[0]![1]!.body as string);

    it('injects editingMessageId into the request body while editing', async () => {
      const { result } = setup();
      act(() => result.current.startEditing(message('m1', 'hello')));

      await act(async () => {
        await result.current.editingFetch('/api/chat', {
          body: JSON.stringify({ chatId: 'c1' }),
        });
      });

      expect(bodyOf()).toEqual({ chatId: 'c1', editingMessageId: 'm1' });
    });

    it('leaves the body alone when no edit is active', async () => {
      const { result } = setup();

      await act(async () => {
        await result.current.editingFetch('/api/chat', {
          body: JSON.stringify({ chatId: 'c1' }),
        });
      });

      expect(bodyOf()).toEqual({ chatId: 'c1' });
    });

    // A body that isn't JSON must still reach the server rather than throwing
    // inside the transport.
    it('falls back to the original request when the body is not JSON', async () => {
      const { result } = setup();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      await act(async () => {
        await result.current.editingFetch('/api/chat', { body: 'not-json' });
      });

      expect(chatFetch).toHaveBeenCalledWith('/api/chat', { body: 'not-json' });
      err.mockRestore();
    });
  });
});
