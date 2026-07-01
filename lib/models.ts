// Shared model registry. Imported by both server (api/chat/route.ts) and
// client (ModelSelector.tsx) — keep this module free of `'use client'`
// directives and server-only deps so it works in both contexts.

export type ChatModel = {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
};

export const MODELS: ChatModel[] = [
  {
    id: 'anthropic/claude-haiku-4-5',
    name: 'Claude Haiku',
    description: 'Fast and lightweight. Best for quick answers.',
    contextWindow: 200_000,
  },
  {
    id: 'anthropic/claude-sonnet-5',
    name: 'Claude Sonnet 5',
    description: 'Balanced speed and near-Opus intelligence. Recommended.',
    contextWindow: 200_000,
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Previous-generation Sonnet. Balanced speed and intelligence.',
    contextWindow: 200_000,
  },
  {
    id: 'anthropic/claude-opus-4-7',
    name: 'Claude Opus',
    description: 'Most capable. Best for complex reasoning.',
    // 200k is the standard Opus context. The 1M-token window is gated behind
    // tier-specific access; underreporting here would tell users they have
    // less context than they actually do, but reporting 1M when they don't
    // have access shows misleadingly low usage. Default to the conservative,
    // always-correct value.
    contextWindow: 200_000,
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    description: "OpenAI's latest. Excellent all-around performance.",
    contextWindow: 128_000,
  },
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'High capability with lower latency.',
    contextWindow: 128_000,
  },
  {
    id: 'google/gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    description: "Google's fast and efficient model.",
    contextWindow: 1_000_000,
  },
  {
    id: 'google/gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    description: "Google's most capable model for complex tasks.",
    contextWindow: 2_000_000,
  },
];

// The model selected by default in the UI and used as the server-side fallback
// when a request arrives without an `x-model` header. Named explicitly rather
// than encoded as an array index so the default can't drift when MODELS is
// reordered.
export const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-5';

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getContextWindow(modelId: string): number {
  return MODELS.find((m) => m.id === modelId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}
