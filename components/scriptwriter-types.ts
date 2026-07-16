// Typed UI data parts streamed by /api/news/orchestrator/chat, plus the run
// shape the client fetches for card state. Mirrors news-types.ts.

import type { UIMessage } from 'ai';
import type { ScriptRun } from '@/lib/scriptwriter/types';

// Accumulated sourcing progress, streamed as one id-reconciled part. Fields
// fill in as pipeline steps finish; true = started, number = count.
export type SourcingProgressData = {
  discovering?: number | true;
  discovered?: number | true;
  ranking?: number | true;
  selected?: number | true;
  extracting?: number | true;
  distilling?: number | true;
  ready?: number | true;
};

export type TopicCardSource = {
  title: string;
  url: string;
  source: string;
  publicationDate: string | null;
  credibility: number;
  credibilityNote: string;
  isFlagged: boolean;
  fetchError: string | null;
};

export type TopicCardData = {
  index: number;
  slot: 'A' | 'B' | 'C';
  headline: string;
  stage: string;
  hasContract: boolean;
  blockVersion: number;
  editorNotes: string[];
  angle: string;
  rationale: string;
  register: 'hard-news' | 'human-interest';
  sources: TopicCardSource[];
};

export type BlockPartData = {
  slot: 'A' | 'B' | 'C';
  topicIndex: number;
  text: string;
  status: 'streaming' | 'review' | 'ready';
  version: number;
  editorNotes?: string[];
  hardFixApplied?: boolean;
};

export type EpisodePartData = {
  text: string;
  status: 'streaming' | 'ready';
  usedFallback?: boolean;
};

export type ScriptwriterDataParts = {
  'sourcing-progress': SourcingProgressData;
  topics: TopicCardData[];
  block: BlockPartData;
  episode: EpisodePartData;
};

export type ScriptwriterUIMessage = UIMessage<unknown, ScriptwriterDataParts>;

export type { ScriptRun };
