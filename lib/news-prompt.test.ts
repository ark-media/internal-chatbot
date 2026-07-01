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

      // A translate-and-adapt run dropped the draft's two song cues entirely
      // (omission, not a cold insert), so the writer must be told supplied
      // music/anthem/ambient cues have to survive into the script and be framed.
      it('forbids silently dropping a supplied music, song, or ambient cue', () => {
        expect(prompt).toContain(
          'Never silently drop a supplied music, song, anthem, or ambient-sound cue',
        );
        expect(prompt).toContain('Omitting the cue entirely is a failure');
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

  it('names all six understanding dimensions', () => {
    for (const dimension of [
      'What happened',
      'Why it matters',
      'Going forward',
      'Daily trigger',
      'Surrounding context and timeline',
      'Figures to verify',
    ]) {
      expect(chat).toContain(dimension);
    }
  });

  // The readback is where the writer commits to the corrected figure BEFORE
  // drafting — locking it in here is what keeps the correction in the spoken
  // narration instead of a footnote (Factual Accuracy Rule 9).
  it('makes the writer verify draft figures during the readback, before drafting', () => {
    expect(chat).toContain('Figures to verify');
    expect(chat).toContain('commit now to putting the sourced value in the spoken narration');
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

describe('newsSystemPrompt — breaking-news scan Phase 1 (chat mode only)', () => {
  const chat = newsSystemPrompt('chat');
  const orchestrator = newsSystemPrompt('orchestrator');

  it('adds a Phase-1 scan section that hard-gates on scanBreakingNews first', () => {
    expect(chat).toContain('Breaking-News Scan — Phase 1');
    expect(chat).toContain('scanBreakingNews');
    expect(chat).toContain('HARD GATE');
    expect(chat).toContain('Call the `scanBreakingNews` tool FIRST');
  });

  it('forbids editing or drafting the script on the scan turn — suggestions only', () => {
    expect(chat).toContain('Do NOT edit, rewrite, draft, re-order, or auto-swap the script on this turn');
    expect(chat).toContain('surfacing suggestions ONLY');
  });

  it('distinguishes the scan intent from the first-turn gather+confirm drafting flow', () => {
    expect(chat).toContain('Distinguish the scan intent from the first-turn');
    expect(chat).toContain('NOT a request to write a new script');
  });

  it('does NOT leak the scan gate into the orchestrator (batch) path', () => {
    expect(orchestrator).not.toContain('Breaking-News Scan');
    expect(orchestrator).not.toContain('scanBreakingNews');
  });
});

describe('newsSystemPrompt — breaking-news scan Phase 2 (chat mode only)', () => {
  const chat = newsSystemPrompt('chat');

  it('adds a Phase-2 accept-and-integrate section gated on the understanding readback', () => {
    expect(chat).toContain('Breaking-News Scan — Phase 2');
    expect(chat).toContain('ONLY when the writer accepts a specific suggestion');
    expect(chat).toContain('five-dimension understanding gate');
  });

  it('scopes the gate to understanding-only and per-story', () => {
    expect(chat).toContain('understanding-readback ONLY');
    expect(chat).toContain('do NOT re-run corroboration or significance');
    expect(chat).toContain('accepting one suggestion does NOT integrate the others');
  });

  it('describes integration: replace displaced block (Swap) or revise affected block (Update), update SOURCES, no preamble', () => {
    expect(chat).toContain('replace the displaced block');
    expect(chat).toContain('revise the affected block');
    expect(chat).toContain('Update the `SOURCES:` list');
    expect(chat).toContain('with NO preamble');
  });
});
