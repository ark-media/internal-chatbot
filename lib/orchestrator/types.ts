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
  iterations: number;
  errorMessage: string | null;
  updatedAt: string;
};
