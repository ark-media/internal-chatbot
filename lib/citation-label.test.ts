import { describe, it, expect } from 'vitest';
import {
  citationChipLabel,
  lastName,
  shortDate,
  showAbbr,
} from './citation-label';
import type { Source } from '@/components/chat-types';

describe('showAbbr', () => {
  it('takes the first letter of each word, preserving case', () => {
    expect(showAbbr('Call me Back')).toBe('CmB');
    expect(showAbbr('For Heaven’s Sake')).toBe('FHS');
    expect(showAbbr("What's Your Number?")).toBe('WYN');
    expect(showAbbr('Inside Call me Back')).toBe('ICmB');
  });

  it('handles single-word names by taking first 3 chars', () => {
    expect(showAbbr('Arkive')).toBe('Ark');
    expect(showAbbr('FHS')).toBe('FHS');
    expect(showAbbr('Hi')).toBe('Hi');
    expect(showAbbr('')).toBe('');
    expect(showAbbr(null)).toBe('');
    expect(showAbbr(undefined)).toBe('');
  });
});

describe('lastName', () => {
  it('returns the last whitespace-delimited token', () => {
    expect(lastName('Nadav Eyal')).toBe('Eyal');
    expect(lastName('Yossi Klein Halevi')).toBe('Halevi');
  });

  it('returns the whole string when there is no space', () => {
    expect(lastName('Madonna')).toBe('Madonna');
  });

  it('handles null/empty', () => {
    expect(lastName(null)).toBe('');
    expect(lastName(undefined)).toBe('');
    expect(lastName('')).toBe('');
  });
});

describe('shortDate', () => {
  const today = new Date('2026-04-30');

  it('omits the year when same as today', () => {
    expect(shortDate('2026-04-05', today)).toBe('Apr 5');
    expect(shortDate('2026-12-25', today)).toBe('Dec 25');
  });

  it('appends 2-digit year when in a different calendar year', () => {
    expect(shortDate('2025-04-05', today)).toBe("Apr 5 '25");
    expect(shortDate('2024-11-12', today)).toBe("Nov 12 '24");
  });

  it('returns empty for null/invalid', () => {
    expect(shortDate(null, today)).toBe('');
    expect(shortDate('', today)).toBe('');
    expect(shortDate('not-a-date', today)).toBe('');
  });
});

describe('citationChipLabel', () => {
  const today = new Date('2026-04-30');
  const base = {
    id: 1,
    key: 'id:1',
    episode_id: 'ep1',
    title: 'Episode',
    section: null,
    drive_url: null,
    excerpt: '',
  };

  it('formats chunk citations as "<showAbbr> · <date>"', () => {
    const s: Source = {
      ...base,
      kind: 'chunk',
      show: 'Call me Back',
      date: '2026-04-05',
      speaker: null,
    };
    expect(citationChipLabel(s, today)).toBe('CmB · Apr 5');
  });

  it('formats turn citations as "<lastName> · <date>"', () => {
    const s: Source = {
      ...base,
      kind: 'turn',
      show: 'Call me Back',
      date: '2026-04-05',
      speaker: 'Nadav Eyal',
    };
    expect(citationChipLabel(s, today)).toBe('Eyal · Apr 5');
  });

  it('formats episode citations like chunks', () => {
    const s: Source = {
      ...base,
      kind: 'episode',
      show: "For Heaven's Sake",
      date: '2025-12-01',
      speaker: 'Yossi Klein Halevi',
    };
    expect(citationChipLabel(s, today)).toBe("FHS · Dec 1 '25");
  });

  it('handles episode kind with empty show (countGuestAppearances path)', () => {
    // out.showName ?? '' in chat/[id]/page.tsx means empty-show episodes
    // are real. Falls back to date alone, then 'Source' if both missing.
    const dateOnly: Source = {
      ...base,
      kind: 'episode',
      show: '',
      date: '2026-04-05',
      speaker: 'Some Guest',
    };
    expect(citationChipLabel(dateOnly, today)).toBe('Apr 5');

    const nothing: Source = {
      ...base,
      kind: 'episode',
      show: '',
      date: null,
      speaker: 'Some Guest',
    };
    expect(citationChipLabel(nothing, today)).toBe('Source');
  });

  it('falls back gracefully when one side is missing', () => {
    const noDate: Source = {
      ...base,
      kind: 'chunk',
      show: 'Call me Back',
      date: null,
      speaker: null,
    };
    expect(citationChipLabel(noDate, today)).toBe('CmB');

    const noShow: Source = {
      ...base,
      kind: 'chunk',
      show: '',
      date: '2026-04-05',
      speaker: null,
    };
    expect(citationChipLabel(noShow, today)).toBe('Apr 5');

    const noSpeaker: Source = {
      ...base,
      kind: 'turn',
      show: 'Call me Back',
      date: null,
      speaker: null,
    };
    expect(citationChipLabel(noSpeaker, today)).toBe('Speaker');
  });
});
