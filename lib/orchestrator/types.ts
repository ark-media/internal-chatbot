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
  // Per-topic arc decisions, read by buildSourceBlock. Kept off `description`
  // so that rewriting a description can't clobber or double-fold them.
  block?: 'A' | 'B' | 'C' | 'D';
  transition?: string; // one-line bridge into the next topic in arc order
};

// A discovered-but-not-yet-extracted article reference — what the writer sees
// and triages before grouping. Produced by Gemini discovery or keyword
// search; URL verification and Tavily extraction are deferred so they run
// only on the survivors. `isFlagged` is the freshness flag, computed against
// the run's `today` when the candidate enters the run.
export type Candidate = {
  title: string;
  url: string;
  source: string;
  publicationDate: string | null;
  isFlagged?: boolean;
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
