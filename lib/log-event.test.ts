import { afterEach, describe, expect, it, vi } from 'vitest';
import { errText, errorEvent, logEvent, warnEvent } from './log-event';

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(method: 'warn' | 'log' | 'error') {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  return () => JSON.parse(spy.mock.calls.at(-1)?.[0] as string);
}

describe('warnEvent / logEvent / errorEvent', () => {
  it.each([
    ['warn', warnEvent],
    ['log', logEvent],
    ['error', errorEvent],
  ] as const)('%s writes one JSON line with event first', (method, emit) => {
    const read = capture(method);
    emit('news.reflect_error', { err: 'boom', ms: 12 });

    expect(read()).toEqual({ event: 'news.reflect_error', err: 'boom', ms: 12 });
    // `event` must lead so a log drain can key on a stable prefix.
    expect(Object.keys(read())[0]).toBe('event');
  });

  it('emits a bare event when there are no fields', () => {
    const read = capture('log');
    logEvent('chats.purge');

    expect(read()).toEqual({ event: 'chats.purge' });
  });

  it('does not let a field named event shadow the event name', () => {
    const read = capture('warn');
    warnEvent('chat.route_error', { event: 'spoofed' } as Record<string, unknown>);

    expect(read().event).toBe('spoofed');
  });
});

describe('errText', () => {
  it('keeps the error class name', () => {
    expect(errText(new TypeError('bad input'))).toBe('TypeError: bad input');
  });

  it('caps long messages at 300 characters', () => {
    const out = errText(new Error('x'.repeat(500)));

    expect(out).toHaveLength(300);
    expect(out.startsWith('Error: xxx')).toBe(true);
  });

  it.each([
    [undefined, 'undefined'],
    [null, 'null'],
    ['plain string', 'plain string'],
    [42, '42'],
  ])('stringifies non-Error value %s', (input, expected) => {
    expect(errText(input)).toBe(expected);
  });
});
