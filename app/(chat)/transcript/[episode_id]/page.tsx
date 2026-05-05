import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { Header } from '@/components/Header';
import { TranscriptScroll } from '@/components/TranscriptScroll';
import { HighlightedText } from '@/components/HighlightedText';
import {
  getChunkRange,
  getEpisodeMeta,
  getEpisodeTurns,
  TRANSCRIPT_TURN_LIMIT,
} from '@/lib/transcript';
import { shortDate } from '@/lib/citation-label';
import { cn } from '@/lib/cn';

export const runtime = 'nodejs';

type Props = {
  params: Promise<{ episode_id: string }>;
  searchParams: Promise<{ turn?: string; chunk?: string; quote?: string }>;
};

// Tolerate already-decoded values: a malformed escape like '%' alone would
// throw URIError, so fall back to the raw segment in that case.
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// `?turn=1.7` or `?turn=-3` would slip past Number.isFinite. Only positive
// integers correspond to real SERIAL ids.
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function TranscriptPage({ params, searchParams }: Props) {
  const { episode_id: rawEpisodeId } = await params;
  // Next 16 hands the raw segment through without URL-decoding, so reserved
  // characters in episode_ids (e.g. the ':' in 'simplecast:<uuid>') arrive as
  // '%3A' and miss the DB lookup unless we decode them ourselves.
  const episode_id = safeDecode(rawEpisodeId);
  const sp = await searchParams;

  const [episode, turns] = await Promise.all([
    getEpisodeMeta(episode_id),
    getEpisodeTurns(episode_id),
  ]);
  if (!episode) notFound();

  let highlightStart: number | null = null;
  let highlightEnd: number | null = null;
  let scrollTarget: number | null = null;

  const turnParam = parsePositiveInt(sp.turn);
  const chunkParam = parsePositiveInt(sp.chunk);

  if (turnParam != null) {
    // turn_id is global (SERIAL), so only accept it when it actually belongs
    // to this episode — otherwise a foreign id silently fails to highlight.
    const belongs = turns.some((t) => t.turn_id === turnParam);
    if (belongs) {
      highlightStart = turnParam;
      highlightEnd = turnParam;
      scrollTarget = turnParam;
    }
  } else if (chunkParam != null) {
    const range = await getChunkRange(chunkParam);
    if (range && range.episode_id === episode_id) {
      highlightStart = range.start_turn_id;
      highlightEnd = range.end_turn_id;
      scrollTarget = range.start_turn_id;
    }
  }

  const isHighlighted = (turnId: number) =>
    highlightStart != null &&
    highlightEnd != null &&
    turnId >= highlightStart &&
    turnId <= highlightEnd;

  const quote = typeof sp.quote === 'string' ? sp.quote : undefined;

  const sectionStart = new Array<boolean>(turns.length);
  for (let i = 0; i < turns.length; i++) {
    const prev = i === 0 ? undefined : turns[i - 1].section;
    sectionStart[i] = turns[i].section !== prev;
  }

  const truncated = turns.length === TRANSCRIPT_TURN_LIMIT;
  const headerDate = shortDate(episode.date);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header variant="archive" />

      <main className="relative flex-1 overflow-y-auto">
        <div className="w-full px-5 py-10">
          <header className="mb-8 border-b border-white/[0.06] pb-6">
            <Link
              href="/"
              className="mb-4 inline-flex items-center gap-1.5 text-[0.78rem] text-white/55 transition hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to chat
            </Link>
            <div className="text-[0.7rem] uppercase tracking-[0.22em] text-white/45">
              <span className="text-[#79cdfc]">{episode.show}</span>
              {headerDate ? (
                <span className="text-white/35"> · {headerDate}</span>
              ) : null}
            </div>
            <h1
              className="mt-2 text-2xl font-black tracking-tight text-white"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {episode.title}
            </h1>
            {episode.drive_url ? (
              <a
                href={episode.drive_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2.5 py-1 text-[0.72rem] text-white/60 transition hover:bg-white/[0.08] hover:text-white"
              >
                Open in Drive
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </header>

          <div className="space-y-4">
            {turns.map((t, i) => {
              const showSection = sectionStart[i];
              const highlighted = isHighlighted(t.turn_id);

              return (
                <div key={t.turn_id}>
                  {showSection && t.section ? (
                    <div className="mt-8 mb-3 text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-white/35">
                      {t.section}
                    </div>
                  ) : null}

                  <article
                    id={`turn-${t.turn_id}`}
                    tabIndex={highlighted ? -1 : undefined}
                    aria-current={highlighted ? 'location' : undefined}
                    aria-label={
                      highlighted
                        ? `Cited turn — ${t.speaker}`
                        : undefined
                    }
                    className={cn(
                      'scroll-mt-24 rounded-lg px-4 py-3 transition-colors outline-none',
                      'focus-visible:ring-2 focus-visible:ring-[#3eb5f9]/60',
                      highlighted
                        ? 'border-l-2 border-[#3eb5f9] bg-[#3eb5f9]/[0.10] shadow-[0_4px_24px_-12px_rgba(62,181,249,0.5)]'
                        : 'border-l-2 border-transparent',
                    )}
                  >
                    <div
                      className={cn(
                        'mb-1 text-[0.72rem] font-semibold uppercase tracking-[0.14em]',
                        highlighted ? 'text-[#79cdfc]' : 'text-white/45',
                      )}
                    >
                      {t.speaker}
                    </div>
                    <div className="whitespace-pre-wrap text-[0.95rem] leading-[1.65] text-white/85">
                      {highlighted
                        ? <HighlightedText text={t.text} quote={quote} />
                        : t.text}
                    </div>
                  </article>
                </div>
              );
            })}
          </div>

          {truncated ? (
            <div className="mt-8 rounded-lg border border-amber-300/20 bg-amber-400/[0.04] px-4 py-3 text-[0.8rem] text-amber-200/80">
              Transcript truncated at {TRANSCRIPT_TURN_LIMIT.toLocaleString()} turns.
              {episode.drive_url
                ? ' Open the full transcript in Drive to read the rest.'
                : ''}
            </div>
          ) : null}
        </div>
      </main>

      {scrollTarget != null ? (
        <TranscriptScroll targetTurnId={scrollTarget} />
      ) : null}
    </div>
  );
}
