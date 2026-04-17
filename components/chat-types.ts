// Unified UI-side source shape. Both lookup chunks and dossier turns map into
// this structure so that MessageText / Citation / SourcePanel can render
// either without branching.
export type Source = {
  kind: 'chunk' | 'turn';
  id: number;
  key: string; // "id:<n>" for chunks, "turn:<n>" for turns
  title: string; // chunk: episode title; turn: episode title
  show: string;
  date: string | null;
  section: string | null;
  speaker: string | null; // only set for turns
  drive_url: string | null;
  excerpt: string;
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
