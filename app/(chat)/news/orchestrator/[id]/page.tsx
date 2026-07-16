'use client';

// The scriptwriter chat surface: one conversation drives the 3-stage pipeline
// (source → understand per topic → write per block, any order), with typed
// data parts rendered as cards. All writer input — free text and suggestion
// chips alike — flows through the same conductor endpoint.

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
import { useParams } from 'next/navigation';
import { ArrowUp, Loader2, Square } from 'lucide-react';

import { Header } from '@/components/Header';
import { ChatErrorBanner } from '@/components/ChatErrorBanner';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { BlockCard } from '@/components/scriptwriter/BlockCard';
import { EpisodeCard } from '@/components/scriptwriter/EpisodeCard';
import { SourcingProgressCard } from '@/components/scriptwriter/SourcingProgressCard';
import { TopicProposalCards } from '@/components/scriptwriter/TopicProposalCards';
import type {
  BlockPartData,
  EpisodePartData,
  ScriptRun,
  ScriptwriterUIMessage,
  SourcingProgressData,
  TopicCardData,
} from '@/components/scriptwriter-types';
import { chatFetch } from '@/lib/chat-fetch';
import { notifyChatUpdated } from '@/lib/chat-refresh';

const START_EXAMPLES = [
  '',
  'Write me a single C block — something warm or cultural for the close.',
  'Just an A block on the biggest story of the day.',
];

const START_EXAMPLE_LABELS = ['Full episode (A/B/C)', 'Single C block', 'Single A block'];

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function ScriptwriterPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  const [run, setRun] = useState<ScriptRun | null>(null);
  const [initialMessages, setInitialMessages] = useState<ScriptwriterUIMessage[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  const fetchRun = useCallback(async () => {
    if (!chatId) return;
    try {
      const r = await fetch(`/api/news/orchestrator/${chatId}`);
      if (r.status === 404) {
        setNotFound(true);
        setInitialMessages([]);
        return;
      }
      if (!r.ok) return;
      const d = (await r.json()) as { run: ScriptRun; messages: ScriptwriterUIMessage[] };
      setNotFound(false);
      setRun(d.run);
      setInitialMessages((prev) => prev ?? d.messages);
    } catch {
      // transient; keep current state
    }
  }, [chatId]);

  useEffect(() => {
    // Deferred so no setState runs synchronously inside the effect body
    // (react-hooks/set-state-in-effect); all state writes happen after the
    // fetch resolves anyway.
    queueMicrotask(() => {
      void fetchRun();
    });
  }, [fetchRun]);

  if (!chatId) return null;
  if (notFound) {
    return <StartCard chatId={chatId} onStarted={fetchRun} />;
  }
  if (!run || initialMessages === null) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <Header variant="news" />
        <div className="flex flex-1 items-center justify-center text-fg/40">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }
  return (
    <ScriptwriterBody
      chatId={chatId}
      run={run}
      initialMessages={initialMessages}
      refreshRun={fetchRun}
    />
  );
}

// -- Start card (no run yet for this id) --------------------------------------

function StartCard({
  chatId,
  onStarted,
}: {
  chatId: string;
  onStarted: () => void | Promise<void>;
}) {
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (briefOverride?: string) => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/news/orchestrator/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          today: todayISO(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          prompt: briefOverride ?? prompt,
        }),
      });
      if (!res.ok) throw new Error(`start failed (${res.status})`);
      // Await the reload so a run that doesn't materialize (transient 404/500)
      // leaves the buttons re-enabled rather than stuck disabled forever. On
      // success this component unmounts and the setState below is a no-op.
      await onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header variant="news" />
      <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-xl">
          <h1 className="font-display text-2xl font-black text-fg">
            Today&apos;s <span className="text-sky-brand">script</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-fg/60">
            Say what you need — a full episode, specific blocks, or one block on a story you
            name. Leave it empty for the default: the day&apos;s three most interesting stories,
            written as A/B/C blocks with your sign-off at every step.
          </p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder='e.g. "Write me a B block on the Hormuz shipping fees" — or leave empty for a full episode'
            className="mt-4 w-full resize-none rounded-xl border border-overlay/15 bg-overlay/[0.03] px-4 py-3 text-sm text-fg placeholder:text-fg/30 focus:border-sky-brand/40 focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={starting}
              onClick={() => start()}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-brand/20 px-4 py-2 text-sm font-medium text-sky-brand-soft transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Find today&apos;s stories
            </button>
            {START_EXAMPLES.map((ex, i) => (
              <button
                key={i}
                type="button"
                disabled={starting}
                onClick={() => {
                  setPrompt(ex);
                  void start(ex);
                }}
                className="rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.75rem] text-fg/60 transition hover:border-overlay/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {START_EXAMPLE_LABELS[i]}
              </button>
            ))}
          </div>
          {error ? (
            <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

// -- Chat body ------------------------------------------------------------------

const IN_FLIGHT_TOOL_LABELS: Record<string, string> = {
  'tool-startTopic': 'Reading the sources…',
  'tool-draftBlock': 'Writing the block…',
  'tool-reviseBlock': 'Revising the block…',
  'tool-assembleEpisode': 'Assembling the episode…',
  'tool-reviseEpisode': 'Revising the episode…',
  'tool-webSearch': 'Searching the web…',
  'tool-fetchArticle': 'Fetching article…',
};

function busyLabel(messages: ScriptwriterUIMessage[], status: string, run: ScriptRun): string {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.parts) {
    for (let i = last.parts.length - 1; i >= 0; i--) {
      const part = last.parts[i];
      const label = IN_FLIGHT_TOOL_LABELS[part.type];
      const state = (part as { state?: string }).state;
      if (label && (state === 'input-streaming' || state === 'input-available')) {
        return label;
      }
    }
  }
  if (run.stage === 'sourcing' || run.topics.length === 0) return 'Sourcing stories…';
  return status === 'submitted' ? 'Thinking…' : 'Working…';
}

// Chip suggestions for the current run state — they prefill or send through
// the composer, so buttons and free text share the conductor path.
function suggestionChips(run: ScriptRun): string[] {
  if (run.episode) return ['Revise the episode: ', 'Undo that last episode change.'];
  const chips: string[] = [];
  for (const t of run.topics) {
    if (t.stage === 'understanding') {
      chips.push(`Confirmed — draft the ${t.story.blockSlot} block.`);
    } else if (t.stage === 'revising') {
      chips.push(`Approve the ${t.story.blockSlot} block.`);
    }
  }
  if (chips.length === 0) {
    const next = run.topics.find((t) => t.stage === 'proposed');
    if (next) chips.push(`Let's work the ${next.story.blockSlot} block story first.`);
  }
  const allApproved = run.topics.length > 0 && run.topics.every((t) => t.stage === 'approved');
  if (allApproved && run.scope.type === 'episode' && !run.episode) {
    chips.push('Assemble the episode.');
  }
  return chips.slice(0, 3);
}

function ScriptwriterBody({
  chatId,
  run,
  initialMessages,
  refreshRun,
}: {
  chatId: string;
  run: ScriptRun;
  initialMessages: ScriptwriterUIMessage[];
  refreshRun: () => Promise<void>;
}) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const autoSentRef = useRef(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/news/orchestrator/chat',
        fetch: chatFetch,
        body: { chatId },
      }),
    [chatId],
  );

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat<ScriptwriterUIMessage>({
      id: chatId,
      messages: initialMessages,
      transport,
      onFinish: () => {
        notifyChatUpdated();
        void refreshRun();
      },
    });

  const busy = status === 'submitted' || status === 'streaming';
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // `messages` changes on every streamed token; a smooth scroll per token
    // janks and fights the user scrolling up. Jump instantly while streaming,
    // smooth only when the turn settles.
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: busy ? 'auto' : 'smooth',
    });
  }, [messages, busy]);

  // Kick off sourcing automatically on a fresh run: the first message IS the
  // writer's brief (or the default ask).
  useEffect(() => {
    if (autoSentRef.current || busy) return;
    if (run.stage !== 'sourcing' || messages.length > 0) return;
    autoSentRef.current = true;
    void sendMessage({
      text: run.originalPrompt ?? "Find today's most interesting stories.",
    });
  }, [run, messages.length, busy, sendMessage]);

  const submit = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      void sendMessage({ text: q });
      setInput('');
    },
    [busy, sendMessage],
  );

  // Chips ending in ': ' prefill the composer for the writer to complete;
  // anything else sends immediately.
  const pick = useCallback(
    (text: string) => {
      if (text.endsWith(': ')) {
        setInput(text);
        inputRef.current?.focus();
        return;
      }
      submit(text);
    },
    [submit],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(input);
  };

  // Latest data-block part per slot (message order): only that instance shows
  // approval state and action chips; earlier ones are history.
  const latestBlockKeys = useMemo(() => {
    const latest = new Map<string, string>();
    messages.forEach((m, mi) =>
      (m.parts ?? []).forEach((p, pi) => {
        if (p.type === 'data-block') {
          latest.set((p.data as BlockPartData).slot, `${mi}:${pi}`);
        }
      }),
    );
    return new Set(latest.values());
  }, [messages]);

  const chips = suggestionChips(run);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header variant="news" />

      <main ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
          {messages.map((m, mi) => (
            <MessageRow
              key={m.id}
              message={m}
              messageIndex={mi}
              run={run}
              chatId={chatId}
              latestBlockKeys={latestBlockKeys}
              onPick={pick}
              busy={busy}
            />
          ))}

          {busy ? (
            <div className="flex items-center gap-3 text-xs text-fg/50">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="tracking-wide">{busyLabel(messages, status, run)}</span>
              <button
                type="button"
                onClick={() => stop()}
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-overlay/10 bg-overlay/5 px-2 py-0.5 text-[0.7rem] text-fg/70 transition hover:bg-overlay/10 hover:text-fg"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            </div>
          ) : null}

          <ChatErrorBanner
            error={error}
            onRetry={() => {
              clearError();
              regenerate();
            }}
            onDismiss={clearError}
          />
        </div>
      </main>

      {/* Composer */}
      <div className="border-t border-overlay/[0.08] px-5 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {!busy && chips.length > 0 ? (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => pick(c)}
                  className="rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.75rem] text-fg/70 transition hover:border-overlay/40 hover:bg-overlay/[0.06] hover:text-fg"
                >
                  {c}
                </button>
              ))}
            </div>
          ) : null}
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit(input);
                }
              }}
              rows={Math.min(5, Math.max(1, input.split('\n').length))}
              placeholder="Confirm, correct, redirect — or ask for anything"
              className="min-h-[44px] flex-1 resize-none rounded-xl border border-overlay/15 bg-overlay/[0.03] px-4 py-2.5 text-sm text-fg placeholder:text-fg/30 focus:border-sky-brand/40 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || input.trim().length === 0}
              aria-label="Send"
              className="flex h-[44px] w-[44px] items-center justify-center rounded-xl bg-sky-brand/20 text-sky-brand-soft transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </form>
          <div className="mt-1.5 text-[0.68rem] text-fg/35">
            Enter to send · Shift + Enter for newline · blocks can be worked in any order
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  messageIndex,
  run,
  chatId,
  latestBlockKeys,
  onPick,
  busy,
}: {
  message: ScriptwriterUIMessage;
  messageIndex: number;
  run: ScriptRun;
  chatId: string;
  latestBlockKeys: Set<string>;
  onPick: (text: string) => void;
  busy: boolean;
}) {
  if (message.role === 'user') {
    const text = (message.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n\n');
    if (!text.trim()) return null;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-sky-brand/[0.12] px-4 py-2.5 text-[0.9rem] leading-relaxed text-fg">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {(message.parts ?? []).map((part, pi) => {
        switch (part.type) {
          case 'text':
            return part.text.trim() ? (
              <MarkdownRenderer
                key={`text-${pi}`}
                text={part.text}
                className="text-[0.9rem] leading-[1.75] text-fg/90"
              />
            ) : null;
          case 'data-sourcing-progress':
            return (
              <SourcingProgressCard
                key="sourcing-progress"
                progress={part.data as SourcingProgressData}
              />
            );
          case 'data-topics':
            return (
              <TopicProposalCards
                key="topics"
                topics={part.data as TopicCardData[]}
                onPick={onPick}
                busy={busy}
              />
            );
          case 'data-block': {
            const data = part.data as BlockPartData;
            const isLatest = latestBlockKeys.has(`${messageIndex}:${pi}`);
            const approved = isLatest && run.topics[data.topicIndex]?.stage === 'approved';
            // Key on the block slot (stable across revisions of the same block),
            // not the array index — keeps BlockCard's local state bound to the
            // logical block, not a positional slot.
            return (
              <BlockCard
                key={`block-${data.slot}`}
                block={data}
                approved={approved}
                onPick={onPick}
                busy={busy || !isLatest}
              />
            );
          }
          case 'data-episode':
            return (
              <EpisodeCard
                key="episode"
                episode={part.data as EpisodePartData}
                chatId={chatId}
                canUndo={run.episodeVersions.length > 0}
                onPick={onPick}
                busy={busy}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
