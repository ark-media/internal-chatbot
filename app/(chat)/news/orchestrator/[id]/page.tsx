'use client';

import { useCallback, useEffect, useState } from 'react';
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
} from 'lucide-react';

import { Header } from '@/components/Header';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { cn } from '@/lib/cn';
import type {
  DistillResult,
  OrchestratorRun,
  RatedArticle,
  Script,
  TopicWithSources,
} from '@/lib/orchestrator/types';

type StartResponse =
  | { stage: 'checkpoint'; distill: DistillResult; articleCount: number }
  | { stage: 'error'; errorMessage: string };

type RefetchResponse =
  | { stage: 'checkpoint'; distill: DistillResult; addedCount: number }
  | { error: string };

type GenerateResponse =
  | { stage: 'complete'; script: Script; iterations: number }
  | { stage: 'error'; errorMessage: string };

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function OrchestratorPage() {
  const params = useParams<{ id: string }>();
  const chatId = params?.id;
  if (!chatId) return null;
  return <OrchestratorBody chatId={chatId} />;
}

function OrchestratorBody({ chatId }: { chatId: string }) {
  const [run, setRun] = useState<OrchestratorRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'start' | 'refetch' | 'generate'>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string>(todayISO());
  const [rejectedTopics, setRejectedTopics] = useState<Set<number>>(new Set());

  // Load existing run on mount.
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

  const startGathering = useCallback(async () => {
    setBusy('start');
    setError(null);
    try {
      const res = await fetch('/api/news/orchestrator/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId,
          today,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
        }),
      });
      const data = (await res.json()) as StartResponse;
      if (data.stage === 'error') {
        setError(data.errorMessage);
        return;
      }
      // Re-fetch the full run so all metadata (articles, etc.) is in sync.
      const fresh = await fetch(`/api/news/orchestrator/${chatId}`).then((r) => r.json());
      setRun(fresh.run);
      setRejectedTopics(new Set());
    } catch (err) {
      setError(String(err).slice(0, 300));
    } finally {
      setBusy(null);
    }
  }, [chatId, today]);

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
        const data = (await res.json()) as RefetchResponse;
        if ('error' in data) {
          setError(data.error);
          return;
        }
        const fresh = await fetch(`/api/news/orchestrator/${chatId}`).then((r) => r.json());
        setRun(fresh.run);
      } catch (err) {
        setError(String(err).slice(0, 300));
      } finally {
        setBusy(null);
      }
    },
    [chatId],
  );

  const generate = useCallback(async () => {
    if (!run?.distill) return;
    setBusy('generate');
    setError(null);
    const indices = run.distill.topics
      .map((_, i) => i)
      .filter((i) => !rejectedTopics.has(i));
    if (indices.length === 0) {
      setError('Approve at least one topic before generating.');
      setBusy(null);
      return;
    }
    try {
      const res = await fetch('/api/news/orchestrator/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, approvedTopicIndices: indices }),
      });
      const data = (await res.json()) as GenerateResponse;
      if (data.stage === 'error') {
        setError(data.errorMessage);
        return;
      }
      const fresh = await fetch(`/api/news/orchestrator/${chatId}`).then((r) => r.json());
      setRun(fresh.run);
    } catch (err) {
      setError(String(err).slice(0, 300));
    } finally {
      setBusy(null);
    }
  }, [chatId, run, rejectedTopics]);

  if (loading) {
    return (
      <div className="flex flex-1 flex-col">
        <Header variant="news" />
        <main className="flex flex-1 items-center justify-center text-white/50">
          <Loader2 className="h-5 w-5 animate-spin" />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header variant="news" />
      <main className="relative flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
          <div className="flex items-baseline justify-between">
            <h1 className="text-2xl font-bold text-white" style={{ fontFamily: 'var(--font-display)' }}>
              News Script <span className="text-[#3eb5f9]">Orchestrator</span>
            </h1>
            <div className="text-xs uppercase tracking-[0.22em] text-white/45">
              {run?.stage ?? 'idle'}
            </div>
          </div>
          <p className="text-sm text-white/60">
            Automated end-to-end script generation. Sources are gathered and ranked, you validate
            the topic selection, then the script is drafted and refined.
          </p>

          {error ? (
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          {run === null || run.stage === 'error' ? (
            <StartCard
              today={today}
              onTodayChange={setToday}
              onStart={startGathering}
              busy={busy === 'start'}
              previousError={run?.stage === 'error' ? run.errorMessage : null}
            />
          ) : null}

          {busy === 'start' && run?.stage !== 'checkpoint' ? (
            <ProgressCard
              label="Gathering sources & distilling topics…"
              detail="Searching Google, extracting articles via Tavily, then ranking by newsworthiness. This usually takes 60–120 seconds."
            />
          ) : null}

          {run && run.stage === 'checkpoint' && run.distill ? (
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
              busy={busy}
            />
          ) : null}

          {busy === 'generate' ? (
            <ProgressCard
              label="Drafting script & running editorial review…"
              detail="Sonnet writes the first draft, then Opus reviews against the editorial checklist. Up to 3 review iterations. Typically 60–180 seconds."
            />
          ) : null}

          {run && run.stage === 'complete' && run.finalScript ? (
            <ScriptView script={run.finalScript} iterations={run.iterations} chatId={chatId} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function StartCard({
  today,
  onTodayChange,
  onStart,
  busy,
  previousError,
}: {
  today: string;
  onTodayChange: (v: string) => void;
  onStart: () => void;
  busy: boolean;
  previousError: string | null;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      {previousError ? (
        <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          Previous run failed: {previousError}
        </div>
      ) : null}
      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-white/70" htmlFor="today">
          Recording date
        </label>
        <input
          id="today"
          type="date"
          value={today}
          onChange={(e) => onTodayChange(e.target.value)}
          className="rounded-md border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
        />
      </div>
      <button
        onClick={onStart}
        disabled={busy}
        className={cn(
          'inline-flex items-center gap-2 rounded-lg bg-[#3eb5f9] px-4 py-2.5 text-sm font-semibold text-[#070b22]',
          'transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {busy ? 'Starting…' : 'Start gathering sources'}
      </button>
    </div>
  );
}

function ProgressCard({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="flex items-center gap-3 text-white">
        <Loader2 className="h-5 w-5 animate-spin text-[#3eb5f9]" />
        <span className="font-medium">{label}</span>
      </div>
      <p className="mt-2 text-sm text-white/50">{detail}</p>
    </div>
  );
}

function CheckpointView({
  distill,
  rejectedTopics,
  onToggleReject,
  onRefetch,
  onGenerate,
  busy,
}: {
  distill: DistillResult;
  rejectedTopics: Set<number>;
  onToggleReject: (index: number) => void;
  onRefetch: (index: number, guidance: string) => void;
  onGenerate: () => void;
  busy: null | 'start' | 'refetch' | 'generate';
}) {
  const approvedCount = distill.topics.length - rejectedTopics.size;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-white/70">
        <span className="font-semibold text-white">Distill rationale: </span>
        {distill.rationale}
      </div>

      {distill.topics.map((topic, i) => (
        <TopicCard
          key={i}
          topic={topic}
          index={i}
          rejected={rejectedTopics.has(i)}
          onToggleReject={() => onToggleReject(i)}
          onRefetch={(guidance) => onRefetch(i, guidance)}
          busy={busy}
        />
      ))}

      <div className="sticky bottom-0 -mx-6 mt-2 border-t border-white/10 bg-[#0b153c]/90 px-6 py-4 backdrop-blur">
        <button
          onClick={onGenerate}
          disabled={busy !== null || approvedCount === 0}
          className={cn(
            'w-full rounded-lg bg-[#3eb5f9] px-4 py-3 text-sm font-semibold text-[#070b22]',
            'transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {busy === 'generate' ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Generating script…
            </span>
          ) : (
            `Approve ${approvedCount} topic${approvedCount === 1 ? '' : 's'} → generate script`
          )}
        </button>
      </div>
    </div>
  );
}

function TopicCard({
  topic,
  index,
  rejected,
  onToggleReject,
  onRefetch,
  busy,
}: {
  topic: TopicWithSources;
  index: number;
  rejected: boolean;
  onToggleReject: () => void;
  onRefetch: (guidance: string) => void;
  busy: null | 'start' | 'refetch' | 'generate';
}) {
  const [showRefetch, setShowRefetch] = useState(false);
  const [guidance, setGuidance] = useState('');

  return (
    <div
      className={cn(
        'rounded-2xl border p-5 transition',
        rejected
          ? 'border-white/5 bg-white/[0.01] opacity-50'
          : 'border-white/10 bg-white/[0.03]',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md border border-[#3eb5f9]/30 bg-[#3eb5f9]/10 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[#79cdfc]">
              Topic {index + 1}
            </span>
            <h3 className="text-base font-bold text-white">{topic.topic}</h3>
          </div>
          <p className="mt-1 text-sm text-white/60">{topic.description}</p>
        </div>
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
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve
            </>
          ) : (
            <>
              <XCircle className="h-3.5 w-3.5" /> Reject
            </>
          )}
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {topic.articles.map((rated, i) => (
          <SourceRow key={i} rated={rated} />
        ))}
      </div>

      {!rejected ? (
        <div className="mt-4 border-t border-white/10 pt-3">
          {showRefetch ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder="What should I look for? (e.g., 'I read about a new IDF statement on this — find more on that angle')"
                rows={2}
                className="w-full rounded-md border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30"
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
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#3eb5f9]/20 px-3 py-1.5 text-xs text-[#3eb5f9] transition hover:bg-[#3eb5f9]/30 disabled:cursor-not-allowed disabled:opacity-50"
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
                  className="rounded-md px-3 py-1.5 text-xs text-white/60 hover:bg-white/5 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowRefetch(true)}
              className="inline-flex items-center gap-1.5 text-xs text-white/50 transition hover:text-white"
            >
              <Plus className="h-3 w-3" /> Request more sources for this topic
            </button>
          )}
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
        'group flex items-start gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 transition',
        'hover:border-white/15 hover:bg-white/[0.04]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[0.7rem] uppercase tracking-wider text-white/45">{a.source}</span>
          {a.publicationDate ? (
            <span className="text-[0.7rem] text-white/35">{a.publicationDate.slice(0, 10)}</span>
          ) : null}
          {flagged ? (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wider text-amber-200">
              {a.fetchError ? 'fetch failed' : 'outside window'}
            </span>
          ) : null}
        </div>
        <div className="truncate text-sm text-white/85">{a.title}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-[0.7rem] text-white/45">avg {rated.avgScore}</div>
        <div className="font-mono text-[0.65rem] text-white/30">
          r{rated.relevance}/c{rated.credibility}/co{rated.completeness}
        </div>
      </div>
      <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-white/30 transition group-hover:text-white/60" />
    </a>
  );
}

function ScriptView({
  script,
  iterations,
  chatId,
}: {
  script: Script;
  iterations: number;
  chatId: string;
}) {
  const [copied, setCopied] = useState(false);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveLink, setDriveLink] = useState<string | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
        <span className="font-semibold">Script ready.</span> Generated in {iterations} review
        iteration{iterations === 1 ? '' : 's'} · {script.metadata.wordCount} words ·{' '}
        {script.metadata.blockCount} blocks · {script.metadata.citedSources} citations ·{' '}
        {script.metadata.flagCount} flag{script.metadata.flagCount === 1 ? '' : 's'}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <div className="prose prose-invert max-w-none text-white/90">
          <MarkdownRenderer text={script.fullText} />
        </div>
      </div>

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
          {driveLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDriveUpload className="h-4 w-4" />}
          {driveLink ? 'Saved to Drive' : driveLoading ? 'Uploading…' : 'Save to Drive'}
        </button>
        {driveLink ? (
          <a
            href={driveLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 transition hover:border-white/30 hover:text-white"
          >
            Open in Drive <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {driveError ? <span className="text-sm text-red-300">{driveError}</span> : null}
      </div>
    </div>
  );
}
