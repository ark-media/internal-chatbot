'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Link from 'next/link';
import { ArrowUp, Loader2, Square, Sparkles, FileText, ChevronRight } from 'lucide-react';

import { ArkLogo } from '@/components/ArkLogo';
import { MessageText } from '@/components/MessageText';
import { SourcePanel } from '@/components/SourcePanel';
import type {
  ChatUIMessage,
  CountGuestAppearancesToolOutput,
  DossierToolOutput,
  LookupToolOutput,
  PanelView,
  Source,
  TopGuestsToolOutput,
} from '@/components/chat-types';
import { cn } from '@/lib/cn';

const SKY = '#3eb5f9';
const INK_900 = '#0b153c';

const EXAMPLE_PROMPTS = [
  'What has Nadav Eyal said about the Houthis recently?',
  'Has Amit Segal contradicted himself on judicial reform?',
  'Summarize the latest takes on the hostage deal.',
  'Who discussed Iran sanctions in the last month?',
];

export default function ChatPage() {
  const { messages, sendMessage, status, stop } = useChat<ChatUIMessage>({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const [input, setInput] = useState('');
  const [openPanel, setOpenPanel] = useState<PanelView | null>(null);
  const [episodeCount, setEpisodeCount] = useState<number | null>(null);

  const openSource = useCallback(
    (source: Source) => setOpenPanel({ view: 'source', source }),
    [],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/episode-count')
      .then((r) => r.json())
      .then((data: { count: number | null }) => {
        if (!cancelled && typeof data.count === 'number') {
          setEpisodeCount(data.count);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const sources = useMemo(() => {
    const map = new Map<string, Source>();
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const part of m.parts) {
        if (part.type === 'data-preloaded') {
          for (const c of part.data.chunks) {
            const key = `id:${c.id}`;
            map.set(key, {
              kind: 'chunk',
              id: c.id,
              key,
              title: c.title,
              show: c.show,
              date: c.date,
              section: c.section,
              speaker: null,
              drive_url: c.drive_url,
              excerpt: c.excerpt,
            });
          }
          for (const t of part.data.turns) {
            const key = `turn:${t.id}`;
            map.set(key, {
              kind: 'turn',
              id: t.id,
              key,
              title: t.episode_title,
              show: t.show,
              date: t.date,
              section: t.section,
              speaker: t.speaker,
              drive_url: t.drive_url,
              excerpt: t.excerpt,
            });
          }
        }
        if (part.type === 'tool-lookupCorpus' && 'output' in part && part.output) {
          const out = part.output as LookupToolOutput;
          for (const c of out.chunks ?? []) {
            const key = `id:${c.id}`;
            map.set(key, {
              kind: 'chunk',
              id: c.id,
              key,
              title: c.title,
              show: c.show,
              date: c.date,
              section: c.section,
              speaker: null,
              drive_url: c.drive_url,
              excerpt: c.excerpt,
            });
          }
        }
        if (part.type === 'tool-getDossier' && 'output' in part && part.output) {
          const out = part.output as DossierToolOutput;
          for (const t of out.turns ?? []) {
            const key = `turn:${t.id}`;
            map.set(key, {
              kind: 'turn',
              id: t.id,
              key,
              title: t.episode_title,
              show: t.show,
              date: t.date,
              section: t.section,
              speaker: t.speaker,
              drive_url: t.drive_url,
              excerpt: t.excerpt,
            });
          }
        }
        if (
          part.type === 'tool-countGuestAppearances' &&
          'output' in part &&
          part.output
        ) {
          const out = part.output as CountGuestAppearancesToolOutput;
          for (const ep of out.episodes ?? []) {
            const key = `ep:${ep.episode_id}`;
            map.set(key, {
              kind: 'episode',
              id: ep.episode_id,
              key,
              title: ep.title,
              show: out.showName ?? '',
              date: ep.date,
              section: null,
              speaker: out.speakerName ?? null,
              drive_url: ep.drive_url,
              excerpt: '',
            });
          }
        }
      }
    }
    return map;
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, busy]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  const submit = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    sendMessage({ text: q });
    setInput('');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(input);
  };

  return (
    <div
      className="flex h-screen w-full"
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---------- Header ---------- */}
        <header className="relative z-10 flex items-center justify-between gap-4 border-b border-white/[0.06] bg-white/[0.02] px-6 py-3 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <ArkLogo
              className="h-9 text-white"
              bg={SKY}
              fg={INK_900}
              markOnly
            />
            <div className="leading-tight">
              <div
                className="text-[0.95rem] font-black tracking-tight text-white"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Ark Media
              </div>
              <div className="text-[0.72rem] uppercase tracking-[0.22em] text-white/45">
                Transcript Assistant
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <nav className="flex items-center gap-1 text-[0.75rem]">
              <span className="rounded-md bg-[#3eb5f9]/[0.12] px-2.5 py-1 text-[#79cdfc]">
                Archive
              </span>
              <Link
                href="/prep"
                className="rounded-md px-2.5 py-1 text-white/60 transition hover:bg-white/[0.05] hover:text-white"
              >
                Prep
              </Link>
            </nav>
            <div className="hidden items-center gap-2 text-[0.7rem] text-white/40 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]" />
              <span>{episodeCount ?? '—'} episodes indexed</span>
            </div>
          </div>
        </header>

        {/* ---------- Message list ---------- */}
        <main
          ref={scrollRef}
          className="relative flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-6 py-10">
            {messages.length === 0 && <EmptyState onPick={submit} busy={busy} />}

            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                sources={sources}
                onOpen={openSource}
                onOpenPanel={setOpenPanel}
              />
            ))}

            {busy && (
              <div className="flex items-center gap-3 pl-12 text-xs text-white/50">
                <TypingDots />
                <span className="tracking-wide">
                  {status === 'submitted' ? 'Summoning context…' : 'Writing…'}
                </span>
                <button
                  type="button"
                  onClick={() => stop()}
                  className="ml-2 inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[0.7rem] text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  <Square className="h-2.5 w-2.5 fill-current" />
                  Stop
                </button>
              </div>
            )}
          </div>
        </main>

        {/* ---------- Composer ---------- */}
        <form
          onSubmit={onSubmit}
          className="relative z-10 border-t border-white/[0.06] bg-gradient-to-b from-transparent to-[#070b22]/60 px-6 py-4 backdrop-blur-md"
        >
          <div className="mx-auto max-w-3xl">
            <div
              className={cn(
                'group flex items-end gap-2 rounded-2xl border bg-white/[0.04] px-3 py-2.5 backdrop-blur',
                'border-white/10 shadow-[0_12px_40px_-16px_rgba(3,62,200,0.45)]',
                'transition focus-within:border-[#3eb5f9]/60',
                'focus-within:shadow-[0_12px_40px_-14px_rgba(62,181,249,0.55)]',
              )}
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit(input);
                  }
                }}
                rows={1}
                placeholder="Ask about past episodes…"
                disabled={busy}
                className={cn(
                  'min-h-[40px] flex-1 resize-none bg-transparent px-1 py-1.5',
                  'text-[0.95rem] leading-relaxed text-white placeholder:text-white/35',
                  'outline-none disabled:opacity-60',
                )}
              />
              <button
                type="submit"
                aria-label="Send"
                disabled={busy || !input.trim()}
                className={cn(
                  'group/btn relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                  'text-[#070b22] transition',
                  'bg-[#3eb5f9] hover:bg-[#79cdfc]',
                  'shadow-[0_6px_20px_-6px_rgba(62,181,249,0.7)]',
                  'disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30 disabled:shadow-none',
                )}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                )}
              </button>
            </div>
            <div className="mt-2 px-1 text-[0.68rem] uppercase tracking-[0.2em] text-white/30">
              Enter to send · Shift + Enter for newline
            </div>
          </div>
        </form>
      </div>

      {openPanel && (
        <SourcePanel panel={openPanel} onClose={() => setOpenPanel(null)} />
      )}
    </div>
  );
}

/* ============================================================
   Sub-components
   ============================================================ */

type MsgProps = {
  message: ReturnType<typeof useChat>['messages'][number];
  sources: Map<string, Source>;
  onOpen: (s: Source) => void;
  onOpenPanel: (panel: PanelView) => void;
};

function MessageRow({ message, sources, onOpen, onOpenPanel }: MsgProps) {
  if (message.role === 'user') {
    return (
      <div className="ark-fade-up flex justify-end">
        <div
          className={cn(
            'max-w-[82%] rounded-2xl rounded-br-md px-4 py-2.5',
            'bg-gradient-to-br from-[#3eb5f9] to-[#2a8fd6] text-[#070b22]',
            'shadow-[0_8px_22px_-10px_rgba(62,181,249,0.6)]',
            'text-[0.95rem] font-medium leading-relaxed',
          )}
        >
          {message.parts.map((p, i) =>
            p.type === 'text' ? (
              <span key={i} className="whitespace-pre-wrap">
                {p.text}
              </span>
            ) : null,
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ark-fade-up flex gap-4">
      <div
        aria-hidden
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-[#101736] to-[#070b22]"
      >
        <ArkLogo className="h-7" bg="transparent" fg="#3eb5f9" markOnly />
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <MessageText
                key={i}
                text={part.text}
                sources={sources}
                onOpen={onOpen}
              />
            );
          }
          if (part.type === 'tool-lookupCorpus') {
            if (
              part.state === 'input-streaming' ||
              part.state === 'input-available'
            ) {
              return <ToolChip key={i} icon="search" label="Searching transcripts…" pulsing />;
            }
            if (part.state === 'output-available') {
              const out = part.output as LookupToolOutput;
              const n = out.chunks?.length ?? 0;
              return (
                <ToolChip
                  key={i}
                  icon="search"
                  label={
                    n > 0
                      ? `Retrieved ${n} excerpt${n === 1 ? '' : 's'}`
                      : 'No relevant transcripts'
                  }
                />
              );
            }
          }
          if (part.type === 'tool-getDossier') {
            if (
              part.state === 'input-streaming' ||
              part.state === 'input-available'
            ) {
              return <ToolChip key={i} icon="file" label="Loading dossier page…" pulsing />;
            }
            if (part.state === 'output-available') {
              const out = part.output as DossierToolOutput;
              const n = out.turns?.length ?? 0;
              const total = out.totalCount ?? n;
              return (
                <ToolChip
                  key={i}
                  icon="file"
                  label={
                    n > 0
                      ? `Loaded ${n} of ${total} turn${total === 1 ? '' : 's'}`
                      : 'No turns in this page'
                  }
                />
              );
            }
          }
          if (part.type === 'tool-topGuests') {
            if (
              part.state === 'input-streaming' ||
              part.state === 'input-available'
            ) {
              return <ToolChip key={i} icon="file" label="Ranking guests…" pulsing />;
            }
            if (part.state === 'output-available') {
              const out = part.output as TopGuestsToolOutput;
              const guests = out.guests ?? [];
              if (guests.length === 0) {
                return (
                  <ToolChip
                    key={i}
                    icon="file"
                    label={out.note ?? 'No matching guests'}
                  />
                );
              }
              return (
                <TopGuestsTable
                  key={i}
                  output={out}
                  onOpenPanel={onOpenPanel}
                />
              );
            }
          }
          if (part.type === 'tool-countGuestAppearances') {
            if (
              part.state === 'input-streaming' ||
              part.state === 'input-available'
            ) {
              return (
                <ToolChip key={i} icon="file" label="Counting appearances…" pulsing />
              );
            }
            if (part.state === 'output-available') {
              const out = part.output as CountGuestAppearancesToolOutput;
              if (out.speakerIsHost) {
                return (
                  <ToolChip
                    key={i}
                    icon="file"
                    label={`${out.speakerName ?? 'Speaker'} is a host of ${out.showName ?? 'the show'}`}
                  />
                );
              }
              const eps = out.episodes ?? [];
              const count = out.count ?? eps.length;
              if (eps.length === 0) {
                return (
                  <ToolChip
                    key={i}
                    icon="file"
                    label={out.note ?? 'No appearances found'}
                  />
                );
              }
              return (
                <div key={i} className="space-y-2">
                  <ToolChip
                    icon="file"
                    label={`${count} appearance${count === 1 ? '' : 's'}${out.speakerName && out.showName ? ` · ${out.speakerName} on ${out.showName}` : ''}`}
                  />
                  <EpisodeList
                    episodes={eps}
                    sources={sources}
                    onOpen={onOpen}
                  />
                </div>
              );
            }
          }
          return null;
        })}
      </div>
    </div>
  );
}

type EpisodeListItem = {
  episode_id: string;
  title: string;
  date: string | null;
  drive_url: string | null;
  matched_by?: 'turns' | 'title' | 'both';
};

function EpisodeList({
  episodes,
  sources,
  onOpen,
}: {
  episodes: EpisodeListItem[];
  sources: Map<string, Source>;
  onOpen: (s: Source) => void;
}) {
  return (
    <ul className="ml-0 flex flex-col gap-1.5">
      {episodes.map((ep) => {
        const key = `ep:${ep.episode_id}`;
        const source = sources.get(key);
        return (
          <li key={ep.episode_id}>
            <button
              type="button"
              onClick={() => source && onOpen(source)}
              disabled={!source}
              className={cn(
                'group flex w-full items-start gap-2 rounded-lg border border-amber-300/20',
                'bg-amber-400/[0.04] px-3 py-2 text-left transition',
                'hover:border-amber-300/50 hover:bg-amber-400/[0.08]',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-200/80 transition group-hover:text-amber-100" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.85rem] font-medium text-white/90">
                  {ep.title}
                </div>
                <div className="mt-0.5 text-[0.7rem] text-white/45">
                  {ep.date ?? 'date unknown'}
                  {ep.matched_by === 'title'
                    ? ' · billed in title'
                    : ep.matched_by === 'both'
                      ? ' · billed + spoke'
                      : ''}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TopGuestsTable({
  output,
  onOpenPanel,
}: {
  output: TopGuestsToolOutput;
  onOpenPanel: (panel: PanelView) => void;
}) {
  const guests = output.guests ?? [];
  const scopeLabel =
    output.showName ??
    (output.groupName ? `${output.groupName} (group)` : 'all shows');
  const dateRange =
    output.since && output.until
      ? `${output.since} → ${output.until}`
      : output.since
        ? `Since ${output.since}`
        : output.until
          ? `Until ${output.until}`
          : null;

  const hasTies = new Set(guests.map((g) => g.rank)).size < guests.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[0.72rem] text-white/50">
        <span className="uppercase tracking-[0.18em]">Top Guests</span>
        <span className="text-white/25">·</span>
        <span className="text-[#79cdfc]">{scopeLabel}</span>
        {dateRange ? (
          <>
            <span className="text-white/25">·</span>
            <span className="text-white/60">{dateRange}</span>
          </>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
        <table className="w-full text-[0.88rem]">
          <thead>
            <tr className="border-b border-white/[0.06] text-left text-[0.68rem] uppercase tracking-[0.14em] text-white/40">
              <th className="px-4 py-2.5 font-medium">Rank</th>
              <th className="px-4 py-2.5 font-medium">Guest</th>
              <th className="px-4 py-2.5 text-right font-medium">Episodes</th>
              <th className="px-4 py-2.5 font-medium" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {guests.map((g) => (
              <tr
                key={`${g.rank}-${g.speaker_name}`}
                className="border-t border-white/[0.04] transition hover:bg-white/[0.025]"
              >
                <td className="px-4 py-2.5 text-white/60">
                  <RankBadge rank={g.rank} />
                </td>
                <td className="px-4 py-2.5 font-medium text-white/90">
                  {g.speaker_name}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-white/75 tabular-nums">
                  {g.episode_count}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      onOpenPanel({
                        view: 'guest_episodes',
                        speakerName: g.speaker_name,
                        scope: scopeLabel,
                        dateRange,
                        episodes: g.episodes,
                      })
                    }
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border border-[#3eb5f9]/30 bg-[#3eb5f9]/[0.08]',
                      'px-2 py-1 text-[0.72rem] font-medium text-[#79cdfc]',
                      'transition hover:border-[#3eb5f9]/60 hover:bg-[#3eb5f9]/[0.18] hover:text-white',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3eb5f9]/60',
                    )}
                  >
                    View
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasTies ? (
        <div className="text-[0.7rem] text-white/40">
          Tied ranks share a position; within a tier guests are listed alphabetically.
        </div>
      ) : null}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="font-mono text-amber-300">🥇 1</span>;
  if (rank === 2) return <span className="font-mono text-white/80">🥈 2</span>;
  if (rank === 3) return <span className="font-mono text-orange-300">🥉 3</span>;
  return <span className="font-mono text-white/55">{rank}</span>;
}

function ToolChip({
  icon,
  label,
  pulsing,
}: {
  icon: 'search' | 'file';
  label: string;
  pulsing?: boolean;
}) {
  const Icon = icon === 'search' ? Sparkles : FileText;
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03]',
        'px-2.5 py-1 text-[0.72rem] text-white/65',
      )}
    >
      <Icon
        className={cn(
          'h-3.5 w-3.5 text-[#3eb5f9]',
          pulsing && 'ark-pulse-dot',
        )}
      />
      <span>{label}</span>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-[#3eb5f9] ark-pulse-dot"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}

function EmptyState({
  onPick,
  busy,
}: {
  onPick: (q: string) => void;
  busy: boolean;
}) {
  return (
    <div className="ark-fade-up flex flex-col items-center py-14 text-center">
      <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-[#101736] to-[#070b22] shadow-[0_20px_60px_-20px_rgba(62,181,249,0.35)]">
        <ArkLogo className="h-14" bg="transparent" fg="#3eb5f9" markOnly />
      </div>
      <h1
        className="text-3xl font-black tracking-tight text-white sm:text-4xl"
        style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
      >
        Ask the{' '}
        <span className="bg-gradient-to-r from-[#3eb5f9] via-[#79cdfc] to-white bg-clip-text text-transparent">
          arkive
        </span>
        .
      </h1>
      <p className="mt-3 max-w-md text-[0.95rem] leading-relaxed text-white/55">
        Every answer is cited against the Ark Media podcast transcripts. Ask who
        said what, compare takes, trace a story over time.
      </p>

      <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {EXAMPLE_PROMPTS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={busy}
            onClick={() => onPick(q)}
            className={cn(
              'group rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left',
              'text-[0.88rem] leading-snug text-white/75 transition',
              'hover:border-[#3eb5f9]/40 hover:bg-[#3eb5f9]/[0.06] hover:text-white',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#3eb5f9]/70 transition group-hover:text-[#3eb5f9]" />
              <span>{q}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
