import type { Source } from '@/components/chat-types';

// Build the in-app transcript link for a given source. Pure so it can be
// shared between client (SourcePanel) and tests without dragging in the
// Neon-backed query helpers from `lib/transcript.ts`.
export function transcriptHref(source: Source): string {
  const base = `/transcript/${encodeURIComponent(source.episode_id)}`;
  if (source.kind === 'turn') return `${base}?turn=${source.id}`;
  if (source.kind === 'chunk') return `${base}?chunk=${source.id}`;
  return base;
}
