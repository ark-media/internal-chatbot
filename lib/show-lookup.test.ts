import { beforeEach, describe, expect, it, vi } from 'vitest';

// `sql` is used two ways here: awaited for queries, and interpolated unawaited
// to build fixed identifier fragments at module load. Returning a thenable that
// pulls from a queue serves both — the fragments are simply never awaited.
const queue: unknown[][] = [];

vi.mock('./db', () => ({
  sql: () => ({
    then: (resolve: (v: unknown) => void) => resolve(queue.shift() ?? []),
  }),
}));

import {
  lookupShowGroupId,
  lookupShowId,
  resolveShow,
  resolveShowGroup,
} from './show-lookup';

beforeEach(() => {
  queue.length = 0;
});

// These notes are handed to the model as tool-error text. They were previously
// written out in four places; if the wording drifts, the model's disambiguation
// behaviour drifts with it. Pinned verbatim against the pre-extraction strings.
describe('tool-error notes', () => {
  it('names every known show when nothing matches', async () => {
    queue.push([], [{ name: 'Call me Back' }, { name: 'For Heaven’s Sake' }]);

    expect(await resolveShow('zz')).toEqual({
      ok: false,
      error: 'unknown_show',
      note: 'No show matching "zz". Known shows: Call me Back, For Heaven’s Sake.',
    });
  });

  it('names every known group when nothing matches', async () => {
    queue.push([], [{ name: 'Weeklies' }]);

    expect(await resolveShowGroup('zz')).toEqual({
      ok: false,
      error: 'unknown_group',
      note: 'No show group matching "zz". Known groups: Weeklies.',
    });
  });

  // The two differ here, and did before the extraction: an empty group list
  // renders "(none)" while an empty show list renders nothing at all. Only
  // reachable with an empty corpus, but it is model-facing text, so it is
  // reproduced rather than tidied.
  it('renders an empty show list as nothing', async () => {
    queue.push([], []);
    const r = await resolveShow('zz');

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.note).toBe('No show matching "zz". Known shows: .');
  });

  it('renders an empty group list as (none)', async () => {
    queue.push([], []);
    const r = await resolveShowGroup('zz');

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.note).toBe(
      'No show group matching "zz". Known groups: (none).',
    );
  });

  it('asks the user to choose when a show name is ambiguous', async () => {
    queue.push([
      { id: 1, name: 'Call me Back' },
      { id: 2, name: 'Inside Call me Back' },
    ]);

    expect(await resolveShow('call')).toEqual({
      ok: false,
      error: 'ambiguous_show',
      note: '"call" matches multiple shows. Ask the user which they meant.',
      candidates: ['Call me Back', 'Inside Call me Back'],
    });
  });

  it('asks the user to choose when a group name is ambiguous', async () => {
    queue.push([
      { id: 1, name: 'Weekly Shows' },
      { id: 2, name: 'Weekly Extras' },
    ]);

    expect(await resolveShowGroup('weekly')).toEqual({
      ok: false,
      error: 'ambiguous_group',
      note: '"weekly" matches multiple show groups. Ask the user which they meant.',
      candidates: ['Weekly Shows', 'Weekly Extras'],
    });
  });
});

describe('resolution', () => {
  // The query orders exact matches first, so an exact hit arrives at [0] and
  // wins outright — "Call me Back" must not be ambiguous just because "Inside
  // Call me Back" also contains it.
  it('an exact match wins even with other substring matches', async () => {
    queue.push([
      { id: 1, name: 'Call me Back' },
      { id: 2, name: 'Inside Call me Back' },
    ]);

    expect(await resolveShow('call me back')).toEqual({
      ok: true,
      id: 1,
      name: 'Call me Back',
    });
  });

  it('a lone substring match resolves without complaint', async () => {
    queue.push([{ id: 3, name: 'For Heaven’s Sake' }]);

    expect(await resolveShow('heaven')).toEqual({
      ok: true,
      id: 3,
      name: 'For Heaven’s Sake',
    });
  });
});

describe('id-only lookups', () => {
  it.each([
    ['lookupShowId', lookupShowId],
    ['lookupShowGroupId', lookupShowGroupId],
  ])('%s takes the best match', async (_name, lookup) => {
    queue.push([{ id: 9, name: 'A' }, { id: 10, name: 'B' }]);
    expect(await lookup('a')).toBe(9);
  });

  it.each([
    ['lookupShowId', lookupShowId],
    ['lookupShowGroupId', lookupShowGroupId],
  ])('%s returns null when nothing matches', async (_name, lookup) => {
    queue.push([]);
    expect(await lookup('zz')).toBeNull();
  });
});
