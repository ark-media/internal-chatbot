'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import {
  Loader2,
  Play,
  CheckCircle2,
  XCircle,
  Plus,
  RefreshCw,
  ExternalLink,
  Copy,
  HardDriveUpload,
  Pencil,
  Trash2,
  Link as LinkIcon,
  ArrowLeft,
  Send,
  Undo2,
  BookOpenCheck,
} from 'lucide-react';

import type { Components } from 'react-markdown';

import { Header } from '@/components/Header';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { KindBadge } from '@/components/ui/KindBadge';
import { notifyChatUpdated } from '@/lib/chat-refresh';
import { cn } from '@/lib/cn';
import {
  renumberIndicesAfterDelete,
  type DistillResult,
  type OrchestratorRun,
  type RatedArticle,
  type RefineEntry,
  type Script,
  type TopicWithSources,
} from '@/lib/orchestrator/types';

type StartMode = 'discover' | 'urls' | 'topics';

type StartResponse =
  | { stage: 'checkpoint'; distill: DistillResult; articleCount: number }
  | { stage: 'error'; errorMessage: string };

type GenerateResponse =
  | { stage: 'complete'; script: Script; iterations: number }
  | { stage: 'error' | 'checkpoint'; errorMessage: string };

type TopicsResponse = { stage: 'checkpoint'; distill: DistillResult } | { error: string };

function stageLabel(stage: OrchestratorRun['stage'] | undefined): string {
  switch (stage) {
    case 'gathering':
      return 'Pulling stories';
    case 'checkpoint':
      return 'Pick topics';
    case 'crafting':
      return 'Writing script';
    case 'complete':
      return 'Done';
    case 'error':
      return 'Something went wrong';
    default:
      return 'Ready';
  }
}

// When a link's visible text is identical to its href (bare URLs from
// markdown autolink), swap the label for the hostname so long opaque
// vertexaisearch.cloud.google.com/grounding-api-redirect/... URLs don't
// dominate the script. The href is preserved, so the link still works
// and copy-to-clipboard still gets the full URL.
const scriptMarkdownComponents: Partial<Components> = {
  // Loose markdown lists wrap each item's text in a <p>. With the global <p>
  // styling (block + margin) this pushes the list marker onto its own line.
  // Render the item's <p> children inline so "1." stays next to its text.
  li: ({ children }) => (
    <li className="my-1 [&>p]:m-0 [&>p]:inline">{children}</li>
  ),
  a: ({ href, children }) => {
    let label: ReactNode = children;
    if (typeof href === 'string') {
      const arr = Array.isArray(children) ? children : [children];
      const onlyText =
        arr.length === 1 && typeof arr[0] === 'string' ? (arr[0] as string) : null;
      if (onlyText && onlyText === href) {
        try {
          label = new URL(href).hostname.replace(/^www\./, '');
        } catch {
          // keep original children if URL parsing fails
        }
      }
    }
    return (
      <a
        href={href}
        title={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-cyan-400 underline hover:text-cyan-300"
      >
        {label}
      </a>
    );
  },
};

// Boundary between editable script body and the read-only SOURCES list.
// Matches the same separator used by `extractSources` and `app/api/news/route.ts`
// so the split here is consistent with how the rest of the app parses scripts.
function splitScriptBody(fullText: string): { body: string; sourcesTail: string } {
  const sep = /\n\s*---+\s*\n\s*SOURCES:\s*\n/i;
  const m = fullText.match(sep);
  if (!m || m.index === undefined) {
    return { body: fullText, sourcesTail: '' };
  }
  return {
    body: fullText.slice(0, m.index),
    sourcesTail: fullText.slice(m.index),
  };
}

const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

export default function OrchestratorPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  if (!chatId) return null;
  return <OrchestratorBody chatId={chatId} />;
}

function OrchestratorBody({ chatId }: { chatId: string }) {
  const [run, setRun] = useState<OrchestratorRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    null | 'start' | 'refetch' | 'generate' | 'topics' | 'attach'
  >(null);
  const generateInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string>(todayISO());
  const [rejectedTopics, setRejectedTopics] = useState<Set<number>>(new Set());
  // After a script is complete, the writer can pop back into the checkpoint
  // editor without losing the script. Local-only — survives until refresh.
  const [editingFromComplete, setEditingFromComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/news/orchestrator/${chatId}`)
      .then((r) => r.json() as Promise<{ run: OrchestratorRun | null }>)
      .then((d) => {
        if (cancelled) return;
        setRun(d.run);
        if (d.run?.today) setToday(d.run.today);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const refresh = useCallback(async () => {
    const fresh = await fetch(`/api/news/orchestrator/${chatId}`).then((r) => r.json());
    setRun(fresh.run);
  }, [chatId]);

  const start = useCallback(
    async (
      payload:
        | { mode: 'discover' }
        | { mode: 'urls'; urls: string[] }
        | { mode: 'topics'; topics: { topic: string; description: string }[]; autoGather: boolean },
    ) => {
      setBusy('start');
      setError(null);
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
        const res = await fetch('/api/news/orchestrator/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, today, timezone: tz, ...payload }),
        });
        const data = (await res.json()) as StartResponse;
        if (data.stage === 'error') {
          setError(data.errorMessage);
          return;
        }
        await refresh();
        setRejectedTopics(new Set());
        notifyChatUpdated();
      } catch (err) {
        setError(String(err).slice(0, 300));
      } finally {
        setBusy(null);
      }
    },
    [chatId, today, refresh],
  );

  const refetch = useCallback(
    async (topicIndex: number, guidance: string) => {
      setBusy('refetch');
      setError(null);
      try {
        const res = await fetch('/api/news/orchestrator/refetch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, topicIndex, guidance }),
        });
        const data = await res.json();
        if ('error' in data) {
          setError(data.error);
          return;
        }
        await refresh();
      } catch (err) {
        setError(String(err).slice(0, 300));
      } finally {
        setBusy(null);
      }
    },
    [chatId, refresh],
  );

  // Resolves to `true` on success so callers can defer UI teardown (e.g. the
  // add-topic form) until the request — which for `add`/`gather` includes a
  // slow source-gathering pass — actually finishes.
  const topicAction = useCallback(
    async (
      payload:
        | { action: 'add'; topic: string; description: string; autoGather: boolean }
        | { action: 'update'; topicIndex: number; topic?: string; description?: string }
        | { action: 'delete'; topicIndex: number }
        | { action: 'gather'; topicIndex: number },
    ): Promise<boolean> => {
      setBusy('topics');
      setError(null);
      try {
        const res = await fetch('/api/news/orchestrator/topics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, ...payload }),
        });
        const data = (await res.json()) as TopicsResponse;
        if ('error' in data) {
          setError(data.error);
          return false;
        }
        await refresh();
        if (payload.action === 'delete') {
          // Index space shifted — use the same shared helper the server uses
          // to renumber `approvedTopicIndices`, so the two stay in lockstep.
          setRejectedTopics((prev) =>
            new Set(renumberIndicesAfterDelete(Array.from(prev), payload.topicIndex)),
          );
        }
        return true;
      } catch (err) {
        setError(String(err).slice(0, 300));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [chatId, refresh],
  );

  const attachUrls = useCallback(
    async (topicIndex: number, urls: string[]) => {
      setBusy('attach');
      setError(null);
      try {
        const res = await fetch('/api/news/orchestrator/attach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, topicIndex, urls }),
        });
        const data = await res.json();
        if ('error' in data) {
          setError(data.error);
          return;
        }
        await refresh();
      } catch (err) {
        setError(String(err).slice(0, 300));
      } finally {
        setBusy(null);
      }
    },
    [chatId, refresh],
  );

  const generate = useCallback(async () => {
    if (!run?.distill || generateInFlightRef.current) return;
    const indices = run.distill.topics
      .map((_, i) => i)
      .filter((i) => !rejectedTopics.has(i))
      .filter((i) => run.distill!.topics[i].articles.length > 0);
    if (indices.length === 0) {
      setError('Approve at least one topic with sources before generating.');
      return;
    }
    generateInFlightRef.current = true;
    setBusy('generate');
    setError(null);
    try {
      const res = await fetch('/api/news/orchestrator/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, approvedTopicIndices: indices }),
      });
      const data = (await res.json()) as GenerateResponse;
      if (data.stage !== 'complete') {
        setError(data.errorMessage || 'Generation failed.');
        await refresh();
        return;
      }
      await refresh();
      setEditingFromComplete(false);
    } catch (err) {
      setError(String(err).slice(0, 300));
    } finally {
      generateInFlightRef.current = false;
      setBusy(null);
    }
  }, [chatId, run, rejectedTopics, refresh]);

  if (loading) {
    return (
      <div className="flex flex-1 flex-col">
        <Header variant="news" />
        <main className="flex flex-1 items-center justify-center text-fg/50">
          <Loader2 className="h-5 w-5 animate-spin" />
        </main>
      </div>
    );
  }

  // Decide which view to show.
  const showStart = run === null || run.stage === 'error';
  const showCheckpoint =
    !showStart &&
    run !== null &&
    (run.stage === 'checkpoint' || (run.stage === 'complete' && editingFromComplete));
  const showScript =
    !showStart &&
    run !== null &&
    run.stage === 'complete' &&
    !!run.finalScript &&
    !editingFromComplete;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header variant="news" />
      <main className="relative flex-1 overflow-y-auto">
        <div className="flex w-full flex-col gap-6 px-5 py-10">
          <div className="flex items-baseline justify-between">
            <h1 className="font-display text-2xl font-bold text-fg">
              News Script <span className="text-sky-brand">Orchestrator</span>
            </h1>
            <div className="text-xs uppercase tracking-[0.22em] text-fg/45">
              {stageLabel(run?.stage)}
            </div>
          </div>
          <p className="text-sm text-fg/60">
            Pulls today&rsquo;s top stories, lets you pick which to cover, then writes and edits the
            script for you. Or skip ahead — bring your own URLs or topics.
          </p>

          {error ? (
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          {showStart ? (
            <StartCard
              today={today}
              onTodayChange={setToday}
              onStart={start}
              busy={busy === 'start'}
              previousError={run?.stage === 'error' ? run.errorMessage : null}
            />
          ) : null}

          {busy === 'start' && !showCheckpoint ? (
            <ProgressCard
              label="Setting up your run…"
              detail="Discovery + extraction can take 60–120 seconds."
            />
          ) : null}

          {showCheckpoint && run?.distill ? (
            <CheckpointView
              distill={run.distill}
              rejectedTopics={rejectedTopics}
              onToggleReject={(i) =>
                setRejectedTopics((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              onRefetch={refetch}
              onGenerate={generate}
              onTopicAction={topicAction}
              onAttach={attachUrls}
              busy={busy}
              regenerating={editingFromComplete}
              onCancelEdit={editingFromComplete ? () => setEditingFromComplete(false) : null}
            />
          ) : null}

          {busy === 'generate' ? (
            <ProgressCard
              label="Writing and editing the script…"
              detail="Drafting then running an editorial review pass. Up to 3 rounds of edits. Typically 60–180 seconds."
            />
          ) : null}

          {showScript && run?.finalScript ? (
            <ScriptView
              script={run.finalScript}
              chatId={chatId}
              refineHistory={run.refineHistory}
              canUndo={run.scriptVersions.length > 0}
              lastDistilledVersion={run.lastDistilledVersion ?? null}
              onScriptUpdated={(script, history) =>
                setRun((prev) =>
                  prev
                    ? {
                        ...prev,
                        finalScript: script,
                        refineHistory: history,
                        scriptVersions:
                          history.length > prev.refineHistory.length
                            ? [...prev.scriptVersions, prev.finalScript!]
                            : prev.scriptVersions.slice(0, -1),
                      }
                    : prev,
                )
              }
              onLearned={(version) =>
                setRun((prev) =>
                  prev
                    ? {
                        ...prev,
                        lastDistilledVersion: version === null ? undefined : version,
                      }
                    : prev,
                )
              }
              onEdit={() => setEditingFromComplete(true)}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

// ---------- Start ----------

function StartCard({
  today,
  onTodayChange,
  onStart,
  busy,
  previousError,
}: {
  today: string;
  onTodayChange: (v: string) => void;
  onStart: (
    p:
      | { mode: 'discover' }
      | { mode: 'urls'; urls: string[] }
      | { mode: 'topics'; topics: { topic: string; description: string }[]; autoGather: boolean },
  ) => void;
  busy: boolean;
  previousError: string | null;
}) {
  const [mode, setMode] = useState<StartMode>('discover');
  const [urlsText, setUrlsText] = useState('');
  const [topics, setTopics] = useState<{ topic: string; description: string }[]>([
    { topic: '', description: '' },
  ]);
  const [autoGather, setAutoGather] = useState(true);

  const submit = () => {
    if (mode === 'discover') return onStart({ mode: 'discover' });
    if (mode === 'urls') {
      const urls = urlsText
        .split(/\s+/)
        .map((u) => u.trim())
        .filter((u) => /^https?:\/\//i.test(u));
      if (urls.length === 0) return;
      return onStart({ mode: 'urls', urls });
    }
    // topics
    const cleaned = topics
      .map((t) => ({ topic: t.topic.trim(), description: t.description.trim() }))
      .filter((t) => t.topic.length > 0 && t.description.length > 0);
    if (cleaned.length === 0) return;
    return onStart({ mode: 'topics', topics: cleaned, autoGather });
  };

  const canSubmit = (() => {
    if (mode === 'discover') return true;
    if (mode === 'urls') return urlsText.trim().length > 0;
    return topics.some((t) => t.topic.trim() && t.description.trim());
  })();

  return (
    <div className="rounded-2xl border border-overlay/10 bg-overlay/[0.03] p-6">
      {previousError ? (
        <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          Last attempt didn&rsquo;t finish: {previousError}
        </div>
      ) : null}

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-fg/70" htmlFor="today">
          Recording date
        </label>
        <input
          id="today"
          type="date"
          value={today}
          onChange={(e) => onTodayChange(e.target.value)}
          className="rounded-md border border-overlay/15 ark-recessed px-2 py-1 text-sm text-fg"
        />
      </div>

      <div className="mb-5 flex flex-wrap gap-1 rounded-lg border border-overlay/10 ark-recessed p-1">
        {(
          [
            ['discover', 'Discover stories'],
            ['urls', 'I have URLs'],
            ['topics', 'I have topics'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition',
              mode === k
                ? 'bg-sky-brand/20 text-sky-brand-soft'
                : 'text-fg/55 hover:bg-overlay/5 hover:text-fg/85',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'discover' ? (
        <p className="mb-4 text-sm text-fg/55">
          Pull today&rsquo;s top stories, group them into topics, and rate the sources.
        </p>
      ) : null}

      {mode === 'urls' ? (
        <div className="mb-4 flex flex-col gap-2">
          <label className="text-sm text-fg/70">Paste URLs (one per line)</label>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            placeholder={'https://www.timesofisrael.com/...\nhttps://www.reuters.com/...'}
            rows={5}
            className="w-full rounded-md border border-overlay/15 ark-recessed px-3 py-2 font-mono text-xs text-fg placeholder:text-fg/30"
          />
          <p className="text-xs text-fg/40">
            We&rsquo;ll extract each one and group + rate them like a normal run. URLs outside the
            freshness window get an &ldquo;older story&rdquo; flag, but stay in the pool.
          </p>
        </div>
      ) : null}

      {mode === 'topics' ? (
        <div className="mb-4 flex flex-col gap-3">
          <label className="text-sm text-fg/70">Your topics (up to 4)</label>
          {topics.map((t, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-md border border-overlay/10 ark-recessed-soft p-3">
              <div className="flex items-center justify-between">
                <span className="text-[0.7rem] uppercase tracking-wider text-fg/45">
                  Topic {i + 1}
                </span>
                {topics.length > 1 ? (
                  <button
                    onClick={() => setTopics((prev) => prev.filter((_, idx) => idx !== i))}
                    className="text-xs text-fg/40 hover:text-red-300"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <input
                value={t.topic}
                onChange={(e) =>
                  setTopics((prev) =>
                    prev.map((p, idx) => (idx === i ? { ...p, topic: e.target.value } : p)),
                  )
                }
                placeholder="Short topic name (e.g. Strait of Hormuz tensions)"
                className="w-full rounded-md border border-overlay/15 ark-recessed px-2 py-1 text-sm text-fg placeholder:text-fg/30"
              />
              <textarea
                value={t.description}
                onChange={(e) =>
                  setTopics((prev) =>
                    prev.map((p, idx) => (idx === i ? { ...p, description: e.target.value } : p)),
                  )
                }
                placeholder="1–2 sentence description of what this topic covers"
                rows={2}
                className="w-full rounded-md border border-overlay/15 ark-recessed px-2 py-1 text-sm text-fg placeholder:text-fg/30"
              />
            </div>
          ))}
          {topics.length < 4 ? (
            <button
              onClick={() => setTopics((prev) => [...prev, { topic: '', description: '' }])}
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-overlay/15 px-2 py-1 text-xs text-fg/60 hover:bg-overlay/5 hover:text-fg"
            >
              <Plus className="h-3 w-3" /> Add topic
            </button>
          ) : null}
          <label className="mt-1 flex items-center gap-2 text-xs text-fg/55">
            <input
              type="checkbox"
              checked={autoGather}
              onChange={(e) => setAutoGather(e.target.checked)}
              className="rounded border-overlay/20 ark-recessed"
            />
            Auto-gather sources for each topic now (uncheck if you&rsquo;ll attach URLs yourself).
          </label>
        </div>
      ) : null}

      <button
        onClick={submit}
        disabled={busy || !canSubmit}
        className={cn(
          'inline-flex items-center gap-2 rounded-lg bg-sky-brand px-4 py-2.5 text-sm font-semibold text-ink-950',
          'transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {busy
          ? 'Starting…'
          : mode === 'discover'
            ? 'Pull today’s stories'
            : mode === 'urls'
              ? 'Extract & group'
              : autoGather
                ? 'Find sources for these topics'
                : 'Open editor with these topics'}
      </button>
    </div>
  );
}

function ProgressCard({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-overlay/10 bg-overlay/[0.03] p-6">
      <div className="flex items-center gap-3 text-fg">
        <Loader2 className="h-5 w-5 animate-spin text-sky-brand" />
        <span className="font-medium">{label}</span>
      </div>
      <p className="mt-2 text-sm text-fg/50">{detail}</p>
    </div>
  );
}

// ---------- Checkpoint ----------

type TopicAction =
  | { action: 'add'; topic: string; description: string; autoGather: boolean }
  | { action: 'update'; topicIndex: number; topic?: string; description?: string }
  | { action: 'delete'; topicIndex: number }
  | { action: 'gather'; topicIndex: number };

function CheckpointView({
  distill,
  rejectedTopics,
  onToggleReject,
  onRefetch,
  onGenerate,
  onTopicAction,
  onAttach,
  busy,
  regenerating,
  onCancelEdit,
}: {
  distill: DistillResult;
  rejectedTopics: Set<number>;
  onToggleReject: (index: number) => void;
  onRefetch: (index: number, guidance: string) => void;
  onGenerate: () => void;
  onTopicAction: (p: TopicAction) => Promise<boolean>;
  onAttach: (topicIndex: number, urls: string[]) => void;
  busy: null | 'start' | 'refetch' | 'generate' | 'topics' | 'attach';
  regenerating: boolean;
  onCancelEdit: (() => void) | null;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const approvedCount = distill.topics.filter(
    (t, i) => !rejectedTopics.has(i) && t.articles.length > 0,
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {regenerating ? (
        <div className="flex items-center justify-between rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <span>
            Editing topics — your previous script is preserved. Click <strong>Regenerate</strong> to
            replace it, or <strong>back</strong> to keep it as-is.
          </span>
          {onCancelEdit ? (
            <button
              onClick={onCancelEdit}
              className="inline-flex items-center gap-1 rounded-md border border-amber-400/30 px-2 py-1 text-xs hover:bg-amber-500/20"
            >
              <ArrowLeft className="h-3 w-3" /> Back to script
            </button>
          ) : null}
        </div>
      ) : null}

      {distill.rationale ? (
        <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] px-4 py-3 text-sm text-fg/70">
          <span className="font-semibold text-fg">Why these topics: </span>
          {distill.rationale}
        </div>
      ) : null}

      {distill.topics.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-overlay/15 bg-overlay/[0.01] p-6 text-center text-sm text-fg/55">
          No topics yet. Add one below to get started.
        </div>
      ) : null}

      {distill.topics.map((topic, i) => (
        <TopicCard
          key={i}
          topic={topic}
          index={i}
          rejected={rejectedTopics.has(i)}
          onToggleReject={() => onToggleReject(i)}
          onRefetch={(guidance) => onRefetch(i, guidance)}
          onTopicAction={onTopicAction}
          onAttach={(urls) => onAttach(i, urls)}
          busy={busy}
        />
      ))}

      {showAdd ? (
        <AddTopicCard
          onCancel={() => setShowAdd(false)}
          onSubmit={async (payload) => {
            // Keep the card mounted (and showing its busy state) until the
            // add — which auto-gathers sources server-side — actually lands.
            // Dismiss only on success so a failure leaves the form intact.
            const ok = await onTopicAction({ action: 'add', ...payload });
            if (ok) setShowAdd(false);
          }}
          busy={busy === 'topics'}
        />
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-dashed border-overlay/15 bg-overlay/[0.01] p-4 text-sm text-fg/55 transition hover:border-overlay/30 hover:text-fg"
        >
          <Plus className="h-4 w-4" /> Add a topic
        </button>
      )}

      <div className="sticky bottom-0 -mx-6 mt-2 border-t border-overlay/10 bg-canvas/90 px-6 py-4 backdrop-blur">
        <button
          onClick={onGenerate}
          disabled={busy !== null || approvedCount === 0}
          className={cn(
            'w-full rounded-lg bg-sky-brand px-4 py-3 text-sm font-semibold text-ink-950',
            'transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {busy === 'generate' ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing script…
            </span>
          ) : regenerating ? (
            `Regenerate with ${approvedCount} topic${approvedCount === 1 ? '' : 's'}`
          ) : (
            `Write script with ${approvedCount} topic${approvedCount === 1 ? '' : 's'}`
          )}
        </button>
      </div>
    </div>
  );
}

function AddTopicCard({
  onCancel,
  onSubmit,
  busy,
}: {
  onCancel: () => void;
  onSubmit: (p: { topic: string; description: string; autoGather: boolean }) => void;
  busy: boolean;
}) {
  const [topic, setTopic] = useState('');
  const [description, setDescription] = useState('');
  const [autoGather, setAutoGather] = useState(true);
  const canSubmit = topic.trim().length > 0 && description.trim().length > 0;
  return (
    <div className="rounded-2xl border border-overlay/10 bg-overlay/[0.03] p-5">
      <div className="mb-3 text-sm font-semibold text-fg">New topic</div>
      <input
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="Short topic name"
        disabled={busy}
        className="mb-2 w-full rounded-md border border-overlay/15 ark-recessed px-3 py-2 text-sm text-fg placeholder:text-fg/30 disabled:opacity-60"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="1–2 sentence description"
        rows={2}
        disabled={busy}
        className="mb-3 w-full rounded-md border border-overlay/15 ark-recessed px-3 py-2 text-sm text-fg placeholder:text-fg/30 disabled:opacity-60"
      />
      <label className="mb-3 flex items-center gap-2 text-xs text-fg/55">
        <input
          type="checkbox"
          checked={autoGather}
          onChange={(e) => setAutoGather(e.target.checked)}
          disabled={busy}
          className="rounded border-overlay/20 ark-recessed disabled:opacity-60"
        />
        Find sources for this topic now
      </label>
      <div className="flex gap-2">
        <button
          onClick={() => onSubmit({ topic: topic.trim(), description: description.trim(), autoGather })}
          disabled={!canSubmit || busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-sky-brand/20 px-3 py-1.5 text-xs text-sky-brand transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          {busy ? (autoGather ? 'Finding sources…' : 'Adding…') : 'Add topic'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-xs text-fg/60 hover:bg-overlay/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {busy && autoGather ? (
        <p className="mt-3 text-xs text-fg/45">
          Searching approved outlets for sources on this topic — this usually takes up to a minute.
        </p>
      ) : null}
    </div>
  );
}

function TopicCard({
  topic,
  index,
  rejected,
  onToggleReject,
  onRefetch,
  onTopicAction,
  onAttach,
  busy,
}: {
  topic: TopicWithSources;
  index: number;
  rejected: boolean;
  onToggleReject: () => void;
  onRefetch: (guidance: string) => void;
  onTopicAction: (p: TopicAction) => Promise<boolean>;
  onAttach: (urls: string[]) => void;
  busy: null | 'start' | 'refetch' | 'generate' | 'topics' | 'attach';
}) {
  const [showRefetch, setShowRefetch] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  // Local to this card so only the topic the writer clicked shows the
  // gather spinner — `busy` is global and disables every card's actions.
  const [gathering, setGathering] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(topic.topic);
  const [descDraft, setDescDraft] = useState(topic.description);
  const [guidance, setGuidance] = useState('');
  const [urlsText, setUrlsText] = useState('');

  const submitEdit = () => {
    const t = titleDraft.trim();
    const d = descDraft.trim();
    if (!t || !d) return;
    onTopicAction({ action: 'update', topicIndex: index, topic: t, description: d });
    setEditingTitle(false);
  };

  const submitAttach = () => {
    const urls = urlsText
      .split(/\s+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    if (urls.length === 0) return;
    onAttach(urls);
    setShowAttach(false);
    setUrlsText('');
  };

  const noSources = topic.articles.length === 0;

  return (
    <div
      className={cn(
        'rounded-2xl border p-5 transition',
        rejected
          ? 'border-overlay/5 bg-overlay/[0.01] opacity-50'
          : 'border-overlay/10 bg-overlay/[0.03]',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <KindBadge tone="sky">Topic {index + 1}</KindBadge>
            {editingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                className="flex-1 rounded-md border border-overlay/15 ark-recessed px-2 py-1 text-sm text-fg"
                autoFocus
              />
            ) : (
              <h3 className="text-base font-bold text-fg">{topic.topic}</h3>
            )}
          </div>
          {editingTitle ? (
            <textarea
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              rows={2}
              className="mt-2 w-full rounded-md border border-overlay/15 ark-recessed px-2 py-1 text-sm text-fg"
            />
          ) : (
            <p className="mt-1 text-sm text-fg/60">{topic.description}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {editingTitle ? (
            <>
              <button
                onClick={submitEdit}
                disabled={busy === 'topics'}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20"
              >
                <CheckCircle2 className="h-3 w-3" /> Save
              </button>
              <button
                onClick={() => {
                  setEditingTitle(false);
                  setTitleDraft(topic.topic);
                  setDescDraft(topic.description);
                }}
                className="text-xs text-fg/45 hover:text-fg"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onToggleReject}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition',
                  rejected
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                    : 'border-red-400/30 bg-red-500/10 text-red-200 hover:bg-red-500/20',
                )}
                title={rejected ? 'Re-approve this topic' : 'Reject this topic'}
              >
                {rejected ? (
                  <>
                    <CheckCircle2 className="h-3 w-3" /> Approve
                  </>
                ) : (
                  <>
                    <XCircle className="h-3 w-3" /> Reject
                  </>
                )}
              </button>
              <div className="flex gap-1">
                <button
                  onClick={() => setEditingTitle(true)}
                  className="rounded-md p-1 text-fg/45 hover:bg-overlay/5 hover:text-fg"
                  title="Edit title and description"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete "${topic.topic}"? Sources stay in the article pool but the topic is gone.`,
                      )
                    ) {
                      onTopicAction({ action: 'delete', topicIndex: index });
                    }
                  }}
                  className="rounded-md p-1 text-fg/45 hover:bg-red-500/20 hover:text-red-300"
                  title="Delete this topic"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {noSources ? (
        <div className="mt-4 rounded-md border border-dashed border-overlay/10 bg-overlay/[0.01] px-3 py-3 text-center text-xs text-fg/45">
          No sources yet. Use the actions below to gather or attach.
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {topic.articles.map((rated, i) => (
            <SourceRow key={i} rated={rated} />
          ))}
        </div>
      )}

      {!rejected ? (
        <div className="mt-4 flex flex-col gap-2 border-t border-overlay/10 pt-3">
          <div className="flex flex-wrap gap-2">
            {!showRefetch && !showAttach ? (
              <>
                <button
                  onClick={() => setShowRefetch(true)}
                  className="inline-flex items-center gap-1.5 text-xs text-fg/55 transition hover:text-fg"
                >
                  <Plus className="h-3 w-3" /> Find more sources
                </button>
                <span className="text-xs text-fg/20">·</span>
                <button
                  onClick={() => setShowAttach(true)}
                  className="inline-flex items-center gap-1.5 text-xs text-fg/55 transition hover:text-fg"
                >
                  <LinkIcon className="h-3 w-3" /> Attach URL
                </button>
                {noSources ? (
                  <>
                    <span className="text-xs text-fg/20">·</span>
                    <button
                      onClick={async () => {
                        setGathering(true);
                        // `topicAction` clears the global busy flag in its
                        // own `finally`; the local flag just scopes the
                        // spinner to this card.
                        await onTopicAction({ action: 'gather', topicIndex: index });
                        setGathering(false);
                      }}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1.5 text-xs text-sky-brand-soft transition hover:text-fg disabled:opacity-50"
                    >
                      {gathering ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      {gathering ? 'Finding sources…' : 'Auto-gather for this topic'}
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>

          {gathering ? (
            <p className="text-xs text-fg/45">
              Searching approved outlets for sources on this topic — this usually takes up to a
              minute.
            </p>
          ) : null}

          {showRefetch ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder="What angle should I look for?"
                rows={2}
                className="w-full rounded-md border border-overlay/15 ark-recessed px-3 py-2 text-sm text-fg placeholder:text-fg/30"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (!guidance.trim()) return;
                    onRefetch(guidance);
                    setShowRefetch(false);
                    setGuidance('');
                  }}
                  disabled={busy !== null || !guidance.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-sky-brand/20 px-3 py-1.5 text-xs text-sky-brand transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === 'refetch' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Fetch more
                </button>
                <button
                  onClick={() => {
                    setShowRefetch(false);
                    setGuidance('');
                  }}
                  className="rounded-md px-3 py-1.5 text-xs text-fg/60 hover:bg-overlay/5 hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {showAttach ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                placeholder={'https://...'}
                rows={3}
                className="w-full rounded-md border border-overlay/15 ark-recessed px-3 py-2 font-mono text-xs text-fg placeholder:text-fg/30"
              />
              <div className="flex gap-2">
                <button
                  onClick={submitAttach}
                  disabled={busy !== null || !urlsText.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-sky-brand/20 px-3 py-1.5 text-xs text-sky-brand transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === 'attach' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <LinkIcon className="h-3 w-3" />
                  )}
                  Attach
                </button>
                <button
                  onClick={() => {
                    setShowAttach(false);
                    setUrlsText('');
                  }}
                  className="rounded-md px-3 py-1.5 text-xs text-fg/60 hover:bg-overlay/5 hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SourceRow({ rated }: { rated: RatedArticle }) {
  const a = rated.article;
  const flagged = a.isFlagged || a.fetchError;
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'group flex items-start gap-3 rounded-md border border-overlay/[0.06] bg-overlay/[0.02] px-3 py-2 transition',
        'hover:border-overlay/15 hover:bg-overlay/[0.04]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[0.7rem] uppercase tracking-wider text-fg/45">{a.source}</span>
          {a.publicationDate ? (
            <span className="text-[0.7rem] text-fg/35">{a.publicationDate.slice(0, 10)}</span>
          ) : null}
          {rated.provenance === 'manual' ? (
            <span className="rounded bg-sky-brand/15 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wider text-sky-brand-soft">
              attached
            </span>
          ) : null}
          {flagged ? (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wider text-amber-200">
              {a.fetchError ? 'couldn’t open' : 'older story'}
            </span>
          ) : null}
        </div>
        <div className="truncate text-sm text-fg/85">{a.title}</div>
      </div>
      <div
        className="shrink-0 text-right"
        title={`Relevance ${rated.relevance} · Credibility ${rated.credibility} · Completeness ${rated.completeness}`}
      >
        <div className="text-[0.7rem] text-fg/55">Score</div>
        <div className="font-mono text-sm text-fg/80">{rated.avgScore}</div>
      </div>
      <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-fg/30 transition group-hover:text-fg/60" />
    </a>
  );
}

// ---------- Script ----------

function ScriptView({
  script,
  chatId,
  refineHistory,
  canUndo,
  lastDistilledVersion,
  onScriptUpdated,
  onLearned,
  onEdit,
}: {
  script: Script;
  chatId: string;
  refineHistory: RefineEntry[];
  canUndo: boolean;
  lastDistilledVersion: number | null;
  onScriptUpdated: (script: Script, history: RefineEntry[]) => void;
  onLearned: (version: number | null) => void;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveLink, setDriveLink] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [refineBusy, setRefineBusy] = useState(false);
  const refineInFlightRef = useRef(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [learnBusy, setLearnBusy] = useState(false);
  const [learnError, setLearnError] = useState<string | null>(null);
  const { body: scriptBody, sourcesTail } = useMemo(
    () => splitScriptBody(script.fullText),
    [script.fullText],
  );
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState(scriptBody);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Whenever the server-side script changes (refine, undo, save edit),
  // resync the draft so a subsequent enter-edit-mode shows the latest body.
  useEffect(() => {
    setDraft(scriptBody);
  }, [scriptBody]);

  // Derived from server state: the current version is "saved" when the run's
  // recorded lastDistilledVersion matches the current refineHistory length.
  // This survives reloads — no local state to reset.
  const currentVersion = refineHistory.length;
  const isLearnedForCurrentVersion = lastDistilledVersion === currentVersion;
  useEffect(() => {
    setLearnError(null);
  }, [currentVersion]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(script.fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [script.fullText]);

  const saveToDrive = useCallback(async () => {
    setDriveLoading(true);
    setDriveError(null);
    try {
      const headlineMatch = script.fullText.match(/\[A BLOCK\]\s*HOST:\s*(.+?)(?:\n|$)/);
      const headline = headlineMatch?.[1]?.slice(0, 80) || `News Script ${chatId.slice(0, 8)}`;
      const res = await fetch('/api/news/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scriptText: script.fullText,
          title: headline,
          date: todayISO(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDriveError(data.error || 'Upload failed');
        return;
      }
      setDriveLink(data.driveUrl);
    } catch (err) {
      setDriveError(String(err).slice(0, 200));
    } finally {
      setDriveLoading(false);
    }
  }, [script.fullText, chatId]);

  const refine = useCallback(async () => {
    const trimmed = instruction.trim();
    if (!trimmed || refineBusy || learnBusy || undoBusy || refineInFlightRef.current) return;
    refineInFlightRef.current = true;
    setRefineBusy(true);
    setRefineError(null);
    setDriveLink(null);
    try {
      const res = await fetch('/api/news/orchestrator/refine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, instruction: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefineError(data.detail || data.error || 'Refine failed');
        return;
      }
      onScriptUpdated(data.script as Script, data.refineHistory as RefineEntry[]);
      setInstruction('');
    } catch (err) {
      setRefineError(String(err).slice(0, 200));
    } finally {
      refineInFlightRef.current = false;
      setRefineBusy(false);
    }
  }, [chatId, instruction, refineBusy, learnBusy, undoBusy, onScriptUpdated]);

  const saveLearn = useCallback(async () => {
    if (learnBusy || refineBusy || undoBusy || !canUndo) return;
    setLearnBusy(true);
    setLearnError(null);
    try {
      const res = await fetch('/api/news/orchestrator/save-learn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLearnError(data.detail || data.error || 'Save & learn failed');
        return;
      }
      if (typeof data.lastDistilledVersion === 'number') {
        onLearned(data.lastDistilledVersion);
      }
    } catch (err) {
      setLearnError(String(err).slice(0, 200));
    } finally {
      setLearnBusy(false);
    }
  }, [chatId, learnBusy, refineBusy, undoBusy, canUndo, onLearned]);

  const undo = useCallback(async () => {
    if (undoBusy || refineBusy || learnBusy || !canUndo) return;
    setUndoBusy(true);
    setRefineError(null);
    setDriveLink(null);
    try {
      const res = await fetch('/api/news/orchestrator/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRefineError(data.detail || data.error || 'Undo failed');
        return;
      }
      onScriptUpdated(data.script as Script, data.refineHistory as RefineEntry[]);
      // Server clears lastDistilledVersion if undo went past it — propagate
      // so the UI re-shows "Save & learn" for the restored version.
      if ('lastDistilledVersion' in data) {
        onLearned(
          typeof data.lastDistilledVersion === 'number' ? data.lastDistilledVersion : null,
        );
      }
    } catch (err) {
      setRefineError(String(err).slice(0, 200));
    } finally {
      setUndoBusy(false);
    }
  }, [chatId, undoBusy, refineBusy, learnBusy, canUndo, onScriptUpdated, onLearned]);

  const saveEdit = useCallback(async () => {
    if (editBusy || refineBusy || undoBusy || learnBusy) return;
    const trimmedBody = draft.trimEnd();
    if (!trimmedBody.trim()) {
      setEditError('Script cannot be empty.');
      return;
    }
    // Reattach the locked sources tail (starts with "\n---\nSOURCES:\n…").
    const recombined = trimmedBody + sourcesTail;
    if (recombined.trim() === script.fullText.trim()) {
      setEditMode(false);
      return;
    }
    setEditBusy(true);
    setEditError(null);
    setDriveLink(null);
    try {
      const res = await fetch('/api/news/orchestrator/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, fullText: recombined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEditError(data.detail || data.error || 'Save failed');
        return;
      }
      onScriptUpdated(data.script as Script, data.refineHistory as RefineEntry[]);
      setEditMode(false);
    } catch (err) {
      setEditError(String(err).slice(0, 200));
    } finally {
      setEditBusy(false);
    }
  }, [chatId, draft, sourcesTail, editBusy, refineBusy, undoBusy, learnBusy, script.fullText, onScriptUpdated]);

  const cancelEdit = useCallback(() => {
    if (editBusy) return;
    setDraft(scriptBody);
    setEditError(null);
    setEditMode(false);
  }, [editBusy, scriptBody]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
        <span className="font-semibold">Script ready.</span> {script.metadata.wordCount} words ·{' '}
        {script.metadata.blockCount} blocks · {script.metadata.citedSources} sources cited
        {currentVersion > 0 ? (
          <span className="ml-2 rounded bg-emerald-400/20 px-1.5 py-0.5 font-mono text-[0.65rem] uppercase tracking-wider">
            v{currentVersion}
          </span>
        ) : null}
      </div>

      <div className="rounded-2xl border border-overlay/10 bg-overlay/[0.02] p-6">
        {editMode ? (
          <div className="flex flex-col gap-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={editBusy}
              spellCheck
              className="w-full min-h-[60vh] rounded-md border border-overlay/15 ark-recessed px-3 py-2 font-mono text-sm leading-6 text-fg/90 placeholder:text-fg/30 focus:border-overlay/30 focus:outline-none disabled:opacity-60"
            />
            {sourcesTail ? (
              <div className="rounded-md border border-overlay/[0.06] ark-recessed-soft p-4">
                <div className="prose prose-invert max-w-none text-sm text-fg/60">
                  <MarkdownRenderer text={sourcesTail.trimStart()} components={scriptMarkdownComponents} />
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="prose prose-invert max-w-none text-fg/90">
            <MarkdownRenderer text={script.fullText} components={scriptMarkdownComponents} />
          </div>
        )}
      </div>

      {editMode ? (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={saveEdit}
            disabled={editBusy || !draft.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/20 px-4 py-2 text-sm text-emerald-200 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {editBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {editBusy ? 'Saving…' : 'Save changes'}
          </button>
          <button
            onClick={cancelEdit}
            disabled={editBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-overlay/15 px-4 py-2 text-sm text-fg/70 transition hover:border-overlay/30 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <XCircle className="h-4 w-4" /> Cancel
          </button>
          {editError ? (
            <div className="basis-full rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {editError}
            </div>
          ) : null}
        </div>
      ) : (
      <div className="flex flex-wrap gap-2">
        <button
          onClick={copy}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/20 px-4 py-2 text-sm text-emerald-200 transition hover:bg-emerald-500/30"
        >
          {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy to clipboard'}
        </button>
        <button
          onClick={saveToDrive}
          disabled={driveLoading || driveLink !== null}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-500/20 px-4 py-2 text-sm text-blue-200 transition hover:bg-blue-500/30 disabled:opacity-50"
        >
          {driveLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : driveLink ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <HardDriveUpload className="h-4 w-4" />
          )}
          {driveLink ? 'Saved to Drive' : driveLoading ? 'Uploading…' : 'Save to Drive'}
        </button>
        {driveLink ? (
          <a
            href={driveLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-overlay/15 px-4 py-2 text-sm text-fg/70 transition hover:border-overlay/30 hover:text-fg"
          >
            Open in Drive <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
        <button
          onClick={saveLearn}
          disabled={
            learnBusy ||
            !canUndo ||
            isLearnedForCurrentVersion ||
            refineBusy ||
            undoBusy
          }
          title={
            !canUndo
              ? 'Refine the script at least once before saving.'
              : isLearnedForCurrentVersion
                ? 'Distilled. The writer-style profile has been updated.'
                : refineBusy || undoBusy
                  ? 'Wait for the current edit to finish.'
                  : 'Distill recurring style preferences from your edits into the writer profile.'
          }
          className="inline-flex items-center gap-2 rounded-lg bg-purple-500/20 px-4 py-2 text-sm text-purple-200 transition hover:bg-purple-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {learnBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isLearnedForCurrentVersion ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <BookOpenCheck className="h-4 w-4" />
          )}
          {isLearnedForCurrentVersion
            ? 'Saved & learned'
            : learnBusy
              ? 'Learning…'
              : 'Save & learn'}
        </button>
        <button
          onClick={() => {
            setDraft(scriptBody);
            setEditError(null);
            setEditMode(true);
          }}
          disabled={refineBusy || undoBusy || learnBusy}
          title="Hand-edit the script text directly."
          className="inline-flex items-center gap-2 rounded-lg border border-overlay/15 px-4 py-2 text-sm text-fg/70 transition hover:border-overlay/30 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Pencil className="h-4 w-4" /> Edit text
        </button>
        <button
          onClick={onEdit}
          className="inline-flex items-center gap-2 rounded-lg border border-overlay/15 px-4 py-2 text-sm text-fg/70 transition hover:border-overlay/30 hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" /> Edit topics & regenerate
        </button>
      </div>
      )}

      {driveError ? (
        <div className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {driveError}
        </div>
      ) : null}

      {learnError ? (
        <div className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {learnError}
        </div>
      ) : null}

      {editMode ? null : (
      <div className="rounded-2xl border border-overlay/10 bg-overlay/[0.02] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg">Refine the script</h3>
          {canUndo ? (
            <button
              onClick={undo}
              disabled={undoBusy || refineBusy || learnBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-overlay/15 px-2.5 py-1 text-xs text-fg/70 transition hover:border-overlay/30 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              title="Revert to the previous version"
            >
              {undoBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
              Undo last edit
            </button>
          ) : null}
        </div>

        {refineHistory.length > 0 ? (
          <ul className="mb-3 flex flex-col gap-1.5">
            {refineHistory.map((entry) => (
              <li
                key={`${entry.version}-${entry.at}`}
                className="flex items-start gap-2 rounded-md border border-overlay/[0.06] bg-overlay/[0.02] px-3 py-1.5 text-xs text-fg/70"
              >
                <span className="mt-0.5 shrink-0 rounded bg-sky-brand/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-sky-brand-soft">
                  v{entry.version - 1} → v{entry.version}
                </span>
                <span className="min-w-0">{entry.instruction}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-col gap-2">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                refine();
              }
            }}
            placeholder="What should change? (e.g., 'Tighten the B block' or 'Drop the cricket reference')"
            rows={2}
            disabled={refineBusy || learnBusy || undoBusy}
            className="w-full rounded-md border border-overlay/15 ark-recessed px-3 py-2 text-sm text-fg placeholder:text-fg/30 disabled:opacity-60"
          />
          <div className="flex items-center justify-between">
            <span className="text-[0.7rem] text-fg/40">
              {refineBusy ? 'Revising — usually 30–60 seconds…' : 'Cmd/Ctrl+Enter to send'}
            </span>
            <button
              onClick={refine}
              disabled={refineBusy || learnBusy || undoBusy || !instruction.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-brand px-3 py-1.5 text-xs font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refineBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Apply edit
            </button>
          </div>
          {refineError ? (
            <div className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {refineError}
            </div>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}
