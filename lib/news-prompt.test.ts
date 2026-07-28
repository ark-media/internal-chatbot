import { describe, expect, it } from 'vitest';

import { newsSystemPrompt } from './news-prompt';

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
