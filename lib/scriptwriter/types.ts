// Shared types for the scriptwriter orchestrator (the 3-stage conversational
// pipeline: source → understand → write). Persisted as JSONB, so everything
// here must stay JSON-serializable.

export type BlockSlot = 'A' | 'B' | 'C';

// 'sourcing-active' is the in-flight marker: a run is claimed for discovery
// exactly once by flipping 'sourcing' → 'sourcing-active' (see claimSourcing).
// It is deliberately distinct from 'sourcing' so a concurrent request can tell
// "needs sourcing" apart from "already sourcing" and refuse to run it twice.
export type RunStage =
  | 'sourcing'
  | 'sourcing-active'
  | 'working'
  | 'assembling'
  | 'complete'
  | 'error';

// Per-topic lifecycle. Topics are independent — there is no sequential cursor;
// the writer works any topic whose preconditions are met, in any order.
export type TopicStage =
  | 'proposed' // surfaced by sourcing, not yet discussed
  | 'understanding' // six-dimension readback presented, awaiting confirmation
  | 'confirmed' // contract confirmed; block can be drafted
  | 'drafting' // Opus draft in flight
  | 'revising' // draft exists, writer requested changes
  | 'approved'; // writer signed off on the block

// The writer-defined task scope, parsed from the original prompt. Drives how
// many stories sourcing returns, which block registers are in play, and
// whether episode assembly runs at the end.
export type Scope =
  | { type: 'episode' }
  | { type: 'blocks'; slots: BlockSlot[] }
  | { type: 'single'; slot: BlockSlot; storyHint?: string };

// One source backing a story. With no outlet allowlist, the model's explicit
// credibility judgment is the writer's trust signal.
export type StorySource = {
  url: string;
  title: string;
  source: string; // outlet / account name
  publicationDate: string | null;
  credibility: number; // 0–100, judged per source by the selector
  credibilityNote: string; // one line on why (outlet track record, sourcing, etc.)
  content?: string; // extracted full text (top stories only)
  summary?: string; // distilled 2–4 sentence contribution
  keyQuotes?: string[]; // verbatim quotes for on-air attribution
  isFlagged?: boolean; // outside the freshness window
  fetchError?: string;
};

export type StoryRegister = 'hard-news' | 'human-interest';

export type StoryProposal = {
  headline: string;
  angle: string; // the story's framing for this show
  rationale: string; // why this is one of the most interesting stories today
  blockSlot: BlockSlot;
  register: StoryRegister;
  sources: StorySource[];
};

export type BlockVersion = {
  text: string;
  version: number;
  instruction: string | null; // revision instruction that produced it; null for the initial draft
};

export type TopicRun = {
  stage: TopicStage;
  story: StoryProposal;
  // The confirmed six-dimension read — live and cumulative. Amended in place
  // as the writer changes the analysis.
  contract: string | null;
  block: { text: string; version: number } | null;
  blockVersions: BlockVersion[]; // prior versions, oldest first (undo stack)
  reviewNotes: string[]; // soft editor notes from the single review pass
};

export type EpisodeVersion = {
  fullText: string;
  instruction: string;
};

export type ScriptRun = {
  chatId: string;
  stage: RunStage;
  today: string;
  timezone: string;
  scope: Scope;
  originalPrompt: string | null;
  // Raw discovery pool (snippet-level), kept for audit and replaceTopic.
  candidates: Array<{
    title: string;
    url: string;
    source: string;
    publicationDate: string | null;
  }>;
  backups: StoryProposal[];
  topics: TopicRun[];
  episode: { fullText: string } | null;
  episodeVersions: EpisodeVersion[]; // undo stack, oldest first
  // Total revise instructions applied (blocks + episode). save-learn compares
  // this against lastDistilledVersion for idempotency.
  revisionCount: number;
  lastDistilledVersion?: number;
  errorMessage: string | null;
  // Editorial note from sourcing when the pool couldn't fully fill the scope
  // (thin rundown, out-of-window fallbacks). Distinct from errorMessage: not a
  // failure, just context the conductor uses to explain gaps honestly.
  sourcingNote?: string | null;
  updatedAt: string;
  // Monotonic row version, bumped on every persist. Kept for optimistic-
  // concurrency use; the sourcing claim now CASes on stage (see claimSourcing).
  version: number;
};

// -- Pure helpers (unit-tested reducers) --------------------------------------

export function newRun(opts: {
  chatId: string;
  today: string;
  timezone: string;
  originalPrompt?: string | null;
}): ScriptRun {
  return {
    chatId: opts.chatId,
    stage: 'sourcing',
    today: opts.today,
    timezone: opts.timezone,
    scope: { type: 'episode' },
    originalPrompt: opts.originalPrompt ?? null,
    candidates: [],
    backups: [],
    topics: [],
    episode: null,
    episodeVersions: [],
    revisionCount: 0,
    errorMessage: null,
    sourcingNote: null,
    updatedAt: new Date(0).toISOString(),
    version: 0,
  };
}

// The block slots the scope asks for, in on-air order.
export function slotsInScope(scope: Scope): BlockSlot[] {
  const order: BlockSlot[] = ['A', 'B', 'C'];
  switch (scope.type) {
    case 'episode':
      return order;
    case 'blocks':
      return order.filter((s) => scope.slots.includes(s));
    case 'single':
      return [scope.slot];
  }
}

export function storyCountForScope(scope: Scope): number {
  return slotsInScope(scope).length;
}

// Episode assembly only applies to full-episode scope; for anything narrower
// the approved block(s) are the deliverable.
export function scopeWantsAssembly(scope: Scope): boolean {
  return scope.type === 'episode';
}

export function topicForSlot(run: ScriptRun, slot: BlockSlot): number {
  return run.topics.findIndex((t) => t.story.blockSlot === slot);
}

export function canDraft(topic: TopicRun): boolean {
  return topic.contract !== null && topic.stage !== 'approved';
}

export function allInScopeApproved(run: ScriptRun): boolean {
  const slots = slotsInScope(run.scope);
  if (run.topics.length === 0) return false;
  return slots.every((slot) => {
    const i = topicForSlot(run, slot);
    return i >= 0 && run.topics[i].stage === 'approved';
  });
}

// -- Reducers. Each returns a new run; the caller persists. -------------------

function withTopic(run: ScriptRun, index: number, next: TopicRun): ScriptRun {
  const topics = run.topics.slice();
  topics[index] = next;
  return { ...run, topics };
}

export function startTopic(run: ScriptRun, index: number): ScriptRun {
  const t = run.topics[index];
  if (!t) throw new Error(`no topic at index ${index}`);
  if (t.stage !== 'proposed' && t.stage !== 'understanding') {
    throw new Error(`topic ${index} is ${t.stage}; cannot re-enter the understanding gate`);
  }
  return withTopic(run, index, { ...t, stage: 'understanding' });
}

export function confirmContract(run: ScriptRun, index: number, contract: string): ScriptRun {
  const t = run.topics[index];
  if (!t) throw new Error(`no topic at index ${index}`);
  const trimmed = contract.trim();
  if (!trimmed) throw new Error('contract must be non-empty');
  // Amending an already-drafted topic keeps its drafting/revising stage; a
  // fresh confirmation moves proposed/understanding → confirmed.
  const stage: TopicStage =
    t.stage === 'proposed' || t.stage === 'understanding' ? 'confirmed' : t.stage;
  return withTopic(run, index, { ...t, contract: trimmed, stage });
}

export function recordBlockDraft(run: ScriptRun, index: number, text: string): ScriptRun {
  const t = run.topics[index];
  if (!t) throw new Error(`no topic at index ${index}`);
  if (t.contract === null) throw new Error(`topic ${index} has no confirmed contract`);
  if (t.stage === 'approved') throw new Error(`topic ${index} is approved; revise it explicitly to redraft`);
  const version = (t.block?.version ?? 0) + 1;
  const blockVersions = t.block
    ? [...t.blockVersions, { ...t.block, instruction: null }]
    : t.blockVersions;
  return withTopic(run, index, {
    ...t,
    stage: 'revising',
    block: { text, version },
    blockVersions,
    reviewNotes: [],
  });
}

export function recordBlockRevision(
  run: ScriptRun,
  index: number,
  text: string,
  instruction: string,
): ScriptRun {
  const t = run.topics[index];
  if (!t?.block) throw new Error(`topic ${index} has no block to revise`);
  const next = withTopic(run, index, {
    ...t,
    stage: 'revising',
    block: { text, version: t.block.version + 1 },
    blockVersions: [...t.blockVersions, { ...t.block, instruction }],
  });
  return { ...next, revisionCount: run.revisionCount + 1 };
}

export function approveTopicBlock(run: ScriptRun, index: number): ScriptRun {
  const t = run.topics[index];
  if (!t?.block) throw new Error(`topic ${index} has no block to approve`);
  return withTopic(run, index, { ...t, stage: 'approved' });
}

export function recordEpisode(run: ScriptRun, fullText: string): ScriptRun {
  return { ...run, stage: 'complete', episode: { fullText } };
}

export function reviseEpisode(run: ScriptRun, fullText: string, instruction: string): ScriptRun {
  if (!run.episode) throw new Error('no episode to revise');
  return {
    ...run,
    episode: { fullText },
    episodeVersions: [...run.episodeVersions, { fullText: run.episode.fullText, instruction }],
    revisionCount: run.revisionCount + 1,
  };
}

export function undoEpisode(run: ScriptRun): ScriptRun {
  const prev = run.episodeVersions.at(-1);
  if (!prev) throw new Error('no prior episode version to restore');
  return {
    ...run,
    episode: { fullText: prev.fullText },
    episodeVersions: run.episodeVersions.slice(0, -1),
  };
}
