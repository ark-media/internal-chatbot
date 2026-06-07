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

// A discovered-but-not-yet-extracted article reference — what the writer sees
// and triages before grouping. Produced by Gemini discovery or keyword
// search; URL verification and Tavily extraction are deferred to /group so
// they run only on the survivors. `isFlagged` is the freshness flag, computed
// against the run's `today` when the candidate enters the run.
export type Candidate = {
  title: string;
  url: string;
  source: string;
  publicationDate: string | null;
  isFlagged?: boolean;
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
  | 'triage'
  | 'checkpoint'
  | 'crafting'
  | 'complete'
  | 'error'
  // Document-driven flow (mode: 'document'). These precede 'checkpoint',
  // which the doc flow reuses as its "deepen" stage:
  //   extracting → extracted(✓) → arranging → arranged(✓) → checkpoint → …
  | 'extracting' // agent is parsing the uploaded dossier
  | 'extracted' // checkpoint: editor reviews the extracted stories
  | 'arranging' // arc agent is running
  | 'arranged'; // checkpoint: editor approves the narrative arc

// A single source/link pulled from the dossier for one story. The dossier is
// trusted as source-of-truth at extract time (no live re-fetch), so `facts`
// and `sotClips` carry the editor-curated content the script writer works from.
export type ExtractedSource = {
  label: string; // link text / outlet name, e.g. "Reuters"
  url: string;
  facts?: string[]; // dry facts attributable to this specific source
  sotClips?: { speaker: string; text: string }[]; // verbatim SOT quotes
};

// One story extracted from the editor's dossier at Stage 1. Edited at the
// 'extracted' checkpoint, arranged at 'arranged', then mapped onto
// TopicWithSources (see extractedStoryToTopic) so the existing script writer
// consumes it unchanged.
export type ExtractedStory = {
  id: string; // server-assigned uuid; referenced by NarrativeArc + dnd reorder
  headline: string;
  lead?: string;
  dryFacts: string[]; // story-level facts not bound to a single source
  relevance: string; // Ark's "Why it matters" analysis
  whatsNext?: string;
  blockHint?: 'A' | 'B' | 'C' | 'D'; // parsed from "A BLOCK" labels, if present
  sources: ExtractedSource[];
};

// The narrative arc the editor approves at Stage 2. `order` lists story ids
// lead-first; transitions bridge each story to the next.
export type NarrativeArc = {
  order: string[]; // ExtractedStory ids, lead first
  leadId: string;
  roles: Record<string, 'A' | 'B' | 'C' | 'D'>; // storyId → block role
  transitions: Record<string, string>; // storyId → 1-line bridge into the next story
  rationale: string;
};

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
  // The triage list: raw discovery/search candidates the writer ranks and
  // prunes before grouping. Populated by `discover` /start; empty for `urls`
  // and `topics` modes, which skip triage. Survivors are verified + extracted
  // into `articles` by /group.
  candidates: Candidate[];
  // Overflow from discovery — candidates that ranked below the top-N triage
  // list. The writer can browse and promote any of these into `candidates`
  // via a "See more" panel in the triage UI. Optional for backwards compat
  // with runs that pre-date this field.
  extraCandidates?: Candidate[];
  // Extracted article pool. Populated at /group for `discover` runs, at
  // /start for `urls`/`topics`. Checkpoint-stage gathers (attach/refetch/
  // topics) append here.
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
  // Document-driven flow (mode: 'document'). All optional for backwards compat
  // with web-discovery runs that never populate them.
  // Raw parsed dossier markdown — kept for audit and re-extract.
  sourceDocument?: string;
  // Stage-1 output; the editable structure at the 'extracted' checkpoint.
  extractedStories?: ExtractedStory[];
  // Stage-2 suggestion plus the editor's overrides.
  arc?: NarrativeArc | null;
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

// Reorder a URL-keyed list to match `urlOrder`. Items appear in the sequence
// `urlOrder` gives; any item whose URL is missing from `urlOrder` is appended
// at the end in its original relative order — a defensive fallback, since a
// well-formed triage reorder is an exact permutation. URLs in `urlOrder` that
// match no item are ignored. Used by the /triage `reorder` action; exported
// for unit testing.
export function reorderByUrl<T extends { url: string }>(
  items: T[],
  urlOrder: string[],
): T[] {
  const byUrl = new Map(items.map((x) => [x.url, x]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const url of urlOrder) {
    const x = byUrl.get(url);
    if (x && !seen.has(url)) {
      ordered.push(x);
      seen.add(url);
    }
  }
  for (const x of items) {
    if (!seen.has(x.url)) ordered.push(x);
  }
  return ordered;
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

// Hostname of a URL, or '' for bare/empty/invalid URLs. Used to populate
// Article.source for doc-extracted sources.
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Format a SOT clip into a single keyQuotes string, preserving the speaker
// attribution that's read on air. The verbatim text is kept intact; the
// speaker is prefixed (e.g. `TRUMP: the quote`) so the writer knows who said
// it. A blank/placeholder speaker is dropped so the quote isn't prefixed with
// noise.
function formatSotClip(clip: { speaker: string; text: string }): string {
  const speaker = clip.speaker.trim();
  return speaker ? `${speaker}: ${clip.text}` : clip.text;
}

// Map one extracted story onto the TopicWithSources shape the script writer
// consumes. The dossier is the source-of-truth: facts go into RatedArticle
// `summary`, SOT quotes into `keyQuotes`, and `article.content` is left empty
// (buildSourceBlock prefers summary/quotes over content). publicationDate is
// null + isFlagged false so the freshness logic doesn't tag doc sources as
// stale. A story with no sources gets a single placeholder so it survives the
// "topics must have >=1 article" check in /generate; the writer will FLAG the
// missing citation, which is correct.
export function extractedStoryToTopic(story: ExtractedStory): TopicWithSources {
  const description = [
    story.lead ? `Lead: ${story.lead}` : null,
    `Why it matters: ${story.relevance}`,
    story.whatsNext ? `What's next: ${story.whatsNext}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const articles: RatedArticle[] = story.sources.map((src, i) => {
    // Fold story-level dryFacts onto the first source so they reach the writer.
    const facts = [...(src.facts ?? [])];
    if (i === 0 && story.dryFacts.length > 0) facts.unshift(...story.dryFacts);
    return {
      article: {
        title: src.label || hostnameOf(src.url) || story.headline,
        url: src.url,
        publicationDate: null,
        source: hostnameOf(src.url) || src.label || 'editor dossier',
        content: '',
        isFlagged: false,
      },
      relevance: 75,
      credibility: 75,
      completeness: 75,
      avgScore: 75,
      summary: facts.join(' '),
      keyQuotes: (src.sotClips ?? []).map(formatSotClip),
      provenance: 'manual',
    };
  });

  if (articles.length === 0) {
    articles.push({
      article: {
        title: story.headline,
        url: '',
        publicationDate: null,
        source: 'editor dossier',
        content: '',
        isFlagged: false,
      },
      relevance: 75,
      credibility: 75,
      completeness: 75,
      avgScore: 75,
      summary: story.dryFacts.join(' '),
      keyQuotes: [],
      provenance: 'manual',
    });
  }

  return { topic: story.headline, description, articles };
}

// Order stories by `order` (story ids): ids present in `order` come first in
// that exact sequence (duplicates and unknown ids ignored), then any stories
// missing from `order` are appended in their original relative order. This is
// the single source of truth for arc ordering — the arrange route relies on
// the same sequence to line topic `i` up with its story, so both call here
// rather than re-deriving the order independently.
export function orderStoriesById(
  stories: ExtractedStory[],
  order?: string[],
): ExtractedStory[] {
  if (!order || order.length === 0) return stories;
  const byId = new Map(stories.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const front: ExtractedStory[] = [];
  for (const id of order) {
    const s = byId.get(id);
    if (s && !seen.has(id)) {
      front.push(s);
      seen.add(id);
    }
  }
  const rest = stories.filter((s) => !seen.has(s.id));
  return [...front, ...rest];
}

// Materialize a DistillResult from extracted stories. `order` (story ids,
// arc order) reorders the topics; ids missing from `order` are appended in
// their original relative order, and unknown ids are ignored.
export function extractedStoriesToDistill(
  stories: ExtractedStory[],
  order?: string[],
): DistillResult {
  return {
    topics: orderStoriesById(stories, order).map(extractedStoryToTopic),
    rationale: 'Extracted from editor dossier.',
  };
}
