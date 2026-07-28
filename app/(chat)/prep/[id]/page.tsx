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
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  Globe,
  HardDriveUpload,
  Loader2,
  Search,
} from 'lucide-react';

import { Header } from '@/components/Header';
import { DEFAULT_MODEL_ID } from '@/components/ModelSelector';
import { ShowSelector } from '@/components/ShowSelector';
import { ChatComposer } from '@/components/ChatComposer';
import { ChatErrorBanner } from '@/components/ChatErrorBanner';
import { EmptyState } from '@/components/EmptyState';
import { ArkLogo } from '@/components/ArkLogo';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import type {
  PastGuestAppearancesToolOutput,
  PrepUIMessage,
  SearchCorpusToolOutput,
  WebSearchToolOutput,
} from '@/components/prep-types';
import { ToolChip } from '@/components/ui/ToolChip';
import { BusyRow } from '@/components/ui/BusyRow';
import { UserBubble } from '@/components/ui/UserBubble';
import { EditingBanner } from '@/components/ui/EditingBanner';
import { CopyButton } from '@/components/ui/CopyButton';
import { HandoffButton } from '@/components/ui/HandoffButton';
import { FileAttachments } from '@/components/ui/FileAttachments';
import { cn } from '@/lib/cn';
import { notifyChatUpdated } from '@/lib/chat-refresh';
import { useFlash } from '@/lib/use-flash';
import { useInitialMessages } from '@/lib/use-initial-messages';
import { useMessageEditing } from '@/lib/use-message-editing';
import { useFileAttachments } from '@/lib/use-file-attachments';
import { useHandoffSummary } from '@/lib/use-handoff-summary';
import {
  PREP_DEFAULT_TEMPERATURE_PRESET,
  type TemperaturePresetId,
} from '@/lib/temperature';
import { MAX_FILES, MAX_FILE_BYTES, formatBytes } from '@/lib/prep-limits';
import {
  DEFAULT_PREP_SHOW_ID,
  getPrepShow,
  type PrepShowId,
} from '@/lib/prep-shows';

export default function PrepPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  const initialMessages = useInitialMessages<PrepUIMessage>(chatId);

  if (!chatId || initialMessages === null) {
    return null;
  }
  return <PrepBody chatId={chatId} initialMessages={initialMessages} />;
}

function PrepBody({
  chatId,
  initialMessages,
}: {
  chatId: string;
  initialMessages: PrepUIMessage[];
}) {
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [selectedTemperature, setSelectedTemperature] =
    useState<TemperaturePresetId>(PREP_DEFAULT_TEMPERATURE_PRESET);
  const [selectedShow, setSelectedShow] =
    useState<PrepShowId>(DEFAULT_PREP_SHOW_ID);
  const currentShow = getPrepShow(selectedShow);
  const [input, setInput] = useState('');
  const { files, uploadError, onPickFiles, removeFile, clearFiles, asFileList } =
    useFileAttachments();
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveLink, setDriveLink] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveSaveInProgress, setDriveSaveInProgress] = useState(false);
  const [driveMatchedShow, setDriveMatchedShow] = useState<string | null>(null);
  const [driveFallback, setDriveFallback] = useState(false);
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
        api: '/api/prep',
        fetch: editingFetch,
        headers: {
          'x-model': selectedModel,
          'x-temperature': selectedTemperature,
          'x-show': selectedShow,
        },
        body: { chatId },
      }),
    [editingFetch, selectedModel, selectedTemperature, selectedShow, chatId],
  );

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat<PrepUIMessage>({
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
    // Send the live selections per-message. useChat captures the transport at
    // creation, so a header set only on the memoized transport can be stale on
    // the first turn (e.g. switching show before the first send). Per-request
    // headers always reflect the current selection and override the transport.
    sendMessage(
      { text: q, files: asFileList() },
      {
        headers: {
          'x-model': selectedModel,
          'x-temperature': selectedTemperature,
          'x-show': selectedShow,
        },
      },
    );
    setInput('');
    clearFiles();
    if (wasEditing) {
      flashShowUndoToast(true, 3000);
    }
    // Reset post-generation actions when starting a new turn.
    setDriveLink(null);
    setDriveError(null);
    setDriveMatchedShow(null);
    setDriveFallback(false);
    resetCopySuccess();
  };

  const extractQuestionsText = useCallback(() => {
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistantMsg) return null;
    const textParts = lastAssistantMsg.parts?.filter((p) => p.type === 'text') ?? [];
    if (textParts.length === 0) return null;
    return textParts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }, [messages]);

  const extractFirstUserPrompt = useCallback(() => {
    const firstUserMsg = messages.find((m) => m.role === 'user');
    if (!firstUserMsg) return null;
    const textParts = firstUserMsg.parts?.filter((p) => p.type === 'text') ?? [];
    if (textParts.length === 0) return null;
    return textParts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join(' ')
      .trim();
  }, [messages]);

  const { openSummary, modal: summaryModal } = useHandoffSummary({
    chatId,
    messagesLength: messages.length,
  });

  const copyQuestionsToClipboard = useCallback(async () => {
    const text = extractQuestionsText();
    if (!text?.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      flashCopySuccess(true, 2000);
    } catch {
      alert('Failed to copy to clipboard');
    }
  }, [extractQuestionsText, flashCopySuccess]);

  const saveQuestionsToDrive = useCallback(async () => {
    if (driveSaveInProgress) return;

    const questionsText = extractQuestionsText();
    if (!questionsText?.trim()) return;

    const prompt = extractFirstUserPrompt() || '';
    const parsed = parsePromptShow(prompt);
    // An explicit show selection wins; fall back to parsing the prompt prefix
    // for the generic surface (which has no canonical name).
    const show = currentShow.canonical ?? parsed.show;
    const title = parsed.title;

    setDriveSaveInProgress(true);
    setDriveLoading(true);
    setDriveError(null);
    setDriveLink(null);
    setDriveMatchedShow(null);
    setDriveFallback(false);

    try {
      const today = new Date().toISOString().split('T')[0];
      const res = await fetch('/api/prep/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionsText,
          show,
          title: title || prompt || 'Episode prep',
          date: today,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDriveError(data.error || 'Upload failed');
        return;
      }
      setDriveLink(data.driveUrl);
      setDriveMatchedShow(data.matchedShow ?? null);
      setDriveFallback(Boolean(data.fallback));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDriveError(`Failed to upload: ${msg}`);
    } finally {
      setDriveLoading(false);
      setDriveSaveInProgress(false);
    }
  }, [driveSaveInProgress, extractQuestionsText, extractFirstUserPrompt, currentShow]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header variant="prep" />

        {/* ---------- Message list ---------- */}
        <main ref={scrollRef} className="relative flex-1 overflow-y-auto">
          <div className={cn('flex w-full flex-col gap-7 px-5 py-10', messages.length === 0 && 'min-h-full')}>
            {messages.length === 0 ? (
              <EmptyState
                title="Prep the"
                highlight="next episode"
                description={
                  selectedShow === 'whats-your-number' ? (
                    <>
                      Name the guest, their role, and the economic angle. Get an{' '}
                      <span className="font-medium text-fg/80">intro script</span>, a{' '}
                      <span className="font-medium text-fg/80">focused interview</span>{' '}
                      tagged{' '}
                      <span className="rounded border border-overlay/15 bg-overlay/[0.06] px-1 py-0.5 text-[0.72rem] text-fg/70">
                        open
                      </span>{' '}
                      /{' '}
                      <span className="rounded border border-sky-brand/30 bg-sky-brand/[0.12] px-1 py-0.5 text-[0.72rem] text-sky-brand-soft">
                        therefore
                      </span>{' '}
                      /{' '}
                      <span className="rounded border border-amber-300/30 bg-amber-400/[0.12] px-1 py-0.5 text-[0.72rem] text-amber-200">
                        but
                      </span>
                      , and a tailored{' '}
                      <span className="font-medium text-fg/80">rapid-fire</span> round.
                    </>
                  ) : (
                    <>
                      Give an episode title + guest. Get 6–7 questions tagged{' '}
                      <span className="rounded border border-overlay/15 bg-overlay/[0.06] px-1 py-0.5 text-[0.72rem] text-fg/70">
                        open
                      </span>{' '}
                      /{' '}
                      <span className="rounded border border-sky-brand/30 bg-sky-brand/[0.12] px-1 py-0.5 text-[0.72rem] text-sky-brand-soft">
                        therefore
                      </span>{' '}
                      /{' '}
                      <span className="rounded border border-amber-300/30 bg-amber-400/[0.12] px-1 py-0.5 text-[0.72rem] text-amber-200">
                        but
                      </span>{' '}
                      — each building or pivoting on the last.
                    </>
                  )
                }
                prompts={currentShow.examplePrompts}
                onPick={submit}
                busy={busy}
                promptLayout="grid"
                footerNote="Attach prep notes, draft outlines, or past transcripts via the clip icon."
              />
            ) : null}

            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                onEdit={startEditing}
                isEditing={editingMessageId === m.id}
              />
            ))}

            {busy ? (
              <BusyRow
                label={status === 'submitted' ? 'Researching…' : 'Writing questions…'}
                onStop={stop}
              />
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

            {!busy && messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-overlay/10 pt-4">
                {driveLink ? (
                  <div className="inline-flex items-center gap-2 rounded-lg bg-green-500/10 px-4 py-2.5 text-sm text-green-200">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      Saved to Drive
                      {driveMatchedShow ? (
                        <span className="text-green-200/70"> · {driveMatchedShow} folder</span>
                      ) : driveFallback ? (
                        <span className="text-green-200/70"> · default Prep folder</span>
                      ) : null}
                    </span>
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
                    onClick={saveQuestionsToDrive}
                    disabled={driveLoading || driveSaveInProgress}
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
                  onClick={copyQuestionsToClipboard}
                  copied={copySuccess}
                  label="Copy to Clipboard"
                />

                <HandoffButton
                  onClick={openSummary}
                  title="Compose a handoff message you can paste into a fresh chat to continue this prep"
                />
              </div>
            ) : null}
          </div>
        </main>

        {/* ---------- Edit Mode Indicator ---------- */}
        <EditingBanner editing={editingMessageId !== null} onCancel={cancelEditing} />

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
          placeholder={currentShow.placeholder}
          leadingControls={
            <ShowSelector
              selectedShow={selectedShow}
              onShowChange={setSelectedShow}
            />
          }
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
            tooltip: 'Attach prep notes, transcripts, or outlines',
          }}
          attachments={
            <FileAttachments
              files={files}
              uploadError={uploadError}
              onRemove={removeFile}
            />
          }
        />

        {summaryModal}
    </div>
  );
}

/* ============================================================
   Sub-components
   ============================================================ */

function MessageRow({
  message,
  onEdit,
  isEditing,
}: {
  message: PrepUIMessage;
  onEdit?: (message: PrepUIMessage) => void;
  isEditing?: boolean;
}) {
  if (message.role === 'user') {
    const textParts = message.parts.filter((p) => p.type === 'text');
    const fileParts = message.parts.filter((p) => p.type === 'file');
    return (
      <UserBubble
        textParts={textParts.flatMap((p) => (p.type === 'text' ? [p.text] : []))}
        isEditing={isEditing}
        onEdit={onEdit ? () => onEdit(message) : undefined}
        files={
          fileParts.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fileParts.map((p, i) => {
                if (p.type !== 'file') return null;
                return (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-md bg-ink-950/20 px-1.5 py-0.5 text-[0.72rem] text-ink-950/85"
                  >
                    <FileText className="h-3 w-3" />
                    {p.filename ?? p.mediaType}
                  </span>
                );
              })}
            </div>
          ) : null
        }
      />
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

      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return <PrepMarkdown key={i} text={part.text} />;
          }
          if (part.type === 'tool-searchCorpus') {
            if (
              part.state === 'input-streaming' ||
              part.state === 'input-available'
            ) {
              return <ToolChip key={i} icon={Search} label="Searching Ark archive…" pulsing />;
            }
            if (part.state === 'output-available') {
              const out = part.output as SearchCorpusToolOutput;
              const n = out.chunks?.length ?? 0;
              const label = out.resolvedGuest
                ? `Archive: ${n} passage${n === 1 ? '' : 's'} mentioning ${out.resolvedGuest}`
                : `Archive: ${n} relevant passage${n === 1 ? '' : 's'}`;
              return <ToolChip key={i} icon={Search} label={label} />;
            }
          }
          if (part.type === 'tool-pastGuestAppearances') {
            if (
              part.state === 'input-streaming' ||
              part.state === 'input-available'
            ) {
              return <ToolChip key={i} icon={FileText} label="Looking up past appearances…" pulsing />;
            }
            if (part.state === 'output-available') {
              const out = part.output as PastGuestAppearancesToolOutput;
              if (!out.found) {
                return <ToolChip key={i} icon={FileText} label="First-time guest on Ark shows" />;
              }
              return (
                <ToolChip
                  key={i}
                  icon={FileText}
                  label={`${out.speakerName}: ${out.episodeCount} prior episode${out.episodeCount === 1 ? '' : 's'} · ${out.totalTurns} turns`}
                />
              );
            }
          }
          if (part.type === 'tool-webSearch') {
            if (
              part.state === 'input-streaming' ||
              part.state === 'input-available'
            ) {
              return <ToolChip key={i} icon={Globe} label="Searching the web…" pulsing />;
            }
            if (part.state === 'output-available') {
              const out = part.output as WebSearchToolOutput;
              const n = out.results?.length ?? 0;
              const label =
                n === 0 && out.note
                  ? 'Web search skipped'
                  : `Web: ${n} recent result${n === 1 ? '' : 's'}`;
              return <ToolChip key={i} icon={Globe} label={label} />;
            }
          }
          return null;
        })}
      </div>
    </div>
  );
}

function PrepMarkdown({ text }: { text: string }) {
  return (
    <div className="ark-prose">
      <MarkdownRenderer
        text={text}
        components={{
          h1: ({ children }) => (
            <h1 className="!mt-0 !mb-4 !text-[1.05rem] !font-bold !uppercase !tracking-[0.18em] !text-fg/50">
              {children}
            </h1>
          ),
          h2: ({ children }) => {
            const raw = String(children);
            const tag = raw.match(/\[(open|therefore|but)\]/i)?.[1]?.toLowerCase();
            return (
              <h2 className="!mt-6 !mb-2 !text-[1.02rem] !font-bold !text-fg/95 !normal-case !tracking-normal">
                {tag ? <QuestionHeading tag={tag as 'open' | 'therefore' | 'but'} raw={raw} /> : children}
              </h2>
            );
          },
          em: ({ children }) => (
            <em className="text-[0.85rem] text-fg/55">{children}</em>
          ),
          strong: ({ children }) => (
            <strong className="text-fg">{children}</strong>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      />
    </div>
  );
}

function QuestionHeading({
  tag,
  raw,
}: {
  tag: 'open' | 'therefore' | 'but';
  raw: string;
}) {
  // Strip the leading "N. [tag]" from the heading text; leave only the question number.
  const numberMatch = raw.match(/^\s*(\d+)\.\s*\[/);
  const num = numberMatch?.[1];
  const color =
    tag === 'but'
      ? 'bg-amber-400/[0.12] text-amber-200 border-amber-300/30'
      : tag === 'therefore'
        ? 'bg-sky-brand/[0.12] text-sky-brand-soft border-sky-brand/30'
        : 'bg-overlay/[0.06] text-fg/70 border-overlay/15';
  return (
    <span className="inline-flex items-baseline gap-2">
      {num ? (
        <span className="font-mono text-[0.78rem] text-fg/40">Q{num}</span>
      ) : null}
      <span
        className={cn(
          'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em]',
          color,
        )}
      >
        {tag}
      </span>
    </span>
  );
}

// Splits "Call me Back — 'Iran after the strikes' — with Ray Takeyh" into
// { show: "Call me Back", title: "'Iran after the strikes' — with Ray Takeyh" }.
// Tolerates em-dash, en-dash, and hyphen-with-spaces as separators.
function parsePromptShow(prompt: string): { show: string | null; title: string } {
  const trimmed = prompt.trim();
  if (!trimmed) return { show: null, title: '' };
  const parts = trimmed.split(/\s+[—–-]\s+/);
  if (parts.length < 2) return { show: null, title: trimmed };
  return {
    show: parts[0].trim() || null,
    title: parts.slice(1).join(' — ').trim(),
  };
}

