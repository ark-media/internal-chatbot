import type { UIMessage } from 'ai';

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

export type NewsUIMessage = UIMessage<unknown, Record<string, never>>;
