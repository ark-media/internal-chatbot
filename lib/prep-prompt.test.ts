import { describe, expect, it } from 'vitest';

import { prepSystemPrompt } from './prep-prompt';
import { getPrepShow, PREP_SHOWS } from './prep-shows';
import { isRoutableShow } from './drive';

const TODAY = '2026-06-12';

describe('getPrepShow', () => {
  it('resolves known ids', () => {
    expect(getPrepShow('whats-your-number').canonical).toBe(
      "What's Your Number?",
    );
    expect(getPrepShow('default').canonical).toBeNull();
  });

  it('falls back to default for unknown / empty ids', () => {
    expect(getPrepShow('bogus').id).toBe('default');
    expect(getPrepShow(null).id).toBe('default');
    expect(getPrepShow(undefined).id).toBe('default');
  });

  it('exposes Call me Back with a Drive-routable canonical name', () => {
    const cmb = getPrepShow('call-me-back');
    expect(cmb.canonical).toBe('Call me Back');
    // Call me Back reuses the default (Call-me-Back-flavored) prompt.
    expect(prepSystemPrompt(TODAY, 'call-me-back')).toBe(
      prepSystemPrompt(TODAY, 'default'),
    );
  });

  it('exposes only canonicals that drive.ts can actually route', () => {
    // drive.ts owns the show -> Drive-folder table. Every canonical we surface
    // in the selector must resolve there, or saving that show's prep would
    // silently fall back to the default folder. Exercise the real lookup so the
    // two tables can't drift (e.g. a renamed key in SHOW_FOLDER_LOOKUP).
    const routable = PREP_SHOWS.filter((s) => s.canonical !== null);
    expect(routable.length).toBeGreaterThan(0);
    for (const show of routable) {
      expect(isRoutableShow(show.canonical)).toBe(true);
    }
  });
});

describe('prepSystemPrompt — default surface', () => {
  const prompt = prepSystemPrompt(TODAY);

  it('defaults to the generic prep prompt', () => {
    expect(prepSystemPrompt(TODAY)).toBe(prepSystemPrompt(TODAY, 'default'));
  });

  it('keeps the questions-only output and the Douthat one-shot', () => {
    expect(prompt).toContain('# Questions');
    expect(prompt).toContain('Ross Douthat');
    expect(prompt).toContain('Default question count is 6–7');
    expect(prompt).not.toContain('# Rapid Fire');
    expect(prompt).not.toContain("What's Your Number?");
  });

  it('carries the shared arc philosophy', () => {
    expect(prompt).toContain('But/therefore between every question');
    expect(prompt).toContain('Trey Parker and Matt Stone');
    expect(prompt).toContain('End with catharsis');
  });
});

describe("prepSystemPrompt — What's Your Number?", () => {
  const prompt = prepSystemPrompt(TODAY, 'whats-your-number');

  it('produces the three-section output format', () => {
    expect(prompt).toContain('# Introduction');
    expect(prompt).toContain('# Interview');
    expect(prompt).toContain('# Rapid Fire');
  });

  it('names both co-hosts and frames them as equal', () => {
    expect(prompt).toContain('Yonatan Adiri');
    expect(prompt).toContain('Yael Wissner-Levy');
    expect(prompt).toContain('equal participants');
    expect(prompt).toContain('Do NOT attribute individual questions');
  });

  it('keeps the economy throughline and excludes the cold open', () => {
    expect(prompt).toContain('Israeli economy');
    expect(prompt).toContain('do NOT write it'); // cold open is post-tape
  });

  it('reuses the identical shared arc philosophy', () => {
    expect(prompt).toContain('But/therefore between every question');
    expect(prompt).toContain('Trey Parker and Matt Stone');
    expect(prompt).toContain('End with catharsis');
  });

  it('describes the pre-loaded web context block', () => {
    expect(prompt).toContain('<web_context>');
  });

  it('interpolates today', () => {
    expect(prompt).toContain(`Today is ${TODAY}.`);
  });
});
