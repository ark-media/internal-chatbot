import type { UIMessage } from 'ai';
import type { ScanResult } from '@/lib/orchestrator/breaking-scan';

export type FetchArticleToolOutput = {
  url?: string;
  title?: string;
  text?: string;
  date?: string | null;
  source?: string;
  ok?: boolean;
  reason?: string;
  note?: string;
};

export type SearchCorpusToolOutput = {
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

export type WebSearchToolOutput = {
  results?: Array<{
    title: string;
    url: string;
    snippet: string;
    published: string | null;
  }>;
  note?: string;
};

export type NewsSource = {
  id: string;
  number: number;
  title: string;
  date: string | null;
  url: string;
};

// Re-export the scan result shape so the UI can type the breaking-suggestions
// data part it renders.
export type { ScanResult, Suggestion, Tier } from '@/lib/orchestrator/breaking-scan';

// Accumulated breaking-scan progress, streamed as a single reconciled
// `data-breaking-progress` part (stable id) that the route updates as each
// pipeline stage completes. Fields fill in as stages finish; the UI renders a
// live checklist. Ephemeral — never persisted, so it vanishes on reload.
export type ScanProgressSnapshot = {
  started?: boolean;
  discovered?: number;
  afterExclusion?: number;
  afterNovelty?: number;
  grading?: boolean;
  suggestions?: number;
};

// Typed UI data parts streamed by the news route. `breaking-suggestions` is the
// scanBreakingNews tool's tiered output; the part type on the wire is
// `data-breaking-suggestions`, mirroring the existing `data-sources` pattern.
// `breaking-progress` is the live pipeline checklist (transient, id-reconciled).
export type NewsDataParts = {
  'breaking-suggestions': ScanResult;
  'breaking-progress': ScanProgressSnapshot;
};

export type NewsUIMessage = UIMessage<unknown, NewsDataParts>;
