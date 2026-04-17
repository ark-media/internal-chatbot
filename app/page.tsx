'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { ArrowUp, Loader2, Square, Sparkles, FileText } from 'lucide-react';

import { ArkLogo } from '@/components/ArkLogo';
import { MessageText } from '@/components/MessageText';
import { SourcePanel } from '@/components/SourcePanel';
import type {
  DossierToolOutput,
  LookupToolOutput,
  Source,
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
  const { messages, sendMessage, status, stop } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const [input, setInput] = useState('');
  const [openSource, setOpenSource] = useState<Source | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const sources = useMemo(() => {
    const map = new Map<string, Source>();
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const part of m.parts) {
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
          <div className="hidden items-center gap-2 text-[0.7rem] text-white/40 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]" />
            <span>187 episodes indexed</span>
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
                onOpen={setOpenSource}
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

      {openSource && (
        <SourcePanel source={openSource} onClose={() => setOpenSource(null)} />
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
};

function MessageRow({ message, sources, onOpen }: MsgProps) {
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
          return null;
        })}
      </div>
    </div>
  );
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
          archive
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
