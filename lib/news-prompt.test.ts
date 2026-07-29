import { describe, expect, it } from 'vitest';

import { newsContextForDate, newsSystemPrompt } from './news-prompt';

// The chat prompt is a single stable string — all workflow modules present on
// every request, with a trailing per-turn Active Request Mode note (built in
// lib/news-request.ts) saying which one applies. Stability is deliberate: a
// per-task prompt variant would invalidate the cached prefix (system + context
// + history) on every intent switch mid-conversation.
const chat = newsSystemPrompt('chat');

describe('newsSystemPrompt — compact shared core', () => {
  it('keeps product voice, scope, evidence, and supplied-audio rules', () => {
    expect(chat).toContain("writer's explicit operation and scope control the response");
    expect(chat).toContain('Evidence contract');
    expect(chat).toContain('reproduce it word-for-word');
    expect(chat).toContain('Do not paraphrase, reword, trim, expand, or normalize it');
    expect(chat).toContain('never silently drop one');
  });

  it('does not send the detailed scriptwriter bible to chat requests', () => {
    expect(chat).not.toContain('Keep the Voice Alive While Avoiding AI Cadence');
    expect(chat).not.toContain('Pre-Publication Verification');
    expect(chat).toContain('Non-negotiables');
  });

  it('tells the model the mode note is advisory and trails the conversation', () => {
    expect(chat).toContain('== Request Modes ==');
    expect(chat).toContain("the writer's own words always win");
  });
});

describe('newsSystemPrompt — workflow modules (all present, mode-note activated)', () => {
  it('contains the script module with sourcing, gate, scope, and audio structure', () => {
    expect(chat).toContain('Script Draft Workflow');
    expect(chat).toContain('Use fetchArticle for every writer-provided link');
    expect(chat).toContain('every first, source-heavy substantive script request');
    expect(chat).toContain('including a request for one particular block');
    expect(chat).toContain('six-dimension readback');
    expect(chat).toContain('single-block request returns exactly that block');
    expect(chat).toContain('spread them across the script');
  });

  it('contains the editorial and revision modules', () => {
    expect(chat).toContain('Editorial Response Workflow');
    expect(chat).toContain("Answer only the writer's wording, outline, or editorial question");
    expect(chat).toContain('Script Revision Workflow');
    expect(chat).toContain('Return only the material the writer asked to change');
  });

  it('contains both scan modules, so a misdetected mode still finds the scan tool', () => {
    expect(chat).toContain('Breaking-News Scan — Suggestions Only');
    expect(chat).toContain('call scanBreakingNews first and only');
    expect(chat).toContain('Do not draft, edit, reorder, auto-swap');
    expect(chat).toContain('Breaking-News Integration');
    expect(chat).toContain('Integrate only the suggestion the writer accepted');
    expect(chat).toContain('Update revises the affected block in place');
  });
});

describe('newsSystemPrompt — batch orchestrator', () => {
  it('retains the detailed source-free batch prompt', () => {
    const prompt = newsSystemPrompt('orchestrator');
    expect(prompt).toContain('Sources are pre-curated');
    expect(prompt).toContain('You have no tools available');
    expect(prompt).not.toContain('scanBreakingNews');
  });
});

// The date context models the real production cadence: writers draft and
// record in the evening (America/New_York) and the episode airs the next
// morning. The week of Jul 22–29 2026 showed the old yesterday-only window
// misfiring three times — same-day sources flagged as "outside the acceptable
// window" that then led the next morning's episode, and a draft datelined on
// the recording day that the editors had to re-dateline by hand.
describe('newsContextForDate — air-date model', () => {
  it('datelines a weekday session for the next morning and accepts today + yesterday', () => {
    const ctx = newsContextForDate('2026-07-22'); // Wednesday session
    expect(ctx).toContain('Today is Wednesday, 2026-07-22');
    expect(ctx).toContain('airs the next morning: Thursday, 2026-07-23');
    expect(ctx).toContain('"It\'s Thursday, July 23."');
    expect(ctx).toContain('recorded at 7 p.m. New York time on Wednesday');
    expect(ctx).toContain('2026-07-21 (yesterday) or 2026-07-22 (today)');
    // "yesterday" in narration means the recording day, from the listener's morning.
    expect(ctx).toContain('"yesterday" refers to 2026-07-22');
  });

  it('gives a Sunday session Monday air and the full weekend window', () => {
    const ctx = newsContextForDate('2026-07-26'); // Sunday session
    expect(ctx).toContain('airs the next morning: Monday, 2026-07-27');
    expect(ctx).toContain(
      '2026-07-24 (Friday), 2026-07-25 (Saturday), or 2026-07-26 (today, Sunday)',
    );
  });

  it('rolls Friday and Saturday sessions forward to Monday — there are no weekend episodes', () => {
    expect(newsContextForDate('2026-07-24')).toContain('airs the next morning: Monday, 2026-07-27'); // Friday
    expect(newsContextForDate('2026-07-25')).toContain('airs the next morning: Monday, 2026-07-27'); // Saturday
  });
});
