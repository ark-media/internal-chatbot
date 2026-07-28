import type { UIMessage } from 'ai';
import type { ScanResult } from '@/lib/orchestrator/breaking-scan';

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

// The model's text as it streams, before the reflect pass has had its say.
// Carried as an id-reconciled data part rather than a real text part so the
// reader sees words within seconds while the draft stays visibly provisional —
// and so the authoritative `text` part can be written once, at the end, without
// the two fighting over the same part. `status` is 'streaming' while the writer
// is still typing and 'reviewing' once the editor pass is running over a
// finished script. Never persisted; the final text part is what survives.
export type DraftSnapshot = {
  text: string;
  status: 'streaming' | 'reviewing';
};

// Typed UI data parts streamed by the news route. `breaking-suggestions` is the
// scanBreakingNews tool's tiered output; the part type on the wire is
// `data-breaking-suggestions`, mirroring the existing `data-sources` pattern.
// `breaking-progress` is the live pipeline checklist (transient, id-reconciled).
export type NewsDataParts = {
  'breaking-suggestions': ScanResult;
  'breaking-progress': ScanProgressSnapshot;
  draft: DraftSnapshot;
};

export type NewsUIMessage = UIMessage<unknown, NewsDataParts>;
