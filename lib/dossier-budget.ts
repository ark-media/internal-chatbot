import type { DossierTurn } from './retrieval';

// Single source of truth for head/tail bias when bookending: ceil(cap/2) head,
// floor(cap/2) tail. The fit walk and the final slice both go through this so
// the byte estimate and the applied trim stay aligned.
export function splitHeadTail(cap: number): { head: number; tail: number } {
  const head = Math.ceil(cap / 2);
  return { head, tail: cap - head };
}

// Approximate XML-envelope cost per turn:
//   <dossier_turn id="..." date="..." show="..." episode="...">\n
//   ${speaker}: ${text}\n
//   </dossier_turn>
// 100 is a comfortable upper bound for typical show/episode strings; the
// post-build oversize backstop catches outliers.
const ENVELOPE_CHARS_PER_TURN = 100;

// Returns how many turns fit into budgetChars. In bookend mode, walks
// head/tail symmetrically with the same `h <= t` bias as splitHeadTail —
// after N steps `(h, t) === splitHeadTail(N)`, so the slice the caller
// applies stays consistent with the byte count we measured.
export function fitDossierToBudget(
  turns: DossierTurn[],
  budgetChars: number,
  bookend: boolean,
): number {
  if (bookend) {
    let h = 0;
    let t = 0;
    let chars = 0;
    while (h + t < turns.length) {
      const takeHead = h <= t;
      const turn = takeHead ? turns[h] : turns[turns.length - 1 - t];
      chars += turn.text.length + ENVELOPE_CHARS_PER_TURN;
      if (chars > budgetChars) break;
      if (takeHead) h++;
      else t++;
    }
    return h + t;
  }
  let chars = 0;
  let count = 0;
  for (const turn of turns) {
    chars += turn.text.length + ENVELOPE_CHARS_PER_TURN;
    if (chars > budgetChars) break;
    count++;
  }
  return count;
}

export type TrimResult = {
  turns: DossierTurn[];
  bookend: { headCount: number; tailCount: number } | null;
  truncated: boolean;
};

// Trim a dossier to fit within budgetChars. Bookend mode drops turns from the
// middle inward (so both date ends survive); sequential mode keeps the head
// (matching the existing chronological-asc contract).
//
// minTurns is a floor — even if the budget would force fewer, at least this
// many turns are kept and the caller is expected to log when the floor wins
// past the budget. Three is enough to keep the model from refusing for lack
// of evidence; the post-build oversize backstop is the next line of defense.
export function trimDossierToBudget(opts: {
  turns: DossierTurn[];
  bookend: { headCount: number; tailCount: number } | null;
  budgetChars: number;
  minTurns: number;
}): TrimResult {
  const { turns, bookend, budgetChars, minTurns } = opts;
  const fit = fitDossierToBudget(turns, budgetChars, bookend !== null);
  const cap = Math.max(fit, minTurns);
  if (cap >= turns.length) {
    return { turns, bookend, truncated: false };
  }
  if (bookend !== null) {
    const { head, tail } = splitHeadTail(cap);
    return {
      turns: [...turns.slice(0, head), ...turns.slice(turns.length - tail)],
      bookend: { headCount: head, tailCount: tail },
      truncated: true,
    };
  }
  return { turns: turns.slice(0, cap), bookend: null, truncated: true };
}
