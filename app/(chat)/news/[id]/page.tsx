'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useParams } from 'next/navigation';
import {
  Loader2,
  X,
  HardDriveUpload,
  ExternalLink,
  CheckCircle2,
  Radar,
} from 'lucide-react';

import { Header } from '@/components/Header';
import { DEFAULT_MODEL_ID } from '@/components/ModelSelector';
import { ChatComposer } from '@/components/ChatComposer';
import { ChatErrorBanner } from '@/components/ChatErrorBanner';
import { EmptyState } from '@/components/EmptyState';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { KindBadge } from '@/components/ui/KindBadge';
import type {
  DraftSnapshot,
  NewsUIMessage,
  NewsSource,
  ScanResult,
  ScanProgressSnapshot,
  Suggestion,
  Tier,
} from '@/components/news-types';
import { BusyRow } from '@/components/ui/BusyRow';
import { UserBubble } from '@/components/ui/UserBubble';
import { EditingBanner } from '@/components/ui/EditingBanner';
import { CopyButton } from '@/components/ui/CopyButton';
import { HandoffButton } from '@/components/ui/HandoffButton';
import { FileAttachments } from '@/components/ui/FileAttachments';
import { cn } from '@/lib/cn';
import { notifyChatUpdated } from '@/lib/chat-refresh';
import { useFlash } from '@/lib/use-flash';
import { useDriveSave } from '@/lib/use-drive-save';
import { useInitialMessages } from '@/lib/use-initial-messages';
import { useMessageEditing } from '@/lib/use-message-editing';
import { useFileAttachments } from '@/lib/use-file-attachments';
import { useHandoffSummary } from '@/lib/use-handoff-summary';
import {
  NEWS_DEFAULT_TEMPERATURE_PRESET,
  type TemperaturePresetId,
} from '@/lib/temperature';
import { MAX_FILES, MAX_FILE_BYTES, formatBytes } from '@/lib/prep-limits';

const EXAMPLE_PROMPTS = [
  'Outline: Lead — Trump signals end to Iran War. B Block — New Middle East realignment. C Block — Passover under bombardment. Sources: WSJ, CBS, Times of Israel',
  'Breaking: Gaza humanitarian crisis. Market implications. EU response.',
  'Ukraine conflict update. NATO unity questions. Weapons systems analysis.',
];

const REFINEMENT_HINTS = [
  'Tighten the B block and cut unnecessary detail.',
  'Make the C block warmer and more reflective.',
  'Smooth the transition from A to B — they feel disconnected.',
  'Simplify the arms sales paragraph.',
  'Strengthen the opening to be more compelling.',
];

export default function NewsPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  const initialMessages = useInitialMessages<NewsUIMessage>(chatId);

  if (!chatId || initialMessages === null) {
    return null;
  }
  return <NewsBody chatId={chatId} initialMessages={initialMessages} />;
}

// Labels shown next to the typing indicator while a tool is in flight, keyed by
// the on-the-wire `tool-*` part type. This makes the status reflect the actual
// operation (e.g. a breaking-news scan) instead of a generic "Generating script…".
const IN_FLIGHT_TOOL_LABELS: Record<string, string> = {
  'tool-scanBreakingNews': 'Scanning news sources…',
  'tool-fetchArticle': 'Fetching article…',
  'tool-searchCorpus': 'Loading style examples…',
  'tool-webSearch': 'Searching the web…',
};

// Derive the busy-indicator label from what is actually happening this turn. An
// in-flight tool call is the most accurate signal (e.g. a breaking-news scan);
// before one streams, fall back to the generic fetch/draft phases.
function busyLabel(messages: NewsUIMessage[], status: string): string {
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

  return status === 'submitted' ? 'Fetching articles…' : 'Generating script…';
}

function NewsBody({
  chatId,
  initialMessages,
}: {
  chatId: string;
  initialMessages: NewsUIMessage[];
}) {
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [selectedTemperature, setSelectedTemperature] =
    useState<TemperaturePresetId>(NEWS_DEFAULT_TEMPERATURE_PRESET);
  const [input, setInput] = useState('');
  const {
    files,
    uploadError,
    attachSuccess,
    onPickFiles,
    removeFile,
    clearFiles,
    asFileList,
  } = useFileAttachments();
  const { driveLoading, driveLink, driveError, save, resetDrive } =
    useDriveSave('/api/news/upload');
  const [openSource, setOpenSource] = useState<NewsSource | null>(null);
  const [copySuccess, flashCopySuccess, resetCopySuccess] = useFlash(false);
  const [showUndoToast, flashShowUndoToast] = useFlash(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const {
    editingMessageId,
    startEditing,
    cancelEditing,
    finishEditing,
    editingFetch,
  } = useMessageEditing({ setInput, scrollRef });

  // Rebuilt only when something it carries changes — not on every render —
  // so a keystroke elsewhere doesn't churn a fresh transport. The header
  // values (model, temperature) are captured here, so a change to either
  // flows through on the next send.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/news',
        fetch: editingFetch,
        headers: {
          'x-model': selectedModel,
          'x-temperature': selectedTemperature,
        },
        body: { chatId },
      }),
    [editingFetch, selectedModel, selectedTemperature, chatId],
  );

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat<NewsUIMessage>({
      id: chatId,
      messages: initialMessages,
      transport,
      onFinish: () => {
        notifyChatUpdated();
        finishEditing();
      },
    });

  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, busy]);

  const submit = (text: string) => {
    const q = text.trim();
    if ((!q && files.length === 0) || busy) return;
    const wasEditing = editingMessageId !== null;
    sendMessage({ text: q, files: asFileList() });
    setInput('');
    clearFiles();
    if (wasEditing) {
      flashShowUndoToast(true, 3000);
    }
    // Reset post-generation actions when starting a new turn.
    resetDrive();
    resetCopySuccess();
  };

  // A finalized script is "present" once the conversation carries block-marked
  // script text (pasted or generated) or an uploaded file the writer may have
  // dropped in. Gates the "Scan for breaking news" affordance.
  const hasFinalizedScript = useMemo(
    () =>
      messages.some((m) =>
        (m.parts ?? []).some(
          (p) =>
            (p.type === 'text' &&
              /(?:^|\n)[ \t>*#]*\[?[ \t]*[A-D][ \t]+BLOCK\b/i.test(p.text)) ||
            p.type === 'file',
        ),
      ),
    [messages],
  );

  // Phase 1: ask the model to run scanBreakingNews against the finalized script
  // already in context. Explicitly suggestions-only — no edits on this turn.
  const triggerScan = () => {
    submit(
      'Check for breaking news that may have broken since I locked this finalized script, ' +
        'and show me the Swap / Update / Can\'t-ignore / Human-interest suggestions. ' +
        'Do not edit or redraft the script on this turn.',
    );
  };

  // Phase 2: accept one suggestion. Sends an acceptance message that identifies
  // the specific story; it does NOT itself mutate the script — the model runs
  // the understanding gate first and integrates only after confirmation.
  const acceptSuggestion = (s: Suggestion) => {
    const integration =
      s.tier === 'Update' && s.block
        ? `revise the ${s.block} block`
        : s.block
          ? `swap it into the ${s.block} block`
          : 'integrate it';
    submit(
      `I accept the ${s.tier} suggestion: "${s.headline}". ` +
        `Walk me through your understanding of this story first, and after I confirm, ${integration}. ` +
        'Do not touch the rest of the script.',
    );
  };

  const extractScriptText = useCallback(() => {
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistantMsg) return null;
    const textParts = lastAssistantMsg.parts?.filter((p) => p.type === 'text') ?? [];
    if (textParts.length === 0) return null;
    return textParts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }, [messages]);

  // Derived from the most recent assistant message that actually carries text.
  // Scanning for the last *text-bearing* message rather than the last message
  // outright keeps the source panel populated through turns that open with tool
  // calls, where the newest assistant message has no text parts yet. The state +
  // effect this replaces got the same effect by never clearing on a null script.
  const allSources = useMemo<NewsSource[]>(() => {
    const lastWithText = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.parts?.some((p) => p.type === 'text'));
    if (!lastWithText) return [];
    const scriptText = (lastWithText.parts ?? [])
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n');
    return scriptText ? extractSources(scriptText) : [];
  }, [messages]);

  const { openSummary, modal: summaryModal } = useHandoffSummary({
    chatId,
    messagesLength: messages.length,
  });

  const copyScriptToClipboard = useCallback(async () => {
    const scriptText = extractScriptText();
    if (!scriptText?.trim()) return;

    try {
      await navigator.clipboard.writeText(scriptText);
      flashCopySuccess(true, 2000);
    } catch {
      // Fallback: show alert if clipboard API fails
      alert('Failed to copy to clipboard');
    }
  }, [extractScriptText, flashCopySuccess]);

  const saveScriptToDrive = useCallback(async () => {
    const scriptText = extractScriptText();
    if (!scriptText?.trim()) return;
    await save({
      scriptText,
      title: extractHeadline(scriptText) || 'News Script',
      date: new Date().toISOString().split('T')[0],
    });
  }, [save, extractScriptText]);

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header variant="news" />

        {/* Message list */}
        <main ref={scrollRef} className="relative flex-1 overflow-y-auto">
          <div className={cn('flex w-full flex-col gap-7 px-5 py-10', messages.length === 0 && 'min-h-full')}>
            {messages.length === 0 ? (
              <EmptyState
                title="Ark news"
                highlight="daily"
                description="Generate a complete daily news script with full sourcing and editorial flags."
                prompts={EXAMPLE_PROMPTS}
                onPick={submit}
                busy={busy}
                promptLayout="grid"
                promptLabel="Example outlines:"
              />
            ) : null}

            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                onSourceClick={setOpenSource}
                sources={allSources}
                onEdit={startEditing}
                isEditing={editingMessageId === m.id}
                onAccept={acceptSuggestion}
                busy={busy}
              />
            ))}

            {busy ? <BusyRow label={busyLabel(messages, status)} onStop={stop} /> : null}

            <ChatErrorBanner
              error={error}
              onRetry={() => {
                clearError();
                regenerate();
              }}
              onDismiss={clearError}
            />

            {!busy && messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' ? (
              <div className="mt-4 flex flex-col gap-3 border-t border-overlay/10 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  {driveLink ? (
                    <div className="inline-flex items-center gap-2 rounded-lg bg-green-500/10 px-4 py-2.5 text-sm text-green-200">
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Saved to Drive</span>
                      <a
                        href={driveLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-green-300 transition hover:bg-overlay/10"
                      >
                        Open
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ) : driveError ? (
                    <div className="rounded-lg bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
                      {driveError}
                    </div>
                  ) : (
                    <button
                      onClick={saveScriptToDrive}
                      disabled={driveLoading || !messages.length}
                      className={cn(
                        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                        'bg-blue-500/20 text-blue-200 transition hover:bg-blue-500/30',
                        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-500/20',
                      )}
                    >
                      {driveLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Uploading…
                        </>
                      ) : (
                        <>
                          <HardDriveUpload className="h-4 w-4" />
                          Save to Drive
                        </>
                      )}
                    </button>
                  )}

                  <CopyButton
                    onClick={copyScriptToClipboard}
                    copied={copySuccess}
                    label="Copy to Clipboard"
                    disabled={!messages.length}
                  />

                  <HandoffButton
                    onClick={openSummary}
                    title="Compose a handoff message you can paste into a fresh chat to continue this script"
                  />
                </div>

                <div className="mt-2">
                  <div className="text-xs font-medium uppercase tracking-[0.2em] text-fg/40 mb-2">
                    Refine the script
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {REFINEMENT_HINTS.map((hint, i) => (
                      <button
                        key={i}
                        onClick={() => submit(hint)}
                        disabled={busy}
                        className={cn(
                          'rounded-full border border-overlay/20 bg-overlay/[0.03] px-3 py-1 text-[0.75rem] text-fg/70',
                          'transition hover:border-overlay/40 hover:bg-overlay/[0.06] hover:text-fg',
                          'disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      >
                        {hint}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </main>

        {/* Edit Mode Indicator */}
        <EditingBanner editing={editingMessageId !== null} onCancel={cancelEditing} />

        {/* Undo Toast */}
        {showUndoToast ? (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-blue-900/90 backdrop-blur text-blue-100 px-4 py-2.5 rounded-lg text-sm border border-blue-500/20 animate-in fade-in slide-in-from-bottom-2 duration-300 z-50">
            ✓ Message updated
          </div>
        ) : null}

        {/* Scan-for-breaking-news trigger (Phase 1) — available once a
            finalized script is present in the conversation. */}
        {hasFinalizedScript && !busy ? (
          <div className="border-t border-overlay/10 px-6 py-2.5">
            <button
              type="button"
              onClick={triggerScan}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm',
                'bg-amber-500/15 text-amber-200 transition hover:bg-amber-500/25',
              )}
              title="Scan approved outlets for breaking news since this script was locked"
            >
              <Radar className="h-4 w-4" />
              Scan for breaking news
            </button>
          </div>
        ) : null}

        {/* Composer */}
        <ChatComposer
          input={input}
          onInputChange={setInput}
          onSubmit={() => submit(input)}
          placeholder="Story outline with article links"
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          selectedTemperature={selectedTemperature}
          onTemperatureChange={setSelectedTemperature}
          busy={busy}
          canSubmit={input.trim().length > 0 || files.length > 0}
          footerHint={`Enter to send · Shift + Enter for newline · Up to ${MAX_FILES} files, ${formatBytes(MAX_FILE_BYTES)} each`}
          fileAttach={{
            accept:
              '.pdf,.md,.txt,.csv,.tsv,.json,.yml,.yaml,.png,.jpg,.jpeg,.gif,.webp,application/pdf,text/markdown,text/plain,text/csv,application/json,image/*',
            multiple: true,
            onPick: onPickFiles,
            ariaLabel: 'Attach files',
            tooltip: 'Attach source articles or outline notes',
          }}
          attachments={
            <FileAttachments
              files={files}
              uploadError={uploadError}
              onRemove={removeFile}
              showSuccess
              attachSuccess={attachSuccess}
            />
          }
        />
      </div>

      {/* Sources sidebar */}
      {openSource ? (
        <aside className="ark-fade-up relative flex h-full w-full max-w-md flex-col border-l border-overlay/10 bg-canvas-deep/80 backdrop-blur-xl">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              background:
                'radial-gradient(80% 50% at 50% 0%, rgba(62,181,249,0.14) 0%, transparent 60%)',
            }}
          />
          <header className="relative flex items-start justify-between gap-3 border-b border-overlay/10 px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <KindBadge tone="sky">Source {openSource.number}</KindBadge>
              </div>
              <div className="mt-2 truncate font-display text-base font-bold text-fg">
                {openSource.title}
              </div>
              {openSource.date ? (
                <div className="mt-1 text-xs text-fg/55">{openSource.date}</div>
              ) : null}
            </div>
            <button
              onClick={() => setOpenSource(null)}
              className="rounded p-1 text-fg/60 transition hover:bg-overlay/10 hover:text-fg"
              aria-label="Close source"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="relative flex-1 overflow-y-auto px-5 py-5">
            <a
              href={openSource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[0.92rem] leading-[1.7] text-cyan-400 hover:text-cyan-300 underline break-all transition"
            >
              {openSource.url}
            </a>
          </div>
        </aside>
      ) : null}

      {summaryModal}
    </div>
  );
}

/* Helpers */

function extractHeadline(scriptText: string): string | null {
  // Extract from A BLOCK intro (usually the first few words after [A BLOCK])
  const aBlockMatch = scriptText.match(/\[A BLOCK\]\s*HOST:\s*(.+?)(?:\n|$)/);
  if (aBlockMatch) {
    let text = aBlockMatch[1].trim();
    // Try to get up to the first sentence boundary
    const sentenceMatch = text.match(/^(.+?)[.!?]\s/);
    if (sentenceMatch) {
      text = sentenceMatch[1];
    } else {
      // Fallback: take first ~70 chars as a headline
      text = text.slice(0, 70).trim();
    }
    // Ensure it's a reasonable length for a headline
    if (text && text.length > 10 && text.length <= 150) {
      return text;
    }
  }
  return null;
}

function extractSources(scriptText: string): NewsSource[] {
  const sources: NewsSource[] = [];
  const sourcesMatch = scriptText.match(/SOURCES:\s*([\s\S]+?)(?:\n---|\Z)/);
  if (!sourcesMatch) return sources;

  const sourceLines = sourcesMatch[1].trim().split('\n');
  for (const line of sourceLines) {
    const match = line.match(/^(\d+)\.\s+(.+?),\s*"([^"]+)",\s*(.+?)\s*—\s*(.+?)$/);
    if (match) {
      const [, numStr, title, date, source, url] = match;
      sources.push({
        id: `source-${numStr}`,
        number: parseInt(numStr),
        title: `${source}, "${title}"`,
        date: date || null,
        url: url.trim(),
      });
    }
  }
  return sources;
}

/* Sub-components */

function MessageRow({
  message,
  onSourceClick,
  sources,
  onEdit,
  isEditing,
  onAccept,
  busy,
}: {
  message: NewsUIMessage;
  onSourceClick: (source: NewsSource) => void;
  sources: NewsSource[];
  onEdit?: (message: NewsUIMessage) => void;
  isEditing?: boolean;
  onAccept: (s: Suggestion) => void;
  busy: boolean;
}) {
  if (message.role === 'user') {
    const textParts = message.parts?.filter((p) => p.type === 'text') ?? [];
    const fileParts = message.parts?.filter((p) => p.type === 'file') ?? [];
    return (
      <UserBubble
        textParts={textParts.flatMap((p) => (p.type === 'text' ? [p.text] : []))}
        isEditing={isEditing}
        onEdit={onEdit ? () => onEdit(message) : undefined}
        files={
          fileParts.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {fileParts.map((p, i) => (
                <span key={i} className="inline-block rounded bg-overlay/20 px-1.5 py-0.5 text-[0.85rem]">
                  {p.filename ?? 'file'}
                </span>
              ))}
            </div>
          ) : null
        }
      />
    );
  }

  return (
    <div className="ark-fade-up flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-overlay/[0.04] px-4 py-3 text-fg">
        <MessageContent
          message={message}
          onSourceClick={onSourceClick}
          sources={sources}
          onAccept={onAccept}
          busy={busy}
        />
      </div>
    </div>
  );
}

function MessageContent({
  message,
  onSourceClick,
  sources,
  onAccept,
  busy,
}: {
  message: NewsUIMessage;
  onSourceClick: (source: NewsSource) => void;
  sources: NewsSource[];
  onAccept: (s: Suggestion) => void;
  busy: boolean;
}) {
  // The final text part supersedes the provisional draft: once it lands, the
  // draft is stale and rendering both would show the script twice.
  const hasFinalText = message.parts?.some((p) => p.type === 'text') ?? false;

  return message.parts?.map((part, i) => {
    if (part.type === 'text') {
      return <NewsMarkdown key={i} text={part.text} onSourceClick={onSourceClick} sources={sources} />;
    }
    if (part.type === 'data-draft') {
      if (hasFinalText) return null;
      return <DraftScript key={i} data={part.data} onSourceClick={onSourceClick} sources={sources} />;
    }
    if (part.type === 'data-breaking-progress') {
      return <BreakingProgress key={i} data={part.data} />;
    }
    if (part.type === 'data-breaking-suggestions') {
      return <BreakingSuggestions key={i} data={part.data} onAccept={onAccept} busy={busy} />;
    }
    if (part.type === 'tool-fetchArticle') {
      const state = (part as { state?: string }).state;
      if (state === 'input-streaming' || state === 'input-available') {
        return <ToolCallChip key={i} name="Fetching article…" status="in-flight" />;
      }
      if (state === 'output-available') {
        return <ToolCallChip key={i} name="Article fetched" status="done" />;
      }
    }
    if (part.type === 'tool-searchCorpus') {
      const state = (part as { state?: string }).state;
      if (state === 'input-streaming' || state === 'input-available') {
        return <ToolCallChip key={i} name="Loading style examples…" status="in-flight" />;
      }
      if (state === 'output-available') {
        return <ToolCallChip key={i} name="Style examples loaded" status="done" />;
      }
    }
    if (part.type === 'tool-webSearch') {
      const state = (part as { state?: string }).state;
      if (state === 'input-streaming' || state === 'input-available') {
        return <ToolCallChip key={i} name="Searching the web…" status="in-flight" />;
      }
      if (state === 'output-available') {
        return <ToolCallChip key={i} name="Web search complete" status="done" />;
      }
    }
    return null;
  });
}

/* The model's text as it streams, before the editor pass has approved it */

// Rendered only while there is no final text part. The banner is the whole
// point: a script shown here may still be rewritten by the reflect pass, and
// the reader needs to know that the words in front of them are not final.
function DraftScript({
  data,
  onSourceClick,
  sources,
}: {
  data: DraftSnapshot;
  onSourceClick: (source: NewsSource) => void;
  sources: NewsSource[];
}) {
  const reviewing = data.status === 'reviewing';
  return (
    <div className="ark-fade-up">
      <div
        className={cn(
          'mb-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-medium',
          reviewing ? 'bg-amber-500/20 text-amber-200' : 'bg-blue-500/20 text-blue-200',
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {reviewing ? 'Draft — editor reviewing…' : 'Drafting…'}
      </div>
      <div className={cn(reviewing && 'opacity-70')}>
        <NewsMarkdown text={data.text} onSourceClick={onSourceClick} sources={sources} />
      </div>
    </div>
  );
}

function ToolCallChip({ name, status }: { name: string; status: 'in-flight' | 'done' }) {
  const bgColor = status === 'in-flight' ? 'bg-blue-500/20' : 'bg-green-500/20';
  const textColor = status === 'in-flight' ? 'text-blue-200' : 'text-green-200';
  return (
    <span className={cn('inline-block rounded-full px-2.5 py-1 text-[0.75rem] font-medium', bgColor, textColor)}>
      {status === 'in-flight' ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}
      {name}
    </span>
  );
}

/* Breaking-news scan (Phase 1) live progress checklist */

// Ordered stages of the scan pipeline, mapped to the accumulated snapshot. Each
// completed stage renders as a checked line; the first not-yet-complete stage
// renders as the active (spinner) line, and later stages stay hidden until
// reached — so the checklist grows as the pipeline advances.
function BreakingProgress({ data }: { data: ScanProgressSnapshot }) {
  const steps: Array<{ done: boolean; text: string; pending: string }> = [
    {
      done: data.discovered !== undefined,
      text: `${data.discovered} ${data.discovered === 1 ? 'story' : 'stories'} found since the lock`,
      pending: 'Scanning approved outlets…',
    },
    {
      done: data.afterExclusion !== undefined,
      text: `${data.afterExclusion} clear the first filter`,
      pending: 'Filtering out routine coverage…',
    },
    {
      done: data.afterNovelty !== undefined,
      text: `${data.afterNovelty} new or updated vs. your script`,
      pending: 'Comparing against your script…',
    },
    {
      done: data.suggestions !== undefined,
      text: `${data.suggestions} ${data.suggestions === 1 ? 'suggestion' : 'suggestions'}`,
      pending: 'Grading significance…',
    },
  ];

  const lines: ReactNode[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.done) {
      lines.push(
        <div key={i} className="flex items-center gap-2 text-fg/45">
          <CheckCircle2 className="h-3 w-3 shrink-0 text-green-400/70" />
          <span>{s.text}</span>
        </div>,
      );
    } else {
      // First incomplete step is the active frontier; stop after it.
      lines.push(
        <div key={i} className="flex items-center gap-2 text-fg/60">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          <span>{s.pending}</span>
        </div>,
      );
      break;
    }
  }

  return <div className="flex flex-col gap-1.5 pl-12 text-xs tracking-wide">{lines}</div>;
}

/* Breaking-news scan (Phase 1) suggestion cards */

const TIER_ORDER: Tier[] = ["Can't-ignore", 'Update', 'Swap', 'Human-interest'];

const TIER_STYLES: Record<Tier, string> = {
  "Can't-ignore": 'bg-rose-500/20 text-rose-200',
  Update: 'bg-amber-500/20 text-amber-200',
  Swap: 'bg-sky-500/20 text-sky-200',
  'Human-interest': 'bg-emerald-500/20 text-emerald-200',
};

function formatCutoff(cutoff: string): string {
  const d = new Date(cutoff);
  if (Number.isNaN(d.getTime())) return cutoff;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function BreakingSuggestions({
  data,
  onAccept,
  busy,
}: {
  data: ScanResult;
  onAccept: (s: Suggestion) => void;
  busy: boolean;
}) {
  const cutoffLabel = formatCutoff(data.cutoff);

  if (data.suggestions.length === 0) {
    return (
      <div className="my-2 rounded-xl border border-overlay/10 bg-overlay/[0.03] px-4 py-3 text-sm text-fg/70">
        No breaking news clears the bar since {cutoffLabel}.
      </div>
    );
  }

  const groups = TIER_ORDER.map((tier) => ({
    tier,
    items: data.suggestions.filter((s) => s.tier === tier),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="my-2 flex flex-col gap-4">
      <div className="text-xs uppercase tracking-[0.2em] text-fg/40">
        Breaking-news scan · since {cutoffLabel}
      </div>
      {groups.map((group) => (
        <div key={group.tier} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[0.72rem] font-semibold uppercase tracking-wide',
                TIER_STYLES[group.tier],
              )}
            >
              {group.tier}
            </span>
            <span className="text-[0.72rem] text-fg/40">
              {group.items.length} {group.items.length === 1 ? 'story' : 'stories'}
            </span>
          </div>
          {group.items.map((s, i) => (
            <SuggestionCard key={i} s={s} onAccept={onAccept} busy={busy} />
          ))}
        </div>
      ))}
      {data.suppressedCount > 0 ? (
        <div className="text-[0.75rem] text-fg/40">
          +{data.suppressedCount} more below the cap were suppressed.
        </div>
      ) : null}
    </div>
  );
}

function SuggestionCard({
  s,
  onAccept,
  busy,
}: {
  s: Suggestion;
  onAccept: (s: Suggestion) => void;
  busy: boolean;
}) {
  const blockLabel = s.block
    ? s.tier === 'Update'
      ? `Updates the ${s.block} block`
      : `Would replace the ${s.block} block`
    : null;

  return (
    <div className="rounded-xl border border-overlay/10 bg-overlay/[0.04] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-[0.98rem] font-semibold leading-snug text-fg">
            {s.headline}
          </div>
          <div className="mt-1 text-[0.85rem] leading-relaxed text-fg/70">{s.whyItQualifies}</div>
        </div>
        {s.flaggedUnconfirmed ? (
          <span className="shrink-0 rounded-md bg-amber-400/15 px-2 py-0.5 text-[0.7rem] font-medium text-amber-200">
            Unconfirmed · single source
          </span>
        ) : (
          <span className="shrink-0 rounded-md bg-emerald-400/15 px-2 py-0.5 text-[0.7rem] font-medium text-emerald-200">
            {s.confidence === 'confirmed' ? 'Confirmed' : 'Provisional'}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem]">
        {blockLabel ? <span className="text-fg/50">{blockLabel}</span> : null}
        {s.sources.map((src, i) => (
          <a
            key={i}
            href={src.url}
            target="_blank"
            rel="noopener noreferrer"
            className="max-w-[240px] truncate text-cyan-400 underline transition hover:text-cyan-300"
          >
            {src.handle ?? src.title}
          </a>
        ))}
      </div>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => onAccept(s)}
          disabled={busy}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[0.8rem] font-medium',
            'bg-overlay/10 text-fg/80 transition hover:bg-overlay/20 hover:text-fg',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          Accept
        </button>
      </div>
    </div>
  );
}

function NewsMarkdown({
  text,
  onSourceClick,
  sources,
}: {
  text: string;
  onSourceClick: (source: NewsSource) => void;
  sources: NewsSource[];
}) {
  // Process the text to identify blocks, speakers, flags, and footnotes
  const lines = text.split('\n');
  const sections: React.ReactNode[] = [];
  let currentSection: string[] = [];
  let currentBlockType: string | null = null;

  const blockColors: Record<string, { bg: string; border: string; text: string }> = {
    'A BLOCK': { bg: 'bg-blue-500/10', border: 'border-l-4 border-blue-400', text: 'text-blue-200' },
    'B BLOCK': { bg: 'bg-emerald-500/10', border: 'border-l-4 border-emerald-400', text: 'text-emerald-200' },
    'C BLOCK': { bg: 'bg-amber-500/10', border: 'border-l-4 border-amber-400', text: 'text-amber-200' },
  };

  const flushCurrentSection = () => {
    if (currentSection.length > 0) {
      const content = currentSection.join('\n').trim();
      if (currentBlockType && blockColors[currentBlockType]) {
        const colors = blockColors[currentBlockType];
        sections.push(
          <div
            key={sections.length}
            className={cn('rounded-lg p-4 my-4', colors.bg, colors.border)}
          >
            <div className={cn('font-bold text-sm mb-3', colors.text)}>{currentBlockType}</div>
            <NewsScriptContent content={content} onSourceClick={onSourceClick} sources={sources} />
          </div>,
        );
      } else {
        sections.push(
          <div key={sections.length}>
            <NewsScriptContent content={content} onSourceClick={onSourceClick} sources={sources} />
          </div>,
        );
      }
      currentSection = [];
      currentBlockType = null;
    }
  };

  for (const line of lines) {
    if (line.includes('[A BLOCK]') || line.includes('[B BLOCK]') || line.includes('[C BLOCK]')) {
      flushCurrentSection();
      // Extract block type
      const match = line.match(/\[(A|B|C) BLOCK\]/);
      if (match) {
        currentBlockType = `${match[1]} BLOCK`;
      }
    } else {
      currentSection.push(line);
    }
  }
  flushCurrentSection();

  return <div className="space-y-4">{sections}</div>;
}

function NewsScriptContent({
  content,
  onSourceClick,
  sources,
}: {
  content: string;
  onSourceClick: (source: NewsSource) => void;
  sources: NewsSource[];
}) {
  const parts: React.ReactNode[] = [];
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // SPEAKER: line
    if (/^[A-Z_0-9]+:$/.test(line)) {
      const speaker = line.slice(0, -1);
      const quoteLines: string[] = [];
      i++;
      // Collect all following non-empty lines until a blank line or another SPEAKER line
      while (i < lines.length && lines[i].trim() && !/^[A-Z_0-9]+:$/.test(lines[i])) {
        quoteLines.push(lines[i].trim());
        i++;
      }
      parts.push(
        <div key={parts.length} className="my-3 ml-4 border-l-2 border-overlay/20 pl-4 italic text-fg/80">
          <div className="font-semibold text-fg/90">{speaker}</div>
          <div>{quoteLines.join(' ')}</div>
        </div>,
      );
      continue;
    }

    // FLAG: line
    if (line.includes('[FLAG:')) {
      const flagMatch = line.match(/\[FLAG: (.+?)\]/);
      if (flagMatch) {
        const flagText = flagMatch[1];
        const beforeFlag = line.slice(0, line.indexOf('[FLAG:'));
        const afterFlag = line.slice(line.indexOf('[FLAG:') + flagMatch[0].length);
        parts.push(
          <div key={parts.length} className="my-2">
            <span>{beforeFlag}</span>
            <span className="inline-block ml-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[0.75rem] text-red-200">
              ⚠ {flagText}
            </span>
            <span>{afterFlag}</span>
          </div>,
        );
        i++;
        continue;
      }
    }

    // Regular text with potential footnotes and markdown
    if (line.length > 0) {
      parts.push(
        <div key={parts.length}>
          <MarkdownRenderer
            text={line}
            components={{
              p: ({ children }) => <p className="my-2">{renderFootnotes(children, onSourceClick, sources)}</p>,
              h1: ({ children }) => <h1 className="text-xl font-bold my-3 mt-4">{renderFootnotes(children, onSourceClick, sources)}</h1>,
              h2: ({ children }) => <h2 className="text-lg font-bold my-3 mt-4">{renderFootnotes(children, onSourceClick, sources)}</h2>,
              h3: ({ children }) => <h3 className="text-base font-bold my-2 mt-3">{renderFootnotes(children, onSourceClick, sources)}</h3>,
              h4: ({ children }) => <h4 className="text-sm font-bold my-2 mt-2 uppercase">{renderFootnotes(children, onSourceClick, sources)}</h4>,
              strong: ({ children }) => <strong className="font-semibold">{renderFootnotes(children, onSourceClick, sources)}</strong>,
              em: ({ children }) => <em className="italic">{renderFootnotes(children, onSourceClick, sources)}</em>,
              blockquote: ({ children }) => (
                <blockquote className="border-l-4 border-overlay/30 pl-4 my-3 italic text-fg/80">{renderFootnotes(children, onSourceClick, sources)}</blockquote>
              ),
              ul: ({ children }) => <ul className="list-disc list-inside my-2">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal list-inside my-2">{children}</ol>,
              li: ({ children }) => <li className="my-1">{renderFootnotes(children, onSourceClick, sources)}</li>,
              hr: () => <hr className="my-4 border-overlay/20" />,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 underline">
                  {children}
                </a>
              ),
            }}
          />
        </div>,
      );
    }

    i++;
  }

  return <div>{parts}</div>;
}

function renderFootnotes(
  children: React.ReactNode,
  onSourceClick: (source: NewsSource) => void,
  sources: NewsSource[]
): React.ReactNode {
  // Handle string children with superscript footnotes
  if (typeof children === 'string') {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const superscriptRegex = /([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g;
    let match;

    while ((match = superscriptRegex.exec(children)) !== null) {
      // Add text before superscript
      if (match.index > lastIndex) {
        parts.push(children.slice(lastIndex, match.index));
      }
      // Convert superscript to number
      const superscriptMap: Record<string, string> = {
        '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
        '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
      };
      let numberStr = '';
      for (const char of match[0]) {
        numberStr += superscriptMap[char] || '';
      }
      const sourceNum = parseInt(numberStr);
      const source = sources.find((s) => s.number === sourceNum);

      // Add styled superscript
      parts.push(
        <button
          key={parts.length}
          onClick={() => source && onSourceClick(source)}
          disabled={!source}
          className="inline-flex items-center ml-0.5 bg-transparent border-none padding-0"
        >
          <sup className={cn(
            'text-cyan-300 font-semibold',
            source ? 'cursor-pointer hover:text-cyan-100' : 'opacity-60 cursor-default'
          )}>
            {match[0]}
          </sup>
        </button>,
      );
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < children.length) {
      parts.push(children.slice(lastIndex));
    }

    return parts.length > 0 ? parts : children;
  }

  // For non-string children (arrays, elements), just return as is
  return children;
}

