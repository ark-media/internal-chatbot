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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  FileText,
  Globe,
  Loader2,
  Paperclip,
  Search,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

import { ArkLogo } from '@/components/ArkLogo';
import type {
  PastGuestAppearancesToolOutput,
  PrepUIMessage,
  SearchCorpusToolOutput,
  WebSearchToolOutput,
} from '@/components/prep-types';
import { cn } from '@/lib/cn';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatBytes,
} from '@/lib/prep-limits';

const SKY = '#3eb5f9';
const INK_900 = '#0b153c';

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
  const { messages, sendMessage, status, stop } = useChat<PrepUIMessage>({
    transport: new DefaultChatTransport({ api: '/api/prep' }),
  });

  const [input, setInput] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
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
                Episode Prep
              </div>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-[0.75rem]">
            <Link
              href="/"
              className="rounded-md px-2.5 py-1 text-white/60 transition hover:bg-white/[0.05] hover:text-white"
            >
              Archive
            </Link>
            <span className="rounded-md bg-[#3eb5f9]/[0.12] px-2.5 py-1 text-[#79cdfc]">
              Prep
            </span>
          </nav>
        </header>

        {/* ---------- Message list ---------- */}
        <main ref={scrollRef} className="relative flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-6 py-10">
            {messages.length === 0 && <EmptyState onPick={submit} busy={busy} />}

            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}

            {busy && (
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
            )}
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
                'group flex items-end gap-2 rounded-2xl border bg-white/[0.04] px-3 py-2.5 backdrop-blur',
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
                placeholder="Episode title + guest (e.g. Call me Back — 'Iran after the strikes' — with Ray Takeyh)…"
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
        Prep the{' '}
        <span className="bg-gradient-to-r from-[#3eb5f9] via-[#79cdfc] to-white bg-clip-text text-transparent">
          next episode
        </span>
        .
      </h1>
      <p className="mt-3 max-w-md text-[0.95rem] leading-relaxed text-white/55">
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
      </p>

      <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-1">
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

      <p className="mt-6 max-w-md text-[0.78rem] leading-relaxed text-white/40">
        Attach prep notes, draft outlines, or past transcripts via the clip icon.
      </p>
    </div>
  );
}
