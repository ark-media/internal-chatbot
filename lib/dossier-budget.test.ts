import { describe, expect, it } from 'vitest';

import {
  fitDossierToBudget,
  splitHeadTail,
  trimDossierToBudget,
} from './dossier-budget';
import type { DossierTurn } from './retrieval';

// Make a dossier turn with a fixed text length so byte-budget tests are
// deterministic. The constants in dossier-budget assume +100 chars envelope
// per turn, so each turn here costs textLen + 100.
function turn(turnId: number, textLen: number): DossierTurn {
  return {
    turnId,
    turnIndex: 0,
    episodeId: `ep-${turnId}`,
    episodeTitle: 'Title',
    showId: 0,
    showName: 'Show',
    date: '2024-01-01',
    driveUrl: null,
    section: null,
    speakerId: 1,
    speakerName: 'Test Speaker',
    text: 'x'.repeat(textLen),
  };
}

describe('splitHeadTail', () => {
  it('biases head when cap is odd', () => {
    expect(splitHeadTail(5)).toEqual({ head: 3, tail: 2 });
    expect(splitHeadTail(1)).toEqual({ head: 1, tail: 0 });
  });

  it('splits evenly when cap is even', () => {
    expect(splitHeadTail(4)).toEqual({ head: 2, tail: 2 });
    expect(splitHeadTail(0)).toEqual({ head: 0, tail: 0 });
  });
});

describe('fitDossierToBudget — sequential', () => {
  it('returns count of turns that fit cumulative budget', () => {
    const turns = [turn(1, 100), turn(2, 100), turn(3, 100)]; // 200 each
    expect(fitDossierToBudget(turns, 500, false)).toBe(2);
    expect(fitDossierToBudget(turns, 600, false)).toBe(3);
  });

  it('returns 0 when first turn alone exceeds budget', () => {
    const turns = [turn(1, 1000)];
    expect(fitDossierToBudget(turns, 100, false)).toBe(0);
  });
});

describe('fitDossierToBudget — bookend', () => {
  it('walks head and tail symmetrically with head bias', () => {
    // 6 turns, each 200 chars (text + envelope). Budget 500 fits 2.
    const turns = Array.from({ length: 6 }, (_, i) => turn(i + 1, 100));
    const fit = fitDossierToBudget(turns, 500, true);
    expect(fit).toBe(2);
    // After 2 steps, (h, t) === splitHeadTail(2) === { head: 1, tail: 1 } —
    // so the caller's slice [first 1 + last 1] is byte-consistent with the
    // measurement.
    expect(splitHeadTail(fit)).toEqual({ head: 1, tail: 1 });
  });

  it('preserves the splitHeadTail invariant at every step', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1, 50));
    for (let cap = 0; cap <= 10; cap++) {
      // Force fit=cap by sizing the budget to exactly fit cap turns. Each
      // turn costs 150 chars, so cap turns cost cap*150.
      const fit = fitDossierToBudget(turns, cap * 150, true);
      expect(fit).toBe(cap);
      // After fit steps, h+t === fit, with h biased toward ceil(fit/2).
      const split = splitHeadTail(fit);
      expect(split.head + split.tail).toBe(fit);
    }
  });

  it('returns full length when budget exceeds total cost', () => {
    const turns = [turn(1, 50), turn(2, 50), turn(3, 50)];
    expect(fitDossierToBudget(turns, 10_000, true)).toBe(3);
  });
});

describe('trimDossierToBudget', () => {
  it('returns input unchanged when everything fits', () => {
    const turns = [turn(1, 50), turn(2, 50)];
    const result = trimDossierToBudget({
      turns,
      bookend: null,
      budgetChars: 10_000,
      minTurns: 3,
    });
    expect(result.turns).toBe(turns);
    expect(result.truncated).toBe(false);
  });

  it('trims sequential dossier to fit count', () => {
    const turns = [turn(1, 100), turn(2, 100), turn(3, 100), turn(4, 100)];
    const result = trimDossierToBudget({
      turns,
      bookend: null,
      budgetChars: 500, // fits 2 turns
      minTurns: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.turns.map((t) => t.turnId)).toEqual([1, 2]);
    expect(result.bookend).toBeNull();
  });

  it('trims bookend dossier from the middle, keeping both ends', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1, 100));
    const result = trimDossierToBudget({
      turns,
      bookend: { headCount: 5, tailCount: 5 },
      budgetChars: 800, // fits 4 turns (2 head + 2 tail)
      minTurns: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.turns.map((t) => t.turnId)).toEqual([1, 2, 9, 10]);
    expect(result.bookend).toEqual({ headCount: 2, tailCount: 2 });
  });

  it('honors minTurns floor when budget is too tight', () => {
    const turns = Array.from({ length: 5 }, (_, i) => turn(i + 1, 1000));
    const result = trimDossierToBudget({
      turns,
      bookend: null,
      budgetChars: 0,
      minTurns: 3,
    });
    // Floor wins: 3 turns kept even though byte budget said 0.
    expect(result.turns.map((t) => t.turnId)).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(true);
  });

  it('does not truncate when minTurns floor is at or above input length', () => {
    const turns = [turn(1, 1000), turn(2, 1000)];
    const result = trimDossierToBudget({
      turns,
      bookend: null,
      budgetChars: 0,
      minTurns: 3,
    });
    // Floor of 3 ≥ 2-turn input → no truncation, return as-is.
    expect(result.turns).toBe(turns);
    expect(result.truncated).toBe(false);
  });

  it('bookend trim with odd cap biases head', () => {
    const turns = Array.from({ length: 7 }, (_, i) => turn(i + 1, 100));
    const result = trimDossierToBudget({
      turns,
      bookend: { headCount: 3, tailCount: 4 }, // input split is irrelevant — output split derives from fit
      budgetChars: 500, // fits 2 turns
      minTurns: 3, // floor lifts to 3
    });
    // splitHeadTail(3) = { head: 2, tail: 1 } → first 2 + last 1
    expect(result.turns.map((t) => t.turnId)).toEqual([1, 2, 7]);
    expect(result.bookend).toEqual({ headCount: 2, tailCount: 1 });
  });
});
