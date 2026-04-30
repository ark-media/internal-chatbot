'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  HardDriveUpload,
  Loader2,
  Paperclip,
  Search,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

import { Header } from '@/components/Header';
import { ModelSelector, MODELS } from '@/components/ModelSelector';
import { EmptyState } from '@/components/EmptyState';
import { ArkLogo } from '@/components/ArkLogo';
import type {
  PastGuestAppearancesToolOutput,
  PrepUIMessage,
  SearchCorpusToolOutput,
  WebSearchToolOutput,
} from '@/components/prep-types';
import { cn } from '@/lib/cn';
import { notifyChatUpdated } from '@/lib/chat-refresh';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatBytes,
} from '@/lib/prep-limits';

const EXAMPLE_PROMPTS = [
  'Call me Back — "Can Israel Afford Another War?" — with Amos Yadlin',
  'For Heaven\'s Sake — "The Future of American Jewry" — with Bari Weiss',
  'Call me Back — "Iran after the strikes" — with Ray Takeyh',
];

type AttachedFile = {
  id: string;
  file: File;
};

export default function PrepPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  const [initialMessages, setInitialMessages] = useState<PrepUIMessage[] | null>(null);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    fetch(`/api/chats/${chatId}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages?: PrepUIMessage[] }) => {
        if (!cancelled) setInitialMessages((d.messages ?? []) as PrepUIMessage[]);
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
  return <PrepBody chatId={chatId} initialMessages={initialMessages} />;
}

function PrepBody({
  chatId,
  initialMessages,
}: {
  chatId: string;
  initialMessages: PrepUIMessage[];
}) {
  const [selectedModel, setSelectedModel] = useState(MODELS[1].id);

  const { messages, sendMessage, status, stop } = useChat<PrepUIMessage>({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/prep',
      headers: {
        'x-model': selectedModel,
      },
      body: { chatId },
    }),
    onFinish: () => {
      notifyChatUpdated();
    },
  });

  const [input, setInput] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveLink, setDriveLink] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveSaveInProgress, setDriveSaveInProgress] = useState(false);
  const [driveMatchedShow, setDriveMatchedShow] = useState<string | null>(null);
  const [driveFallback, setDriveFallback] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    el.style.height = '40px';
  }, [input]);

  const onPickFiles = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const picked = e.target.files;
      e.target.value = '';
      if (!picked) return;
      const accepted: AttachedFile[] = [];
      const rejected: string[] = [];
      let total = files.reduce((n, f) => n + f.file.size, 0);
      for (let i = 0; i < picked.length; i++) {
        const f = picked.item(i);
        if (!f) continue;
        if (files.length + accepted.length >= MAX_FILES) {
          rejected.push(`too many files (max ${MAX_FILES})`);
          break;
        }
        if (f.size > MAX_FILE_BYTES) {
          rejected.push(`"${f.name}" is ${formatBytes(f.size)}, exceeds ${formatBytes(MAX_FILE_BYTES)}`);
          continue;
        }
        if (total + f.size > MAX_TOTAL_BYTES) {
          rejected.push(`"${f.name}" would exceed ${formatBytes(MAX_TOTAL_BYTES)} total`);
          continue;
        }
        total += f.size;
        accepted.push({
          id: `${f.name}-${f.size}-${f.lastModified}-${Date.now()}-${i}`,
          file: f,
        });
      }
      if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
      setUploadError(rejected.length > 0 ? rejected.join('; ') : null);
    },
    [files],
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setUploadError(null);
  }, []);

  const submit = (text: string) => {
    const q = text.trim();
    if ((!q && files.length === 0) || busy) return;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f.file);
    const fileList = dt.files.length > 0 ? dt.files : undefined;
    sendMessage({ text: q, files: fileList });
    setInput('');
    setFiles([]);
    // Reset post-generation actions when starting a new turn.
    setDriveLink(null);
    setDriveError(null);
    setDriveMatchedShow(null);
    setDriveFallback(false);
    setCopySuccess(false);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(input);
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

  const copyQuestionsToClipboard = useCallback(async () => {
    const text = extractQuestionsText();
    if (!text?.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      alert('Failed to copy to clipboard');
    }
  }, [extractQuestionsText]);

  const saveQuestionsToDrive = useCallback(async () => {
    if (driveSaveInProgress) return;

    const questionsText = extractQuestionsText();
    if (!questionsText?.trim()) return;

    const prompt = extractFirstUserPrompt() || '';
    const { show, title } = parsePromptShow(prompt);

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
  }, [driveSaveInProgress, extractQuestionsText, extractFirstUserPrompt]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header variant="prep" />

        {/* ---------- Message list ---------- */}
        <main ref={scrollRef} className="relative flex-1 overflow-y-auto">
          <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-7 px-6 py-10', messages.length === 0 && 'min-h-full')}>
            {messages.length === 0 && (
              <EmptyState
                title="Prep the"
                highlight="next episode"
                description={
                  <>
                    Give an episode title + guest. Get 6–7 questions tagged{' '}
                    <span className="rounded border border-white/15 bg-white/[0.06] px-1 py-0.5 text-[0.72rem] text-white/70">
                      open
                    </span>{' '}
                    /{' '}
                    <span className="rounded border border-[#3eb5f9]/30 bg-[#3eb5f9]/[0.12] px-1 py-0.5 text-[0.72rem] text-[#79cdfc]">
                      therefore
                    </span>{' '}
                    /{' '}
                    <span className="rounded border border-amber-300/30 bg-amber-400/[0.12] px-1 py-0.5 text-[0.72rem] text-amber-200">
                      but
                    </span>{' '}
                    — each building or pivoting on the last.
                  </>
                }
                prompts={EXAMPLE_PROMPTS}
                onPick={submit}
                busy={busy}
                promptLayout="grid"
                footerNote="Attach prep notes, draft outlines, or past transcripts via the clip icon."
              />
            )}

            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}

            {busy ? (
              <div className="flex items-center gap-3 pl-12 text-xs text-white/50">
                <TypingDots />
                <span className="tracking-wide">
                  {status === 'submitted' ? 'Researching…' : 'Writing questions…'}
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
            ) : null}

            {!busy && messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' ? (
              <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4">
                {driveLink ? (
                  <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-4 py-3 text-sm text-green-200">
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
                      className="ml-auto inline-flex items-center gap-1 rounded px-2 py-0.5 text-green-300 transition hover:bg-white/10"
                    >
                      Open
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : driveError ? (
                  <div className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {driveError}
                  </div>
                ) : (
                  <button
                    onClick={saveQuestionsToDrive}
                    disabled={driveLoading || driveSaveInProgress}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
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

                <button
                  onClick={copyQuestionsToClipboard}
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
                      Copy to Clipboard
                    </>
                  )}
                </button>
              </div>
            ) : null}
          </div>
        </main>

        {/* ---------- Composer ---------- */}
        <form
          onSubmit={onSubmit}
          className="relative z-10 border-t border-white/[0.06] bg-gradient-to-b from-transparent to-[#070b22]/60 px-6 py-4 backdrop-blur-md"
        >
          <div className="mx-auto max-w-3xl">
            {files.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {files.map((f) => (
                  <div
                    key={f.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[0.72rem] text-white/75"
                  >
                    <FileText className="h-3 w-3 text-[#3eb5f9]" />
                    <span className="max-w-[240px] truncate">{f.file.name}</span>
                    <span className="text-white/35">{formatBytes(f.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(f.id)}
                      className="ml-0.5 rounded p-0.5 text-white/45 transition hover:bg-white/10 hover:text-white"
                      aria-label={`Remove ${f.file.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {uploadError && (
              <div
                role="alert"
                className="mb-2 rounded-lg border border-amber-300/30 bg-amber-400/[0.08] px-3 py-2 text-[0.78rem] text-amber-100"
              >
                Some files were not attached — {uploadError}.
              </div>
            )}
            <div
              className={cn(
                'group flex items-center gap-2 rounded-2xl border bg-white/[0.04] px-3 py-2.5 backdrop-blur',
                'border-white/10 shadow-[0_12px_40px_-16px_rgba(3,62,200,0.45)]',
                'transition focus-within:border-[#3eb5f9]/60',
                'focus-within:shadow-[0_12px_40px_-14px_rgba(62,181,249,0.55)]',
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.md,.txt,.csv,.tsv,.json,.yml,.yaml,.png,.jpg,.jpeg,.gif,.webp,application/pdf,text/markdown,text/plain,text/csv,application/json,image/*"
                onChange={onPickFiles}
                className="hidden"
              />
              <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />
              <div className="flex-1 min-w-0 flex items-center">
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
                placeholder="Episode title + guest"
                disabled={busy}
                className={cn(
                  'h-[40px] w-full resize-none bg-transparent px-3 py-1.5',
                  'text-[0.95rem] leading-relaxed text-white placeholder:text-white/35',
                  'outline-none disabled:opacity-60 overflow-hidden',
                )}
              />
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className={cn(
                  'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                  'text-white/60 transition hover:bg-white/[0.06] hover:text-white',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
                aria-label="Attach files"
                title="Attach prep notes, transcripts, or outlines"
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <button
                type="submit"
                aria-label="Send"
                disabled={busy || (!input.trim() && files.length === 0)}
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
              Enter to send · Shift + Enter for newline · Up to {MAX_FILES} files, {formatBytes(MAX_FILE_BYTES)} each
            </div>
          </div>
        </form>
    </div>
  );
}

/* ============================================================
   Sub-components
   ============================================================ */

function MessageRow({ message }: { message: PrepUIMessage }) {
  if (message.role === 'user') {
    const textParts = message.parts.filter((p) => p.type === 'text');
    const fileParts = message.parts.filter((p) => p.type === 'file');
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
          {textParts.map((p, i) =>
            p.type === 'text' ? (
              <span key={i} className="whitespace-pre-wrap">
                {p.text}
              </span>
            ) : null,
          )}
          {fileParts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fileParts.map((p, i) => {
                if (p.type !== 'file') return null;
                return (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-md bg-[#070b22]/20 px-1.5 py-0.5 text-[0.72rem] text-[#070b22]/85"
                  >
                    <FileText className="h-3 w-3" />
                    {p.filename ?? p.mediaType}
                  </span>
                );
              })}
            </div>
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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="!mt-0 !mb-4 !text-[1.05rem] !font-bold !uppercase !tracking-[0.18em] !text-white/50">
              {children}
            </h1>
          ),
          h2: ({ children }) => {
            const raw = String(children);
            const tag = raw.match(/\[(open|therefore|but)\]/i)?.[1]?.toLowerCase();
            return (
              <h2 className="!mt-6 !mb-2 !text-[1.02rem] !font-bold !text-white/95 !normal-case !tracking-normal">
                {tag ? <QuestionHeading tag={tag as 'open' | 'therefore' | 'but'} raw={raw} /> : children}
              </h2>
            );
          },
          em: ({ children }) => (
            <em className="text-[0.85rem] text-white/55">{children}</em>
          ),
          strong: ({ children }) => (
            <strong className="text-white">{children}</strong>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
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
        ? 'bg-[#3eb5f9]/[0.12] text-[#79cdfc] border-[#3eb5f9]/30'
        : 'bg-white/[0.06] text-white/70 border-white/15';
  return (
    <span className="inline-flex items-baseline gap-2">
      {num && (
        <span className="font-mono text-[0.78rem] text-white/40">Q{num}</span>
      )}
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

function ToolChip({
  icon: Icon,
  label,
  pulsing,
}: {
  icon: typeof Sparkles;
  label: string;
  pulsing?: boolean;
}) {
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

