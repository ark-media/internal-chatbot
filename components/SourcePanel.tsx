'use client';

import { X, ExternalLink } from 'lucide-react';
import type { Source } from './chat-types';

type Props = {
  source: Source | null;
  onClose: () => void;
};

function stripExcerptTags(excerpt: string): string {
  return excerpt
    .replace(/^<(?:transcript_excerpt|dossier_turn)[^>]*>\s*/i, '')
    .replace(/\s*<\/(?:transcript_excerpt|dossier_turn)>\s*$/i, '');
}

export function SourcePanel({ source, onClose }: Props) {
  if (!source) return null;
  const body = stripExcerptTags(source.excerpt);
  const labelKind = source.kind === 'turn' ? 'Turn' : 'Excerpt';
  const tag = source.kind === 'turn' ? `t${source.id}` : `${source.id}`;

  return (
    <aside
      className="ark-fade-up relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-[#070b22]/80 backdrop-blur-xl"
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(80% 50% at 50% 0%, rgba(62,181,249,0.14) 0%, transparent 60%)',
        }}
      />

      <header className="relative flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={
                source.kind === 'turn'
                  ? 'inline-flex items-center rounded-md border border-emerald-300/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-emerald-200'
                  : 'inline-flex items-center rounded-md border border-[#3eb5f9]/30 bg-[#3eb5f9]/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[#79cdfc]'
              }
            >
              {labelKind} · {tag}
            </span>
          </div>
          <div
            className="mt-2 truncate text-base font-bold text-white"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {source.title}
          </div>
          <div className="mt-1 text-xs text-white/55">
            <span className="text-[#79cdfc]">{source.show}</span>
            {source.date ? <span className="text-white/35"> · {source.date}</span> : null}
            {source.section ? <span className="text-white/35"> · {source.section}</span> : null}
            {source.speaker ? (
              <span className="text-white/80"> · {source.speaker}</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close source panel"
          className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="relative flex-1 overflow-y-auto px-5 py-5">
        <div className="whitespace-pre-wrap text-[0.92rem] leading-[1.7] text-white/85">
          {body}
        </div>
      </div>

      {source.drive_url && (
        <footer className="relative border-t border-white/10 px-5 py-3">
          <a
            href={source.drive_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#3eb5f9]/10 px-3 py-1.5 text-sm font-medium text-[#79cdfc] transition hover:bg-[#3eb5f9]/20 hover:text-white"
          >
            Open full transcript in Drive
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </footer>
      )}
    </aside>
  );
}
