import { describe, it, expect } from 'vitest';
import { transcriptHref } from './transcript-href';
import type { Source } from '@/components/chat-types';

const base = {
  key: 'k',
  title: 'Episode',
  show: 'Call me Back',
  date: '2026-04-05',
  section: null,
  drive_url: null,
  excerpt: '',
};

describe('transcriptHref', () => {
  it('chunk → /transcript/<id>?chunk=N', () => {
    const s: Source = {
      ...base,
      kind: 'chunk',
      id: 184,
      episode_id: 'ep-1',
      speaker: null,
    };
    expect(transcriptHref(s)).toBe('/transcript/ep-1?chunk=184');
  });

  it('turn → /transcript/<id>?turn=N', () => {
    const s: Source = {
      ...base,
      kind: 'turn',
      id: 8367,
      episode_id: 'ep-2',
      speaker: 'Nadav Eyal',
    };
    expect(transcriptHref(s)).toBe('/transcript/ep-2?turn=8367');
  });

  it('episode → bare /transcript/<id>', () => {
    const s: Source = {
      ...base,
      kind: 'episode',
      id: 'ep-3',
      episode_id: 'ep-3',
      speaker: null,
    };
    expect(transcriptHref(s)).toBe('/transcript/ep-3');
  });

  it('encodes special characters in episode_id', () => {
    const s: Source = {
      ...base,
      kind: 'turn',
      id: 1,
      episode_id: 'foo bar/baz',
      speaker: null,
    };
    expect(transcriptHref(s)).toBe('/transcript/foo%20bar%2Fbaz?turn=1');
  });
});
