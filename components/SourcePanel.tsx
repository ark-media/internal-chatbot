'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, FileText, X } from 'lucide-react';
import type { PanelView, Source } from './chat-types';
import { cn } from '@/lib/cn';
import { HighlightedText } from './HighlightedText';

type Props = {
  panel: PanelView | null;
  onClose: () => void;
  onChange: (next: PanelView) => void;
};

function stripExcerptTags(excerpt: string): string {
  return excerpt
    .replace(/^<(?:transcript_excerpt|dossier_turn)[^>]*>\s*/i, '')
    .replace(/\s*<\/(?:transcript_excerpt|dossier_turn)>\s*$/i, '');
}


export function SourcePanel({ panel, onClose, onChange }: Props) {
  if (!panel) return null;

  // Transcript view needs a wider panel — the source/guest views are summaries
  // and read fine at max-w-md, but transcripts are essay-length and become
  // unreadable at that width.
  const wide = panel.view === 'transcript';

  return (
    <aside
      className={cn(
        'ark-fade-up relative flex h-full w-full flex-col border-l border-white/10 bg-[#070b22]/80 backdrop-blur-xl',
        wide ? 'max-w-2xl' : 'max-w-md',
      )}
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
        <SourceBody
          source={panel.source}
          quote={panel.quote}
          onClose={onClose}
          onChange={onChange}
        />
      ) : panel.view === 'guest_episodes' ? (
        <GuestEpisodesBody panel={panel} onClose={onClose} />
      ) : (
        <TranscriptBody panel={panel} onClose={onClose} onChange={onChange} />
      )}
    </aside>
  );
}

function SourceBody({
  source,
  quote,
  onClose,
  onChange,
}: {
  source: Source;
  quote?: string;
  onClose: () => void;
  onChange: (next: PanelView) => void;
}) {
  const openTranscript = () => {
    onChange({
      view: 'transcript',
      episode_id: source.episode_id,
      turnId: source.kind === 'turn' ? Number(source.id) : null,
      chunkId: source.kind === 'chunk' ? Number(source.id) : null,
      quote,
      previous: { view: 'source', source, quote },
    });
  };
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
            <HighlightedText text={body} quote={quote} />
          </div>
        )}
      </div>

      <footer className="relative flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
        <button
          type="button"
          onClick={openTranscript}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#3eb5f9]/10 px-3 py-1.5 text-sm font-medium text-[#79cdfc] transition hover:bg-[#3eb5f9]/20 hover:text-white"
        >
          <FileText className="h-3.5 w-3.5" />
          Open in transcript
        </button>
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

type TranscriptResponse = {
  episode: {
    episode_id: string;
    title: string;
    date: string | null;
    show: string;
    drive_url: string | null;
  };
  turns: Array<{
    turn_id: number;
    turn_index: number;
    section: string | null;
    speaker: string;
    text: string;
  }>;
  highlight: { start: number; end: number } | null;
  scrollTarget: number | null;
  truncated: boolean;
};

function TranscriptBody({
  panel,
  onClose,
  onChange,
}: {
  panel: Extract<PanelView, { view: 'transcript' }>;
  onClose: () => void;
  onChange: (next: PanelView) => void;
}) {
  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didScrollRef = useRef(false);

  // Refetch whenever the targeted episode/turn/chunk changes — re-clicking a
  // different citation must replace the loaded transcript, not stick on the
  // first one.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    didScrollRef.current = false;

    const params = new URLSearchParams();
    if (panel.turnId != null) params.set('turn', String(panel.turnId));
    else if (panel.chunkId != null) params.set('chunk', String(panel.chunkId));
    const qs = params.toString();
    const url = `/api/transcript/${encodeURIComponent(panel.episode_id)}${qs ? `?${qs}` : ''}`;

    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<TranscriptResponse>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'load failed');
      });

    return () => {
      cancelled = true;
    };
  }, [panel.episode_id, panel.turnId, panel.chunkId]);

  // Once data is in, scroll the highlighted turn into view inside the panel's
  // own scroll container (not the window).
  useEffect(() => {
    if (!data || data.scrollTarget == null) return;
    if (didScrollRef.current) return;
    didScrollRef.current = true;
    const root = scrollRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-turn-id="${data.scrollTarget}"]`);
    if (!el) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      el.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    });
  }, [data]);

  const goBack = () => {
    if (panel.previous) onChange(panel.previous);
    else onClose();
  };

  const headerTitle = data?.episode.title ?? 'Transcript';
  const headerShow = data?.episode.show ?? '';
  const headerDate = data?.episode.date ?? null;

  return (
    <>
      <header className="relative flex items-start gap-3 border-b border-white/10 px-5 py-4">
        <BackButton onBack={goBack} />
        <div className="min-w-0 flex-1">
          <div className="text-[0.7rem] uppercase tracking-[0.22em] text-white/45">
            <span className="text-[#79cdfc]">{headerShow}</span>
            {headerDate ? <span className="text-white/35"> · {headerDate}</span> : null}
          </div>
          <div
            className="mt-1 truncate text-base font-bold text-white"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {headerTitle}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-5 py-5">
        {error ? (
          <div className="rounded-lg border border-rose-300/20 bg-rose-400/[0.04] px-4 py-3 text-[0.85rem] text-rose-200/80">
            Couldn’t load transcript: {error}
          </div>
        ) : !data ? (
          <div className="text-[0.85rem] text-white/45">Loading transcript…</div>
        ) : (
          <TranscriptTurns data={data} quote={panel.quote} />
        )}
      </div>

      {data?.episode.drive_url ? (
        <footer className="relative flex items-center justify-end gap-3 border-t border-white/10 px-5 py-3">
          <a
            href={data.episode.drive_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-white/45 transition hover:text-white/80"
          >
            Open in Drive
            <ExternalLink className="h-3 w-3" />
          </a>
        </footer>
      ) : null}
    </>
  );
}

function TranscriptTurns({
  data,
  quote,
}: {
  data: TranscriptResponse;
  quote?: string;
}) {
  const { turns, highlight, truncated } = data;
  const isHighlighted = (turnId: number) =>
    highlight != null && turnId >= highlight.start && turnId <= highlight.end;

  return (
    <>
      <div className="space-y-3">
        {turns.map((t, i) => {
          const prev = i === 0 ? undefined : turns[i - 1].section;
          const showSection = t.section !== prev;
          const highlighted = isHighlighted(t.turn_id);
          return (
            <div key={t.turn_id}>
              {showSection && t.section ? (
                <div className="mt-6 mb-2 text-[0.66rem] font-semibold uppercase tracking-[0.22em] text-white/35">
                  {t.section}
                </div>
              ) : null}
              <article
                data-turn-id={t.turn_id}
                aria-current={highlighted ? 'location' : undefined}
                className={cn(
                  'scroll-mt-4 rounded-lg px-3 py-2 transition-colors',
                  highlighted
                    ? 'border-l-2 border-[#3eb5f9] bg-[#3eb5f9]/[0.10] shadow-[0_4px_24px_-12px_rgba(62,181,249,0.5)]'
                    : 'border-l-2 border-transparent',
                )}
              >
                <div
                  className={cn(
                    'mb-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em]',
                    highlighted ? 'text-[#79cdfc]' : 'text-white/45',
                  )}
                >
                  {t.speaker}
                </div>
                <div className="whitespace-pre-wrap text-[0.9rem] leading-[1.6] text-white/85">
                  {highlighted ? (
                    <HighlightedText text={t.text} quote={quote} />
                  ) : (
                    t.text
                  )}
                </div>
              </article>
            </div>
          );
        })}
      </div>

      {truncated ? (
        <div className="mt-6 rounded-lg border border-amber-300/20 bg-amber-400/[0.04] px-3 py-2 text-[0.78rem] text-amber-200/80">
          Transcript truncated. Open in Drive to read the rest.
        </div>
      ) : null}
    </>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back"
      className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white"
    >
      <ArrowLeft className="h-4 w-4" />
    </button>
  );
}

