import type { UIMessage } from 'ai';

export type SearchCorpusToolOutput = {
  resolvedGuest?: string | null;
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

export type PastGuestAppearancesToolOutput = {
  found?: boolean;
  speakerName?: string;
  totalTurns?: number;
  episodeCount?: number;
  shows?: string[];
  turns?: Array<{
    id: number;
    episode_title: string;
    show: string;
    date: string | null;
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

export type PrepUIMessage = UIMessage<unknown, Record<string, never>>;
