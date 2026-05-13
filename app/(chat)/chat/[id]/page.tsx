'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useParams } from 'next/navigation';
import { Square, Sparkles, FileText, ChevronRight, Copy, CheckCircle2, Pencil, ScrollText } from 'lucide-react';

import { MessageText } from '@/components/MessageText';
import { SourcePanel } from '@/components/SourcePanel';
import { SummaryModal } from '@/components/SummaryModal';
import { MODELS, getContextWindow } from '@/components/ModelSelector';
import { ChatComposer } from '@/components/ChatComposer';
import { ChatErrorBanner } from '@/components/ChatErrorBanner';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/EmptyState';
import { ArkLogo } from '@/components/ArkLogo';
import { TokenUsageIndicator } from '@/components/TokenUsageIndicator';
import type {
  ChatUIMessage,
  CountGuestAppearancesToolOutput,
  DossierToolOutput,
  LookupToolOutput,
  PanelView,
  Source,
  TopGuestsToolOutput,
  UsageData,
} from '@/components/chat-types';
import { cn } from '@/lib/cn';
import { chatFetch } from '@/lib/chat-fetch';
import { notifyChatUpdated } from '@/lib/chat-refresh';
import { useFlash } from '@/lib/use-flash';

const EXAMPLE_PROMPTS = [
  'What has Nadav Eyal said about the Houthis recently?',
  'Has Amit Segal contradicted himself on judicial reform?',
  'Summarize the latest takes on the hostage deal.',
  'Who discussed Iran sanctions in the last month?',
];

export default function ChatPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  const [initialMessages, setInitialMessages] = useState<ChatUIMessage[] | null>(null);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    fetch(`/api/chats/${chatId}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages?: ChatUIMessage[] }) => {
        if (!cancelled) setInitialMessages((d.messages ?? []) as ChatUIMessage[]);
      })
      .catch(() => {
        if (!cancelled) setInitialMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  if (!chatId || initialMessages === null) {
    return null;
  }
  return <ChatBody chatId={chatId} initialMessages={initialMessages} />;
}

function ChatBody({
  chatId,
  initialMessages,
}: {
  chatId: string;
  initialMessages: ChatUIMessage[];
}) {
  const [selectedModel, setSelectedModel] = useState(MODELS[1].id);
  const [input, setInput] = useState('');
  const [openPanel, setOpenPanel] = useState<PanelView | null>(null);
  const [episodeCount, setEpisodeCount] = useState<number | null>(null);
  const [copySuccess, flashCopySuccess] = useFlash(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [showUndoToast, flashShowUndoToast] = useFlash(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  type SummaryStatus = 'idle' | 'streaming' | 'done' | 'error';
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // Message count snapshot at the moment the summary started streaming. Used
  // to detect a stale cached summary on the next open instead of resetting
  // mid-stream (which would scramble in-flight chunks into the now-empty
  // buffer).
  const [summaryGeneratedAt, setSummaryGeneratedAt] = useState<number | null>(null);

  // Custom fetch that adds editingMessageId to the body if present
  const customFetch = useCallback<typeof fetch>(
    async (input, init) => {
      try {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (editingMessageId) {
          body.editingMessageId = editingMessageId;
        }
        return chatFetch(input, { ...init, body: JSON.stringify(body) });
      } catch (e) {
        console.error('Failed to parse request body for edit:', e);
        return chatFetch(input, init);
      }
    },
    [editingMessageId],
  );

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat<ChatUIMessage>({
      id: chatId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: '/api/chat',
        fetch: customFetch,
        headers: {
          'x-model': selectedModel,
        },
        body: { chatId },
      }),
      onFinish: () => {
        notifyChatUpdated();
        setEditingMessageId(null);
      },
    });

  const openSource = useCallback((source: Source, quote?: string) => {
    setOpenPanel({ view: 'source', source, quote });
  }, []);

  const handleEdit = useCallback(
    (message: ChatUIMessage) => {
      const textContent = message.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n\n');
      if (textContent) {
        setInput(textContent);
        setEditingMessageId(message.id);
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }
    },
    [],
  );

  const extractAnswerText = useCallback(() => {
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistantMsg) return null;
    const textParts = lastAssistantMsg.parts?.filter((p) => p.type === 'text') ?? [];
    if (textParts.length === 0) return null;
    const combined = textParts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    // Strip citation brackets like [id:123], [turn:456], or the quoted form
    // [id:123 "..."] / [turn:456 "..."].
    return combined
      .replace(/\[\s*(?:id|turn):\s*\d+(?:\s*,\s*\d+)*(?:\s+"[^"]*")?\s*\]/g, '')
      .trim();
  }, [messages]);

  const copyToClipboard = useCallback(async () => {
    const text = extractAnswerText();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      flashCopySuccess(true, 2000);
    } catch {
      alert('Failed to copy to clipboard');
    }
  }, [extractAnswerText, flashCopySuccess]);

  // messages.length read inside handleSummaryStart needs to reflect the count
  // at the moment the fetch begins. A ref avoids re-creating the callback (and
  // therefore re-running the modal's fetch effect) every time a message lands.
  const messagesLengthRef = useRef(messages.length);
  useEffect(() => {
    messagesLengthRef.current = messages.length;
  }, [messages.length]);

  const handleSummaryStart = useCallback(() => {
    setSummaryText('');
    setSummaryError(null);
    setSummaryStatus('streaming');
    setSummaryGeneratedAt(messagesLengthRef.current);
  }, []);

  const handleSummaryChunk = useCallback((chunk: string) => {
    setSummaryText((prev) => prev + chunk);
  }, []);

  const handleSummaryFinish = useCallback(() => {
    setSummaryStatus('done');
  }, []);

  const handleSummaryError = useCallback((message: string) => {
    setSummaryStatus('error');
    setSummaryError(message);
  }, []);

  const handleSummaryStop = useCallback(() => {
    // User pressed Stop, or modal closed mid-stream: keep whatever text
    // streamed so far, mark as done so Copy works on the partial result.
    setSummaryStatus('done');
  }, []);

  const handleSummarySource = useCallback(
    (source: Source, quote?: string) => {
      // Close modal so SourcePanel is visible; text stays cached so the user
      // can reopen and continue reading after inspecting the source.
      setSummaryOpen(false);
      setOpenPanel({ view: 'source', source, quote });
    },
    [],
  );

  const openSummary = useCallback(() => {
    // Decide if the cached summary is still usable. A stale cache (conversation
    // moved forward since the summary was generated), an error from the last
    // attempt, or an empty 'done' state (user stopped before any chunks
    // arrived) all warrant a fresh fetch. Otherwise we reopen with the cached
    // text so the user can keep reading.
    const isStale =
      summaryGeneratedAt !== null && summaryGeneratedAt !== messages.length;
    const isEmptyDone = summaryStatus === 'done' && !summaryText;
    if (isStale || isEmptyDone || summaryStatus === 'error') {
      setSummaryText('');
      setSummaryError(null);
      setSummaryStatus('idle');
      setSummaryGeneratedAt(null);
    }
    setSummaryOpen(true);
  }, [messages.length, summaryGeneratedAt, summaryStatus, summaryText]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

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
            if (!c.episode_id) {
              console.warn(`Dropping chunk ${c.id} with missing episode_id`);
              continue;
            }
            const key = `id:${c.id}`;
            map.set(key, {
              kind: 'chunk',
              id: c.id,
              key,
              episode_id: c.episode_id,
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
            if (!t.episode_id) {
              console.warn(`Dropping turn ${t.id} with missing episode_id`);
              continue;
            }
            const key = `turn:${t.id}`;
            map.set(key, {
              kind: 'turn',
              id: t.id,
              key,
              episode_id: t.episode_id,
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
            if (!c.episode_id) {
              console.warn(`Dropping chunk ${c.id} with missing episode_id`);
              continue;
            }
            const key = `id:${c.id}`;
            map.set(key, {
              kind: 'chunk',
              id: c.id,
              key,
              episode_id: c.episode_id,
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
            if (!t.episode_id) {
              console.warn(`Dropping turn ${t.id} with missing episode_id`);
              continue;
            }
            const key = `turn:${t.id}`;
            map.set(key, {
              kind: 'turn',
              id: t.id,
              key,
              episode_id: t.episode_id,
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
            if (!ep.episode_id) {
              console.warn('Dropping episode with missing episode_id');
              continue;
            }
            const key = `ep:${ep.episode_id}`;
            map.set(key, {
              kind: 'episode',
              id: ep.episode_id,
              key,
              episode_id: ep.episode_id,
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

  // Cumulative token usage is a pure projection of assistant-message metadata,
  // so derive it instead of mirroring it into state via an effect.
  const cumulativeUsage = useMemo<UsageData | null>(() => {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.metadata) {
        const usage = (msg.metadata as { usage?: UsageData }).usage;
        if (usage) {
          totalInput += usage.inputTokens;
          totalOutput += usage.outputTokens;
          totalCached += usage.cachedInputTokens;
        }
      }
    }

    if (totalInput === 0 && totalOutput === 0) return null;
    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedInputTokens: totalCached,
      contextWindow: getContextWindow(selectedModel),
    };
  }, [messages, selectedModel]);

  // Auto-focus input when entering edit mode. The setTimeout(0) defers the
  // focus until after React commits the input value so setSelectionRange
  // operates on the populated value, not the empty initial render.
  useEffect(() => {
    if (!editingMessageId || !inputRef.current) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, [editingMessageId]);

  // Handle Escape key to cancel edit
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && editingMessageId) {
        e.preventDefault();
        setEditingMessageId(null);
        setInput('');
      }
    };
    if (editingMessageId) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [editingMessageId]);

  const submit = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const wasEditing = editingMessageId !== null;
    sendMessage({ text: q });
    setInput('');
    // Don't reset the summary here. If the modal is open and streaming, a
    // reset would clear the buffer mid-stream while the in-flight fetch keeps
    // appending chunks. The next open will detect the stale message count and
    // refetch (see openSummary).
    if (wasEditing) {
      flashShowUndoToast(true, 3000);
    }
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header variant="archive" episodeCount={episodeCount} />

        {/* ---------- Message list ---------- */}
        <main
          ref={scrollRef}
          className="relative flex-1 overflow-y-auto"
        >
          <div className={cn('flex w-full flex-col gap-7 px-5 py-10', messages.length === 0 && 'min-h-full')}>
            {messages.length === 0 ? (
              <EmptyState
                title="Ask the"
                highlight="arkive"
                description="Every answer is cited against the Ark Media podcast transcripts. Ask who said what, compare takes, trace a story over time."
                prompts={EXAMPLE_PROMPTS}
                onPick={submit}
                busy={busy}
                promptLayout="grid"
              />
            ) : null}

            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                sources={sources}
                onOpen={openSource}
                onOpenPanel={setOpenPanel}
                onEdit={handleEdit}
                isEditing={editingMessageId === m.id}
              />
            ))}

            {messages.some((m) => m.role === 'assistant') && !busy ? (
              <div className="flex flex-col gap-3 pl-12">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={copyToClipboard}
                    disabled={!messages.some((m) => m.role === 'assistant')}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                      'bg-emerald-500/20 text-emerald-200 transition hover:bg-emerald-500/30',
                      'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-500/20',
                    )}
                  >
                    {copySuccess ? (
                      <>
                        <CheckCircle2 className="h-4 w-4" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4" />
                        Copy Answer
                      </>
                    )}
                  </button>
                  <button
                    onClick={openSummary}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                      'border border-overlay/10 bg-overlay/5 text-fg/75 transition hover:bg-overlay/10 hover:text-fg',
                    )}
                    title="Compose a handoff message you can paste into a fresh chat to continue this conversation"
                  >
                    <ScrollText className="h-4 w-4" />
                    Hand off to new chat
                  </button>
                </div>
                {cumulativeUsage && (
                  <TokenUsageIndicator usage={cumulativeUsage} />
                )}
              </div>
            ) : null}

            {busy ? (
              <div className="flex items-center gap-3 pl-12 text-xs text-fg/50">
                <TypingDots />
                <span className="tracking-wide">
                  {status === 'submitted' ? 'Summoning context…' : 'Writing…'}
                </span>
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
              className="ml-12"
            />
          </div>
        </main>

        {/* ---------- Edit Mode Indicator ---------- */}
        {editingMessageId ? (
          <div className="border-t border-blue-500/20 bg-blue-500/5 px-6 py-2.5 flex items-center justify-between animate-in fade-in duration-200">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-xs font-medium text-blue-300/80">Editing • Press ESC to cancel</span>
            </div>
            <button
              onClick={() => {
                setEditingMessageId(null);
                setInput('');
              }}
              className="text-xs px-2.5 py-1 rounded text-blue-300/60 hover:text-blue-300 hover:bg-blue-500/10 transition"
            >
              Cancel
            </button>
          </div>
        ) : null}

        {/* ---------- Undo Toast ---------- */}
        {showUndoToast ? (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-blue-900/90 backdrop-blur text-blue-100 px-4 py-2.5 rounded-lg text-sm border border-blue-500/20 animate-in fade-in slide-in-from-bottom-2 duration-300 z-50">
            ✓ Message updated
          </div>
        ) : null}

        {/* ---------- Composer ---------- */}
        <ChatComposer
          input={input}
          onInputChange={setInput}
          onSubmit={() => submit(input)}
          placeholder="Ask about past episodes…"
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          busy={busy}
          canSubmit={input.trim().length > 0}
          footerHint="Enter to send · Shift + Enter for newline"
        />
      </div>

      {openPanel ? (
        <SourcePanel
          panel={openPanel}
          onClose={() => setOpenPanel(null)}
          onChange={setOpenPanel}
        />
      ) : null}

      <SummaryModal
        open={summaryOpen}
        chatId={chatId}
        text={summaryText}
        status={summaryStatus}
        errorMessage={summaryError}
        sources={sources}
        onOpenSource={handleSummarySource}
        onClose={() => setSummaryOpen(false)}
        onStart={handleSummaryStart}
        onChunk={handleSummaryChunk}
        onFinish={handleSummaryFinish}
        onError={handleSummaryError}
        onStop={handleSummaryStop}
      />
    </div>
  );
}

/* ============================================================
   Sub-components
   ============================================================ */

type MsgProps = {
  message: ReturnType<typeof useChat>['messages'][number];
  sources: Map<string, Source>;
  onOpen: (s: Source, quote?: string) => void;
  onOpenPanel: (panel: PanelView) => void;
  onEdit?: (message: ChatUIMessage) => void;
  isEditing?: boolean;
};

function MessageRow({ message, sources, onOpen, onOpenPanel, onEdit, isEditing }: MsgProps) {
  const [copyState, flashCopyState] = useFlash<'idle' | 'success' | 'error'>('idle');

  const extractTextContent = useCallback((): string => {
    const textParts: string[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        textParts.push(part.text);
      }
    }
    return textParts.join('\n\n');
  }, [message.parts]);

  const handleCopy = useCallback(async () => {
    const text = extractTextContent();
    try {
      await navigator.clipboard.writeText(text);
      flashCopyState('success', 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      flashCopyState('error', 2000);
    }
  }, [extractTextContent, flashCopyState]);

  if (message.role === 'user') {
    return (
      <div className="ark-fade-up flex justify-end gap-2 items-start group">
        <div
          className={cn(
            'max-w-[82%] rounded-2xl rounded-br-md px-4 py-2.5',
            'bg-gradient-to-br from-sky-brand to-sky-brand-deep text-ink-950',
            'shadow-[0_8px_22px_-10px_rgba(62,181,249,0.6)]',
            'text-[0.95rem] font-medium leading-relaxed',
            'transition-all duration-200',
            isEditing && 'ring-2 ring-blue-400/50 shadow-[0_8px_22px_-10px_rgba(59,130,246,0.5)]',
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
        {onEdit ? (
          <button
            onClick={() => onEdit(message as ChatUIMessage)}
            className={cn(
              'mt-1 p-1.5 rounded-lg transition-all opacity-0 group-hover:opacity-100 duration-200',
              isEditing
                ? 'bg-blue-400/20 text-blue-300 hover:bg-blue-400/30'
                : 'hover:bg-overlay/10 text-fg/50 hover:text-fg/70',
            )}
            title="Edit message (or click to edit)"
          >
            <Pencil className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ark-fade-up flex gap-4">
      <div
        aria-hidden
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-overlay/10 bg-gradient-to-br from-ink-800 to-ink-950"
      >
        <ArkLogo className="h-7" bg="transparent" fg="#3eb5f9" markOnly />
      </div>

      <div className="min-w-0 flex-1 space-y-3 group">
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

        <button
          type="button"
          onClick={handleCopy}
          title={
            copyState === 'success'
              ? 'Copied!'
              : copyState === 'error'
                ? 'Failed to copy'
                : 'Copy response'
          }
          aria-label={
            copyState === 'success'
              ? 'Copied!'
              : copyState === 'error'
                ? 'Failed to copy'
                : 'Copy response'
          }
          className={cn(
            'mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5',
            'text-[0.7rem] font-medium transition opacity-0 group-hover:opacity-100',
            copyState === 'success'
              ? 'bg-emerald-400/20 text-emerald-300'
              : copyState === 'error'
                ? 'bg-red-400/20 text-red-300'
                : 'bg-overlay/5 text-fg/50 hover:bg-overlay/10 hover:text-fg/70',
          )}
        >
          {copyState === 'success' ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>Copied</span>
            </>
          ) : copyState === 'error' ? (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Failed</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
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
                <div className="truncate text-[0.85rem] font-medium text-fg/90">
                  {ep.title}
                </div>
                <div className="mt-0.5 text-[0.7rem] text-fg/45">
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
      <div className="flex items-center gap-2 text-[0.72rem] text-fg/50">
        <span className="uppercase tracking-[0.18em]">Top Guests</span>
        <span className="text-fg/25">·</span>
        <span className="text-sky-brand-soft">{scopeLabel}</span>
        {dateRange ? (
          <>
            <span className="text-fg/25">·</span>
            <span className="text-fg/60">{dateRange}</span>
          </>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-overlay/10 bg-overlay/[0.02]">
        <table className="w-full text-[0.88rem]">
          <thead>
            <tr className="border-b border-overlay/[0.06] text-left text-[0.68rem] uppercase tracking-[0.14em] text-fg/40">
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
                className="border-t border-overlay/[0.04] transition hover:bg-overlay/[0.025]"
              >
                <td className="px-4 py-2.5 text-fg/60">
                  <RankBadge rank={g.rank} />
                </td>
                <td className="px-4 py-2.5 font-medium text-fg/90">
                  {g.speaker_name}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-fg/75 tabular-nums">
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
                      'inline-flex items-center gap-1 rounded-md border border-sky-brand/30 bg-sky-brand/[0.08]',
                      'px-2 py-1 text-[0.72rem] font-medium text-sky-brand-soft',
                      'transition hover:border-sky-brand/60 hover:bg-sky-brand/[0.18] hover:text-fg',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-brand/60',
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
        <div className="text-[0.7rem] text-fg/40">
          Tied ranks share a position; within a tier guests are listed alphabetically.
        </div>
      ) : null}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="font-mono text-amber-300">🥇 1</span>;
  if (rank === 2) return <span className="font-mono text-fg/80">🥈 2</span>;
  if (rank === 3) return <span className="font-mono text-orange-300">🥉 3</span>;
  return <span className="font-mono text-fg/55">{rank}</span>;
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
        'inline-flex items-center gap-2 rounded-lg border border-overlay/10 bg-overlay/[0.03]',
        'px-2.5 py-1 text-[0.72rem] text-fg/65',
      )}
    >
      <Icon
        className={cn(
          'h-3.5 w-3.5 text-sky-brand',
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
          className="h-1.5 w-1.5 rounded-full bg-sky-brand ark-pulse-dot"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}

