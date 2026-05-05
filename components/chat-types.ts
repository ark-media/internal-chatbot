import type { UIMessage } from 'ai';

// Unified UI-side source shape. Lookup chunks, dossier turns, and episode
// entries from aggregate tools all map into this structure so SourcePanel can
// render any of them without branching at the call site.
export type Source = {
  kind: 'chunk' | 'turn' | 'episode';
  id: number | string;
  key: string; // "id:<n>" | "turn:<n>" | "ep:<episode_id>"
  episode_id: string; // anchors links into /transcript/<episode_id>
  title: string;
  show: string;
  date: string | null;
  section: string | null;
  speaker: string | null; // set for turns; optionally set for episodes (the guest)
  drive_url: string | null;
  excerpt: string; // empty for 'episode' sources — no transcript body inline
};

// Shapes emitted by the server-side tools. Keep these loose (all optional)
// to tolerate in-flight tool calls where `output` is not yet populated.
export type LookupToolOutput = {
  chunks?: Array<{
    id: number;
    episode_id: string;
    show: string;
    title: string;
    date: string | null;
    section: string | null;
    drive_url: string | null;
    excerpt: string;
  }>;
  note?: string;
};

export type DossierToolOutput = {
  turns?: Array<{
    id: number;
    episode_id: string;
    episode_title: string;
    show: string;
    date: string | null;
    section: string | null;
    speaker: string;
    drive_url: string | null;
    excerpt: string;
  }>;
  totalCount?: number;
  hasMore?: boolean;
};

export type TopGuestsToolOutput = {
  scope?: 'show' | 'group' | 'corpus';
  showName?: string | null;
  groupName?: string | null;
  since?: string | null;
  until?: string | null;
  error?: string;
  note?: string;
  candidates?: string[];
  guests?: Array<{
    rank: number;
    speaker_name: string;
    episode_count: number;
    first_date: string | null;
    last_date: string | null;
    episodes: Array<{
      episode_id: string;
      title: string;
      date: string | null;
      drive_url: string | null;
    }>;
  }>;
};

export type EpisodeRef = {
  episode_id: string;
  title: string;
  date: string | null;
  drive_url: string | null;
};

// Discriminated union of views that can occupy the right-side panel.
// `transcript` carries an optional `previous` so the panel back button can
// restore the source-excerpt view it was opened from instead of just closing.
//
// `quote` (on source/transcript views) is the verbatim substring the model
// attached to a single-ref citation; it lets the renderer pinpoint the exact
// passage inside an otherwise-turn-level highlight.
export type PanelView =
  | { view: 'source'; source: Source; quote?: string }
  | {
      view: 'guest_episodes';
      speakerName: string;
      scope: string; // e.g. "Call me Back", "Call me Back group", "all shows"
      dateRange: string | null;
      episodes: EpisodeRef[];
    }
  | {
      view: 'transcript';
      episode_id: string;
      turnId: number | null;
      chunkId: number | null;
      quote?: string;
      previous: PanelSimpleView | null;
    };

// `transcript` panels remember where they came from but cannot themselves be
// the previous view (no nested back stacks).
export type PanelSimpleView = Exclude<PanelView, { view: 'transcript' }>;

// Evidence the server pre-loads (router-driven dossier or pre-retrieval) and
// surfaces to the client as a `data-preloaded` UI part. Without this, the
// client has no record of chunks/turns cited from the pre-loaded evidence, so
// [id:N] / [turn:N] chips would render as "missing source" placeholders.
export type PreloadedSources = {
  chunks: NonNullable<LookupToolOutput['chunks']>;
  turns: NonNullable<DossierToolOutput['turns']>;
};

export type UsageData = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextWindow: number; // total available tokens
};

export type ChatUIMessage = UIMessage<
  unknown,
  { preloaded: PreloadedSources; usage?: UsageData }
>;

export type CountGuestAppearancesToolOutput = {
  speakerName?: string;
  showName?: string;
  count?: number;
  speakerIsHost?: boolean;
  note?: string;
  error?: string;
  candidates?: Array<{
    canonical_name: string;
    episode_count: number;
    shows: string[];
  }>;
  episodes?: Array<{
    episode_id: string;
    title: string;
    date: string | null;
    drive_url: string | null;
    matched_by: 'turns' | 'title' | 'both';
    turn_count: number;
  }>;
};
