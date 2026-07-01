import { describe, expect, it } from 'vitest';

import { newsSystemPrompt } from './news-prompt';

describe('newsSystemPrompt — verbatim user-supplied quotes/SOT', () => {
  // The writer runs at temperature 0.5 for lexical variety, so without an
  // explicit rule it will happily reword a quote the user pasted in. Both the
  // chat path (app/api/news) and the orchestrator path (script-craft) share
  // this prompt, so the rule must survive in BOTH modes — deleting it from one
  // silently regresses on-air fidelity for whichever path lost it.
  for (const mode of ['chat', 'orchestrator'] as const) {
    describe(`${mode} mode`, () => {
      const prompt = newsSystemPrompt(mode);

      it('instructs the writer to reproduce user-supplied quotes word-for-word', () => {
        expect(prompt).toContain('Verbatim rule for user-supplied quotes and SOT');
        expect(prompt).toContain('reproduce that text word-for-word');
      });

      it('forbids paraphrasing, trimming, and normalizing the quoted text', () => {
        expect(prompt).toContain(
          'Do NOT paraphrase, reword, trim, expand, "smooth," or normalize',
        );
      });

      it('still requires the writer to frame the quote (never drop it in cold)', () => {
        expect(prompt).toContain('never drop it in cold');
      });

      it('scopes the override to the quoted text only, not the surrounding voice', () => {
        expect(prompt).toContain('the quoted text only');
      });

      it('lives in the Soundbite Clips section, next to the SPEAKER format', () => {
        const soundbiteStart = prompt.indexOf('== Soundbite Clips ==');
        const footnotesStart = prompt.indexOf('== Inline Footnotes ==');
        const ruleStart = prompt.indexOf(
          'Verbatim rule for user-supplied quotes and SOT',
        );
        expect(soundbiteStart).toBeGreaterThanOrEqual(0);
        expect(footnotesStart).toBeGreaterThan(soundbiteStart);
        expect(ruleStart).toBeGreaterThan(soundbiteStart);
        expect(ruleStart).toBeLessThan(footnotesStart);
      });

      it('tells the writer to spread clips across the whole script, not front-load', () => {
        expect(prompt).toContain('Distribute clips across the whole script');
        expect(prompt).toContain('Do NOT front-load them');
        // The C-block close is where clips consistently go missing.
        expect(prompt).toContain('including the C-block close, can and should carry a clip');
      });

      it('still tells the writer not to stack or cluster clips within a block', () => {
        expect(prompt).toContain(
          'do not stack them back-to-back or cluster them all at the opening or the close',
        );
      });

      // The writer had live web search but kept reading the draft's wrong
      // "80 countries" on air while parking the correction in a SOURCES line
      // the listener never hears. Both paths can fact-check draft figures, so
      // the rule must hold in both modes.
      it('requires a verified correction to land in the spoken narration, not the footnotes', () => {
        expect(prompt).toContain(
          'Corrections belong in the spoken text, not the footnotes',
        );
        expect(prompt).toContain('put the CORRECTED value in the broadcast narration');
        expect(prompt).toContain(
          'a caveat parked in SOURCES is invisible to them',
        );
      });
    });
  }
});

describe('newsSystemPrompt — confirm-understanding gate (chat mode only)', () => {
  // In the interactive chat path the writer hands over notes and links, and the
  // assistant must read back its understanding of the story BEFORE drafting, so
  // the writer can correct a misread cheaply. The orchestrator path is an
  // automated batch pipeline with no tools and no writer to confirm with, so the
  // gate must NOT appear there — otherwise the pipeline stalls waiting for a
  // confirmation that never comes.
  const chat = newsSystemPrompt('chat');
  const orchestrator = newsSystemPrompt('orchestrator');

  it('requires the writer to confirm understanding before the script is written', () => {
    expect(chat).toContain('First Turn: Gather, Then Confirm Understanding');
    expect(chat).toContain('before writing any script');
    expect(chat).toContain('Do not write the script on this turn');
  });

  it('names all five understanding dimensions', () => {
    for (const dimension of [
      'What happened',
      'Why it matters',
      'Going forward',
      'Daily trigger',
      'Surrounding context and timeline',
    ]) {
      expect(chat).toContain(dimension);
    }
  });

  it('distinguishes ongoing events from discrete/limited events in the timeline check', () => {
    expect(chat).toContain('ongoing event');
    expect(chat).toContain('discrete, limited event');
  });

  it('gates script-writing on the writer confirming, then forbids preamble', () => {
    const confirmGate = chat.indexOf('Wait for the writer to confirm');
    const writeSection = chat.indexOf('== Writing the Script ==');
    const noPreamble = chat.indexOf('Do not write any preamble before the script');
    expect(confirmGate).toBeGreaterThanOrEqual(0);
    expect(writeSection).toBeGreaterThan(confirmGate);
    expect(noPreamble).toBeGreaterThan(writeSection);
  });

  it('does NOT add the confirmation gate to the orchestrator (batch) path', () => {
    expect(orchestrator).not.toContain('Confirm Understanding');
    expect(orchestrator).not.toContain('Do not write the script on this turn');
  });
});
