// Shared types for the news script orchestrator. Stored in DB as JSONB so
// keep these JSON-serializable.

export type Article = {
  title: string;
  url: string;
  publicationDate: string | null;
  source: string;
  content: string;
  isFlagged?: boolean;
  fetchError?: string;
};

export type RatedArticle = {
  article: Article;
  relevance: number;
  credibility: number;
  completeness: number;
  avgScore: number;
  // Distill-stage handoff to script-craft. Optional because articles added via
  // /refetch or /attach bypass the distill pass and don't have these.
  summary?: string;
  keyQuotes?: string[];
  // 'distilled' = AI rated; 'refetched' = AI fetched but not re-rated;
  // 'manual' = writer-attached URL.
  provenance?: 'distilled' | 'refetched' | 'manual';
};

export type TopicWithSources = {
  topic: string;
  description: string;
  articles: RatedArticle[];
};

export type DistillResult = {
  topics: TopicWithSources[];
  rationale: string;
};

export type Script = {
  fullText: string;
  metadata: {
    wordCount: number;
    blockCount: number;
    citedSources: number;
    flagCount: number;
  };
};

export type ReviewProblem = {
  type: 'hard' | 'soft';
  issue: string;
  detail: string;
};

export type ReviewCorrection = {
  blockOrSection: string;
  problem: string;
  suggestedFix: string;
};

export type ReviewResult = {
  problems: ReviewProblem[];
  decision: 'loop' | 'exit';
  corrections: ReviewCorrection[];
};

export type OrchestratorStage =
  | 'gathering'
  | 'checkpoint'
  | 'crafting'
  | 'complete'
  | 'error';

export type RefineEntry = {
  instruction: string;
  at: string;
  version: number;
};

// Persisted run record. The full snapshot lives in JSONB so the API is one
// row read per request — no joins, no migrations when shape evolves.
export type OrchestratorRun = {
  chatId: string;
  stage: OrchestratorStage;
  today: string;
  timezone: string;
  articles: Article[];
  distill: DistillResult | null;
  approvedTopics: TopicWithSources[] | null;
  finalScript: Script | null;
  // The set of topic indices the writer approved at the most recent
  // /generate call. Persisted alongside `approvedTopics` (the materialized
  // snapshot) so that subsequent attach/topics/refetch mutations to
  // `distill.topics` can refresh `approvedTopics` without losing the
  // selection. Indices are into `distill.topics`. Undefined for runs that
  // have never reached crafting.
  approvedTopicIndices?: number[];
  // Append-only stack of prior script versions, oldest first. The current
  // script is always `finalScript`; popping moves the top of this stack into
  // `finalScript`. Empty when no user-driven refines have happened yet.
  scriptVersions: Script[];
  // UI-facing log of user-driven refines. Mirrors `scriptVersions` 1:1.
  refineHistory: RefineEntry[];
  iterations: number;
  errorMessage: string | null;
  // The refineHistory.length captured at the most recent successful
  // save-learn click. Used to dedupe re-clicks: if this matches the current
  // refineHistory.length, there is no new signal to learn from.
  lastDistilledVersion?: number;
  updatedAt: string;
};

// Pure helpers that operate on the run shape. Exported for unit testing and
// reused by both server routes and the orchestrator UI.

// When a topic is deleted at `deletedIndex`, every higher-numbered approved
// index needs to shift down by one and the deleted index itself is dropped.
// Used by /topics route and the client-side rejected-topics renumbering.
export function renumberIndicesAfterDelete(
  indices: number[],
  deletedIndex: number,
): number[] {
  const next: number[] = [];
  for (const i of indices) {
    if (i < deletedIndex) next.push(i);
    else if (i > deletedIndex) next.push(i - 1);
    // Equal: drop.
  }
  return next;
}

// Materialize the approved topic snapshot from the current distill against
// a list of stored indices. Out-of-range indices and topics with no
// articles are filtered out. The result is what gets injected into the
// script-craft cached system block.
export function deriveApprovedTopics(
  topics: TopicWithSources[],
  indices: number[] | undefined,
): TopicWithSources[] {
  if (!indices) return [];
  return indices
    .filter((i) => i >= 0 && i < topics.length)
    .map((i) => topics[i])
    .filter((t) => t.articles.length > 0);
};
