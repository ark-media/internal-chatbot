'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  FileText,
  Loader2,
  Square,
  X,
  HardDriveUpload,
  ExternalLink,
  CheckCircle2,
  Copy,
} from 'lucide-react';

import { Header } from '@/components/Header';
import { MODELS } from '@/components/ModelSelector';
import { ChatComposer } from '@/components/ChatComposer';
import { ChatErrorBanner } from '@/components/ChatErrorBanner';
import { EmptyState } from '@/components/EmptyState';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import type { NewsUIMessage, NewsSource } from '@/components/news-types';
import { cn } from '@/lib/cn';
import { chatFetch } from '@/lib/chat-fetch';
import { notifyChatUpdated } from '@/lib/chat-refresh';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatBytes,
} from '@/lib/prep-limits';

const AMBER_500 = '#f59e0b';

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

type AttachedFile = {
  id: string;
  file: File;
};

export default function NewsPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  const [initialMessages, setInitialMessages] = useState<NewsUIMessage[] | null>(null);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    fetch(`/api/chats/${chatId}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages?: NewsUIMessage[] }) => {
        if (!cancelled) setInitialMessages((d.messages ?? []) as NewsUIMessage[]);
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
  return <NewsBody chatId={chatId} initialMessages={initialMessages} />;
}

function NewsBody({
  chatId,
  initialMessages,
}: {
  chatId: string;
  initialMessages: NewsUIMessage[];
}) {
  const [selectedModel, setSelectedModel] = useState(MODELS[1].id);

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat<NewsUIMessage>({
      id: chatId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: '/api/news',
        fetch: chatFetch,
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
  const [fileAttachSuccess, setFileAttachSuccess] = useState(false);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveLink, setDriveLink] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveSaveInProgress, setDriveSaveInProgress] = useState(false);
  const [openSource, setOpenSource] = useState<NewsSource | null>(null);
  const [allSources, setAllSources] = useState<NewsSource[]>([]);
  const [copySuccess, setCopySuccess] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, busy]);

  const onPickFiles = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      // Convert FileList to array BEFORE clearing the input (FileList is a live collection)
      const picked = e.target.files ? Array.from(e.target.files) : [];
      e.target.value = '';
      if (picked.length === 0) return;

      const accepted: AttachedFile[] = [];
      const rejected: string[] = [];
      let total = files.reduce((n, f) => n + f.file.size, 0);
      for (let i = 0; i < picked.length; i++) {
        const f = picked[i];
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
      if (accepted.length > 0) {
        setFiles((prev) => [...prev, ...accepted]);
        setFileAttachSuccess(true);
        setTimeout(() => setFileAttachSuccess(false), 2500);
      }
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
  };

  const extractScriptText = useCallback(() => {
    const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistantMsg) return null;
    const textParts = lastAssistantMsg.parts?.filter((p) => p.type === 'text') ?? [];
    if (textParts.length === 0) return null;
    return textParts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }, [messages]);

  useEffect(() => {
    const scriptText = extractScriptText();
    if (scriptText) {
      setAllSources(extractSources(scriptText));
    }
  }, [messages, extractScriptText]);

  const copyScriptToClipboard = useCallback(async () => {
    const scriptText = extractScriptText();
    if (!scriptText?.trim()) return;

    try {
      await navigator.clipboard.writeText(scriptText);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      // Fallback: show alert if clipboard API fails
      alert('Failed to copy to clipboard');
    }
  }, [extractScriptText]);

  const saveScriptToDrive = useCallback(async () => {
    // Debounce: prevent multiple simultaneous uploads
    if (driveSaveInProgress) return;

    const scriptText = extractScriptText();
    if (!scriptText?.trim()) return;

    setDriveSaveInProgress(true);
    setDriveLoading(true);
    setDriveError(null);
    setDriveLink(null);

    try {
      // Extract headline from script or use generic title
      const headline = extractHeadline(scriptText) || 'News Script';
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      const res = await fetch('/api/news/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scriptText,
          title: headline,
          date: today,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setDriveError(data.error || 'Upload failed');
        return;
      }

      setDriveLink(data.driveUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDriveError(`Failed to upload: ${msg}`);
    } finally {
      setDriveLoading(false);
      setDriveSaveInProgress(false);
    }
  }, [driveSaveInProgress, extractScriptText]);

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header variant="news" />

        {/* Message list */}
        <main ref={scrollRef} className="relative flex-1 overflow-y-auto">
          <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-7 px-6 py-10', messages.length === 0 && 'min-h-full')}>
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
              />
            ))}

            {busy ? (
              <div className="flex items-center gap-3 pl-12 text-xs text-white/50">
                <TypingDots />
                <span className="tracking-wide">
                  {status === 'submitted' ? 'Fetching articles…' : 'Generating script…'}
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

            <ChatErrorBanner
              error={error}
              onRetry={() => {
                clearError();
                regenerate();
              }}
              onDismiss={clearError}
            />

            {messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' ? (
              <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4">
                {driveLink ? (
                  <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-4 py-3 text-sm text-green-200">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Saved to Drive</span>
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
                    onClick={saveScriptToDrive}
                    disabled={driveLoading || driveSaveInProgress || !messages.length}
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
                  onClick={copyScriptToClipboard}
                  disabled={!messages.length}
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

                <div className="mt-2">
                  <div className="text-xs font-medium uppercase tracking-[0.2em] text-white/40 mb-2">
                    Refine the script
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {REFINEMENT_HINTS.map((hint, i) => (
                      <button
                        key={i}
                        onClick={() => submit(hint)}
                        disabled={busy}
                        className={cn(
                          'rounded-full border border-white/20 bg-white/[0.03] px-3 py-1 text-[0.75rem] text-white/70',
                          'transition hover:border-white/40 hover:bg-white/[0.06] hover:text-white',
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

        {/* Composer */}
        <ChatComposer
          input={input}
          onInputChange={setInput}
          onSubmit={() => submit(input)}
          placeholder="Story outline with article links"
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
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
            <>
              {fileAttachSuccess ? (
                <div className="mb-2 flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-200 animate-in fade-in duration-200">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{files.length} file{files.length !== 1 ? 's' : ''} attached</span>
                </div>
              ) : null}
              {files.length > 0 ? (
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
              ) : null}
              {uploadError ? (
                <div
                  role="alert"
                  className="mb-2 rounded-lg border border-amber-300/30 bg-amber-400/[0.08] px-3 py-2 text-[0.78rem] text-amber-100"
                >
                  Some files were not attached — {uploadError}.
                </div>
              ) : null}
            </>
          }
        />
      </div>

      {/* Sources sidebar */}
      {openSource ? (
        <aside className="ark-fade-up relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-[#070b22]/80 backdrop-blur-xl">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              background:
                'radial-gradient(80% 50% at 50% 0%, rgba(62,181,249,0.14) 0%, transparent 60%)',
            }}
          />
          <header className="relative flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-md border border-[#3eb5f9]/30 bg-[#3eb5f9]/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[#79cdfc]">
                  Source {openSource.number}
                </span>
              </div>
              <div
                className="mt-2 truncate text-base font-bold text-white"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {openSource.title}
              </div>
              {openSource.date ? (
                <div className="mt-1 text-xs text-white/55">{openSource.date}</div>
              ) : null}
            </div>
            <button
              onClick={() => setOpenSource(null)}
              className="rounded p-1 text-white/60 transition hover:bg-white/10 hover:text-white"
              aria-label="Close source"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="relative flex-1 overflow-y-auto px-5 py-5">
            <p className="text-[0.92rem] leading-[1.7] text-white/85">
              {openSource.url}
            </p>
          </div>
          <footer className="relative border-t border-white/10 px-5 py-3">
            <a
              href={openSource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#3eb5f9]/10 px-3 py-1.5 text-sm font-medium text-[#79cdfc] transition hover:bg-[#3eb5f9]/20 hover:text-white"
            >
              Open link
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </footer>
        </aside>
      ) : null}
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
}: {
  message: NewsUIMessage;
  onSourceClick: (source: NewsSource) => void;
  sources: NewsSource[];
}) {
  if (message.role === 'user') {
    const textParts = message.parts?.filter((p) => p.type === 'text') ?? [];
    const fileParts = message.parts?.filter((p) => p.type === 'file') ?? [];
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
          {fileParts.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {fileParts.map((p, i) => (
                <span key={i} className="inline-block rounded bg-white/20 px-1.5 py-0.5 text-[0.85rem]">
                  {p.filename ?? 'file'}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="ark-fade-up flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-white/[0.04] px-4 py-3 text-white">
        <MessageContent message={message} onSourceClick={onSourceClick} sources={sources} />
      </div>
    </div>
  );
}

function MessageContent({
  message,
  onSourceClick,
  sources,
}: {
  message: NewsUIMessage;
  onSourceClick: (source: NewsSource) => void;
  sources: NewsSource[];
}) {
  return message.parts?.map((part, i) => {
    if (part.type === 'text') {
      return <NewsMarkdown key={i} text={part.text} onSourceClick={onSourceClick} sources={sources} />;
    }
    if (part.type === 'tool-fetchArticle') {
      const state = (part as any).state;
      if (state === 'input-streaming' || state === 'input-available') {
        return <ToolCallChip key={i} name="Fetching article…" status="in-flight" />;
      }
      if (state === 'output-available') {
        return <ToolCallChip key={i} name="Article fetched" status="done" />;
      }
    }
    if (part.type === 'tool-searchCorpus') {
      const state = (part as any).state;
      if (state === 'input-streaming' || state === 'input-available') {
        return <ToolCallChip key={i} name="Loading style examples…" status="in-flight" />;
      }
      if (state === 'output-available') {
        return <ToolCallChip key={i} name="Style examples loaded" status="done" />;
      }
    }
    if (part.type === 'tool-webSearch') {
      const state = (part as any).state;
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
        <div key={parts.length} className="my-3 ml-4 border-l-2 border-white/20 pl-4 italic text-white/80">
          <div className="font-semibold text-white/90">{speaker}</div>
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
                <blockquote className="border-l-4 border-white/30 pl-4 my-3 italic text-white/80">{renderFootnotes(children, onSourceClick, sources)}</blockquote>
              ),
              ul: ({ children }) => <ul className="list-disc list-inside my-2">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal list-inside my-2">{children}</ol>,
              li: ({ children }) => <li className="my-1">{renderFootnotes(children, onSourceClick, sources)}</li>,
              hr: () => <hr className="my-4 border-white/20" />,
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

function renderLineWithFootnotes(
  text: string,
  onSourceClick: (source: NewsSource) => void,
  sources: NewsSource[]
): React.ReactNode {
  return renderFootnotes(text, onSourceClick, sources);
}


function TypingDots() {
  return (
    <span className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-white/40"
          style={{
            animation: `ark-pulse-dot 1.4s infinite`,
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
    </span>
  );
}
