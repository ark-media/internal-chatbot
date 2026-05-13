'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, FileText, X } from 'lucide-react';
import type { PanelView, Source } from './chat-types';
import { cn } from '@/lib/cn';
import { HighlightedText } from './HighlightedText';
import { IconButton } from './ui/IconButton';
import { KindBadge, type KindBadgeTone } from './ui/KindBadge';

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

function sourceKindTone(kind: Source['kind']): KindBadgeTone {
  if (kind === 'turn') return 'emerald';
  if (kind === 'episode') return 'amber';
  return 'sky';
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
        'ark-fade-up relative flex h-full w-full flex-col border-l border-overlay/10 bg-canvas-deep/80 backdrop-blur-xl',
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
        <TranscriptBody
          // Force a fresh component instance per target so state (data,
          // error, didScroll) starts empty without resetting inside an effect.
          key={`${panel.episode_id}:${panel.turnId ?? ''}:${panel.chunkId ?? ''}`}
          panel={panel}
          onClose={onClose}
          onChange={onChange}
        />
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
      <header className="relative flex items-start justify-between gap-3 border-b border-overlay/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <KindBadge tone={sourceKindTone(source.kind)}>
              {tag ? `${labelKind} · ${tag}` : labelKind}
            </KindBadge>
          </div>
          <div className="mt-2 truncate font-display text-base font-bold text-fg">
            {source.title}
          </div>
          <div className="mt-1 text-xs text-fg/55">
            <span className="text-sky-brand-soft">{source.show}</span>
            {source.date ? <span className="text-fg/35"> · {source.date}</span> : null}
            {source.section ? <span className="text-fg/35"> · {source.section}</span> : null}
            {source.speaker ? (
              <span className="text-fg/80"> · {source.speaker}</span>
            ) : null}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      <div className="relative flex-1 overflow-y-auto px-5 py-5">
        {source.kind === 'episode' ? (
          <div className="text-[0.92rem] leading-[1.7] text-fg/60">
            {source.speaker
              ? `Appearance by ${source.speaker}.`
              : 'Episode appearance.'}{' '}
            {source.drive_url
              ? 'Open the full transcript in Drive to read.'
              : 'No transcript link available.'}
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-[0.92rem] leading-[1.7] text-fg/85">
            <HighlightedText text={body} quote={quote} />
          </div>
        )}
      </div>

      <footer className="relative flex items-center justify-between gap-3 border-t border-overlay/10 px-5 py-3">
        <button
          type="button"
          onClick={openTranscript}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-brand/10 px-3 py-1.5 text-sm font-medium text-sky-brand-soft transition hover:bg-sky-brand/20 hover:text-fg"
        >
          <FileText className="h-3.5 w-3.5" />
          Open in transcript
        </button>
        {source.drive_url ? (
          <a
            href={source.drive_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-fg/45 transition hover:text-fg/80"
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
      <header className="relative flex items-start justify-between gap-3 border-b border-overlay/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <KindBadge tone="amber">
              Guest · {panel.episodes.length} ep{panel.episodes.length === 1 ? '' : 's'}
            </KindBadge>
          </div>
          <div className="mt-2 truncate font-display text-base font-bold text-fg">
            {panel.speakerName}
          </div>
          <div className="mt-1 text-xs text-fg/55">
            <span className="text-sky-brand-soft">{panel.scope}</span>
            {panel.dateRange ? (
              <span className="text-fg/35"> · {panel.dateRange}</span>
            ) : null}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      <div className="relative flex-1 overflow-y-auto px-5 py-4">
        {panel.episodes.length === 0 ? (
          <div className="text-[0.92rem] text-fg/50">No episodes.</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {panel.episodes.map((ep) => (
              <li key={ep.episode_id}>
                {ep.drive_url ? (
                  <a
                    href={ep.drive_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ark-surface-faint group flex items-start gap-2 rounded-lg border border-overlay/[0.06] px-3 py-2 transition hover:border-sky-brand/40 hover:bg-sky-brand/[0.06]"
                  >
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg/40 transition group-hover:text-sky-brand-soft" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.88rem] font-medium text-fg/90 group-hover:text-fg">
                        {ep.title}
                      </div>
                      <div className="mt-0.5 text-[0.7rem] text-fg/45">
                        {ep.date ?? 'date unknown'}
                      </div>
                    </div>
                  </a>
                ) : (
                  <div className="ark-surface-faint flex items-start gap-2 rounded-lg border border-overlay/[0.06] px-3 py-2 opacity-70">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.88rem] font-medium text-fg/80">
                        {ep.title}
                      </div>
                      <div className="mt-0.5 text-[0.7rem] text-fg/40">
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
    <IconButton variant="chip" onClick={onClose} aria-label="Close panel">
      <X className="h-4 w-4" />
    </IconButton>
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

  // The parent remounts this component when episode/turn/chunk change
  // (via `key`), so state always starts empty here — no in-effect reset needed.
  useEffect(() => {
    let cancelled = false;

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
      <header className="relative flex items-start gap-3 border-b border-overlay/10 px-5 py-4">
        <BackButton onBack={goBack} />
        <div className="min-w-0 flex-1">
          <div className="text-[0.7rem] uppercase tracking-[0.22em] text-fg/45">
            <span className="text-sky-brand-soft">{headerShow}</span>
            {headerDate ? <span className="text-fg/35"> · {headerDate}</span> : null}
          </div>
          <div className="mt-1 truncate font-display text-base font-bold text-fg">
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
          <div className="text-[0.85rem] text-fg/45">Loading transcript…</div>
        ) : (
          <TranscriptTurns data={data} quote={panel.quote} />
        )}
      </div>

      {data?.episode.drive_url ? (
        <footer className="relative flex items-center justify-end gap-3 border-t border-overlay/10 px-5 py-3">
          <a
            href={data.episode.drive_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-fg/45 transition hover:text-fg/80"
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
                <div className="mt-6 mb-2 text-[0.66rem] font-semibold uppercase tracking-[0.22em] text-fg/35">
                  {t.section}
                </div>
              ) : null}
              <article
                data-turn-id={t.turn_id}
                aria-current={highlighted ? 'location' : undefined}
                className={cn(
                  'scroll-mt-4 rounded-lg px-3 py-2 transition-colors',
                  highlighted
                    ? 'border-l-2 border-sky-brand bg-sky-brand/[0.10] shadow-[0_4px_24px_-12px_rgba(62,181,249,0.5)]'
                    : 'border-l-2 border-transparent',
                )}
              >
                <div
                  className={cn(
                    'mb-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em]',
                    highlighted ? 'text-sky-brand-soft' : 'text-fg/45',
                  )}
                >
                  {t.speaker}
                </div>
                <div className="whitespace-pre-wrap text-[0.9rem] leading-[1.6] text-fg/85">
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
    <IconButton variant="chip" onClick={onBack} aria-label="Back">
      <ArrowLeft className="h-4 w-4" />
    </IconButton>
  );
}

