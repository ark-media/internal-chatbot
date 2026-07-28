// Per-show metadata for the episode-prep surface. This module is intentionally
// client-safe (no server-only imports) so the prep page can render the show
// selector, placeholder, and example prompts from the same source of truth the
// API route uses to pick a system prompt.
//
// The prompt TEXT for each show lives server-side in prep-prompt.ts, keyed by
// the same `PrepShowId`. Keep this file to lightweight UI/shared metadata.

export type PrepShowId = 'default' | 'call-me-back' | 'whats-your-number';

export interface PrepShow {
  id: PrepShowId;
  // Label shown in the show selector dropdown.
  label: string;
  // Canonical show name for Drive routing + doc titles. Null for the generic
  // surface, where the show is parsed out of the prompt prefix instead.
  canonical: string | null;
  // Composer placeholder.
  placeholder: string;
  // Example prompts shown in the empty state.
  examplePrompts: string[];
  // One-line empty-state hook.
  blurb: string;
}

export const PREP_SHOWS: PrepShow[] = [
  {
    id: 'default',
    label: 'Any show',
    canonical: null,
    placeholder: 'Episode title + guest',
    examplePrompts: [
      'Call me Back — "Can Israel Afford Another War?" — with Amos Yadlin',
      'For Heaven\'s Sake — "The Future of American Jewry" — with Bari Weiss',
      'Call me Back — "Iran after the strikes" — with Ray Takeyh',
    ],
    blurb: 'Give an episode title + guest. Get 6–7 questions in a deliberate arc.',
  },
  {
    id: 'call-me-back',
    label: 'Call me Back',
    canonical: 'Call me Back',
    placeholder: 'Episode title + guest',
    examplePrompts: [
      'Call me Back — "Can Israel Afford Another War?" — with Amos Yadlin',
      'Call me Back — "Iran after the strikes" — with Ray Takeyh',
      'Call me Back — "The day after in Gaza" — with Nadav Eyal',
    ],
    blurb: 'Give an episode title + guest. Get 6–7 questions in a deliberate arc.',
  },
  {
    id: 'whats-your-number',
    label: "What's Your Number?",
    canonical: "What's Your Number?",
    placeholder: 'Guest + their role/company + the economic angle',
    examplePrompts: [
      "What's Your Number? — the AI boom and the shekel — with a Bank of Israel economist",
      "What's Your Number? — defense-tech after the war — with a Tenzai executive",
      "What's Your Number? — Israel's startup exits in a down market — with a VC general partner",
    ],
    blurb:
      'Name the guest, their role, and the economic angle. Get an intro script, a focused interview, and a tailored rapid-fire round.',
  },
];

export const DEFAULT_PREP_SHOW_ID: PrepShowId = 'default';

const PREP_SHOWS_BY_ID = new Map<PrepShowId, PrepShow>(
  PREP_SHOWS.map((s) => [s.id, s]),
);

// Resolve a (possibly untrusted) show id to a known config, falling back to the
// default surface for anything unrecognized.
export function getPrepShow(id: string | null | undefined): PrepShow {
  if (id && PREP_SHOWS_BY_ID.has(id as PrepShowId)) {
    return PREP_SHOWS_BY_ID.get(id as PrepShowId)!;
  }
  return PREP_SHOWS_BY_ID.get(DEFAULT_PREP_SHOW_ID)!;
}
