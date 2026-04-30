'use client';

import Link from 'next/link';
import { X, ExternalLink, FileText } from 'lucide-react';
import type { PanelView, Source } from './chat-types';
import { transcriptHref } from '@/lib/transcript-href';

type Props = {
  panel: PanelView | null;
  onClose: () => void;
};

function stripExcerptTags(excerpt: string): string {
  return excerpt
    .replace(/^<(?:transcript_excerpt|dossier_turn)[^>]*>\s*/i, '')
    .replace(/\s*<\/(?:transcript_excerpt|dossier_turn)>\s*$/i, '');
}

export function SourcePanel({ panel, onClose }: Props) {
  if (!panel) return null;

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

      {panel.view === 'source' ? (
        <SourceBody source={panel.source} onClose={onClose} />
      ) : (
        <GuestEpisodesBody panel={panel} onClose={onClose} />
      )}
    </aside>
  );
}

function SourceBody({
  source,
  onClose,
}: {
  source: Source;
  onClose: () => void;
}) {
  const body = source.kind === 'episode' ? '' : stripExcerptTags(source.excerpt);
  const labelKind =
    source.kind === 'turn'
      ? 'Turn'
      : source.kind === 'episode'
        ? 'Episode'
        : 'Excerpt';
  // Numeric DB ids are useful for chunks/turns; episode_ids are long opaque
  // strings that just clutter the badge, so episodes show no trailing tag.
  const tag =
    source.kind === 'turn'
      ? `t${source.id}`
      : source.kind === 'episode'
        ? null
        : `${source.id}`;

  return (
    <>
      <header className="relative flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={
                source.kind === 'turn'
                  ? 'inline-flex items-center rounded-md border border-emerald-300/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-emerald-200'
                  : source.kind === 'episode'
                    ? 'inline-flex items-center rounded-md border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-amber-200'
                    : 'inline-flex items-center rounded-md border border-[#3eb5f9]/30 bg-[#3eb5f9]/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[#79cdfc]'
              }
            >
              {tag ? `${labelKind} · ${tag}` : labelKind}
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
        <CloseButton onClose={onClose} />
      </header>

      <div className="relative flex-1 overflow-y-auto px-5 py-5">
        {source.kind === 'episode' ? (
          <div className="text-[0.92rem] leading-[1.7] text-white/60">
            {source.speaker
              ? `Appearance by ${source.speaker}.`
              : 'Episode appearance.'}{' '}
            {source.drive_url
              ? 'Open the full transcript in Drive to read.'
              : 'No transcript link available.'}
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-[0.92rem] leading-[1.7] text-white/85">
            {body}
          </div>
        )}
      </div>

      <footer className="relative flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
        <Link
          href={transcriptHref(source)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#3eb5f9]/10 px-3 py-1.5 text-sm font-medium text-[#79cdfc] transition hover:bg-[#3eb5f9]/20 hover:text-white"
        >
          <FileText className="h-3.5 w-3.5" />
          Open in transcript
        </Link>
        {source.drive_url ? (
          <a
            href={source.drive_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-white/45 transition hover:text-white/80"
          >
            Drive
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </footer>
    </>
  );
}

function GuestEpisodesBody({
  panel,
  onClose,
}: {
  panel: Extract<PanelView, { view: 'guest_episodes' }>;
  onClose: () => void;
}) {
  return (
    <>
      <header className="relative flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-amber-200">
              Guest · {panel.episodes.length} ep{panel.episodes.length === 1 ? '' : 's'}
            </span>
          </div>
          <div
            className="mt-2 truncate text-base font-bold text-white"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {panel.speakerName}
          </div>
          <div className="mt-1 text-xs text-white/55">
            <span className="text-[#79cdfc]">{panel.scope}</span>
            {panel.dateRange ? (
              <span className="text-white/35"> · {panel.dateRange}</span>
            ) : null}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      <div className="relative flex-1 overflow-y-auto px-5 py-4">
        {panel.episodes.length === 0 ? (
          <div className="text-[0.92rem] text-white/50">No episodes.</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {panel.episodes.map((ep) => (
              <li key={ep.episode_id}>
                {ep.drive_url ? (
                  <a
                    href={ep.drive_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 transition hover:border-[#3eb5f9]/40 hover:bg-[#3eb5f9]/[0.06]"
                  >
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40 transition group-hover:text-[#79cdfc]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.88rem] font-medium text-white/90 group-hover:text-white">
                        {ep.title}
                      </div>
                      <div className="mt-0.5 text-[0.7rem] text-white/45">
                        {ep.date ?? 'date unknown'}
                      </div>
                    </div>
                  </a>
                ) : (
                  <div className="flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 opacity-70">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.88rem] font-medium text-white/80">
                        {ep.title}
                      </div>
                      <div className="mt-0.5 text-[0.7rem] text-white/40">
                        {ep.date ?? 'date unknown'} · no drive link
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close panel"
      className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
