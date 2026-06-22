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
  GripVertical,
  X,
  Search,
  AtSign,
  ChevronDown,
  ChevronRight,
  FileText,
  Upload,
  Wand2,
} from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { Components } from 'react-markdown';

import { Header } from '@/components/Header';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { KindBadge } from '@/components/ui/KindBadge';
import { notifyChatUpdated } from '@/lib/chat-refresh';
import { cn } from '@/lib/cn';
import { takeCompleteLines } from '@/lib/orchestrator/ndjson';
import {
  renumberIndicesAfterDelete,
  type Candidate,
  type DistillResult,
  type NarrativeArc,
  type OrchestratorRun,
  type RatedArticle,
  type RefineEntry,
  type Script,
  type TopicWithSources,
} from '@/lib/orchestrator/types';

type StartMode = 'document' | 'discover';

// Which in-flight request, if any, is blocking the orchestrator UI. `null`
// means idle — only one orchestrator request runs at a time, so this doubles
// as a global lock.
type BusyState =
  | null
  | 'start'
  | 'extract'
  | 'arrange'
  | 'deepen'
  | 'refetch'
  | 'generate'
  | 'topics'
  | 'attach'
  | 'group'
  | 'regroup'
  | 'triage';

type StartResponse =
  | { stage: 'checkpoint'; distill: DistillResult; articleCount: number }
  | { stage: 'triage'; candidateCount: number }
  | { stage: 'extracting' }
  | { stage: 'error'; errorMessage: string };

// One story as it streams from /extract (display-only — no server id yet).
type StreamingStory = { headline: string; sources?: { url?: string }[] };

// NDJSON messages the streaming /extract route emits, one per line.
type ExtractStreamMessage =
  | { type: 'story'; story: StreamingStory }
  | { type: 'done' }
  | { type: 'error'; message: string };

type ArrangeResponse =
  | { stage: 'arranged'; arc: NarrativeArc }
  | { stage: 'checkpoint'; distill: DistillResult }
  | { stage: 'error'; errorMessage: string }
  | { error: string };

type GenerateResponse =
  | { stage: 'complete'; script: Script; iterations: number }
  | { stage: 'error' | 'checkpoint'; errorMessage: string };

type TopicsResponse = { stage: 'checkpoint'; distill: DistillResult } | { error: string };

function stageLabel(stage: OrchestratorRun['stage'] | undefined): string {
  switch (stage) {
    case 'gathering':
      return 'Pulling stories';
    case 'extracting':
      return 'Reading dossier';
    case 'arranged':
      return 'Review & arrange';
    case 'triage':
      return 'Triage articles';
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
  const [busy, setBusy] = useState<BusyState>(null);
  const generateInFlightRef = useRef(false);
  // Tracks the in-flight /topics request so a writer can cancel a slow
  // source-gather. One controller is enough — `busy` is global, so only one
  // /topics request runs at a time.
  const topicAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string>(todayISO());
  const [rejectedTopics, setRejectedTopics] = useState<Set<number>>(new Set());
  // After a script is complete, the writer can pop back into the checkpoint
  // editor without losing the script. Local-only — survives until refresh.
  const [editingFromComplete, setEditingFromComplete] = useState(false);
  // Document flow back-nav: force the upload card to show even though a run
  // exists, so the editor can discard the current dossier and upload another.
  const [forceStart, setForceStart] = useState(false);
  // Stories streaming in from /extract, shown progressively while busy. Null
  // once extraction lands and the authoritative run is loaded.
  const [extractStream, setExtractStream] = useState<StreamingStory[] | null>(null);
  // The deferred arc suggestion is computing in the background (off the global
  // busy lock so the editor can keep working on the merged screen).
  const [arcSuggesting, setArcSuggesting] = useState(false);
  // Which run we've already kicked off the background arc suggestion for, so the
  // auto-trigger fires once per extraction (reset on a fresh upload).
  const arcSuggestedForRef = useRef<string | null>(null);

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

  // The start picker now only initiates 'discover'; the /start route still
  // accepts 'urls'/'topics', but those are no longer reachable from this screen
  // (topics are added later, at the checkpoint, via a different endpoint).
  const start = useCallback(
    async (payload: { mode: 'discover' }) => {
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

  // Document flow: create the run shell, then upload the dossier to /extract,
  // which streams stories back (NDJSON) as it parses them and persists the run
  // on 'arranged' before closing. We show stories progressively via
  // `extractStream`, then refresh to the authoritative run. The arc suggestion
  // is deferred and triggered separately. One busy lock ('extract') spans it.
  const startDocument = useCallback(
    async (file: File) => {
      setBusy('extract');
      setError(null);
      setForceStart(false);
      setRejectedTopics(new Set());
      setExtractStream([]);
      // A fresh upload should re-trigger the background arc suggestion.
      arcSuggestedForRef.current = null;
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
        const startRes = await fetch('/api/news/orchestrator/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, today, timezone: tz, mode: 'document' }),
        });
        const startData = (await startRes.json()) as StartResponse;
        if (startData.stage === 'error') {
          setError(startData.errorMessage);
          return;
        }
        notifyChatUpdated();

        const form = new FormData();
        form.append('chatId', chatId);
        form.append('file', file);
        const res = await fetch('/api/news/orchestrator/extract', { method: 'POST', body: form });
        if (!res.ok || !res.body) {
          setError(`Extraction failed (${res.status}).`);
          await refresh();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const stories: StreamingStory[] = [];
        let buf = '';
        let streamError: string | null = null;
        // Read NDJSON lines; each is a complete message. Stories accumulate for
        // live display; 'done'/'error' end the stream.
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { lines, rest } = takeCompleteLines(buf);
          buf = rest;
          for (const ln of lines) {
            let msg: ExtractStreamMessage;
            try {
              msg = JSON.parse(ln) as ExtractStreamMessage;
            } catch {
              continue;
            }
            if (msg.type === 'story') {
              stories.push(msg.story);
              setExtractStream([...stories]);
            } else if (msg.type === 'error') {
              streamError = msg.message;
            }
          }
        }
        if (streamError) setError(streamError);
        await refresh();
      } catch (err) {
        setError(String(err).slice(0, 300));
      } finally {
        setExtractStream(null);
        setBusy(null);
      }
    },
    [chatId, today, refresh],
  );

  // Deferred arc suggestion: extraction lands on 'arranged' in dossier order
  // (no model call), then this runs the arc agent in the background and updates
  // run.arc. Kept OFF the global busy lock so the editor can review/reorder
  // while it computes; the merged screen surfaces the result as an apply banner.
  const suggestArcInBackground = useCallback(async () => {
    setArcSuggesting(true);
    try {
      const res = await fetch('/api/news/orchestrator/arrange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, action: 'suggest' }),
      });
      const data = (await res.json()) as ArrangeResponse;
      // A failed suggestion is non-fatal — the editor still has the dossier
      // order to work from, so swallow it rather than surfacing an error.
      if (!('error' in data) && data.stage === 'arranged') {
        await refresh();
      }
    } catch {
      /* non-fatal: the dossier-order arc remains usable */
    } finally {
      setArcSuggesting(false);
    }
  }, [chatId, refresh]);

  // Auto-trigger the suggestion once per extraction, when the run is sitting on
  // the merged screen with the placeholder (dossier-order) arc.
  useEffect(() => {
    if (
      run?.stage === 'arranged' &&
      run.arc &&
      run.arc.rationale === '' &&
      !arcSuggesting &&
      arcSuggestedForRef.current !== chatId
    ) {
      arcSuggestedForRef.current = chatId;
      void suggestArcInBackground();
    }
  }, [run?.stage, run?.arc, chatId, arcSuggesting, suggestArcInBackground]);

  // Document flow "Write script": fold the editor's arc onto the topics
  // (/arrange apply, which advances to checkpoint) then generate — chained under
  // one busy lock so the merged review screen goes straight to the finished
  // script with no intermediate checkpoint view. `approvedIndices` is the
  // non-rejected topic set in arc order; the apply preserves any deepen/refetch
  // edits because it stamps block/transition rather than rebuilding the distill.
  const writeScript = useCallback(
    async (arc: NarrativeArc, approvedIndices: number[]) => {
      if (approvedIndices.length === 0) {
        setError('Keep at least one topic with sources before writing the script.');
        return;
      }
      if (generateInFlightRef.current) return;
      generateInFlightRef.current = true;
      setBusy('generate');
      setError(null);
      try {
        const applyRes = await fetch('/api/news/orchestrator/arrange', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, action: 'apply', arc }),
        });
        const applyData = (await applyRes.json()) as ArrangeResponse;
        if ('error' in applyData) {
          setError(applyData.error);
          return;
        }
        if (applyData.stage === 'error') {
          setError(applyData.errorMessage);
          return;
        }
        const genRes = await fetch('/api/news/orchestrator/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, approvedTopicIndices: approvedIndices }),
        });
        const genData = (await genRes.json()) as GenerateResponse;
        if (genData.stage !== 'complete') {
          setError(genData.errorMessage || 'Generation failed.');
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
    },
    [chatId, refresh],
  );

  // Stage 3 — deepen one topic's analysis from its attached sources.
  const deepen = useCallback(
    async (topicIndex: number, guidance: string) => {
      setBusy('deepen');
      setError(null);
      try {
        const res = await fetch('/api/news/orchestrator/deepen', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, topicIndex, guidance }),
        });
        const data = await res.json();
        if ('error' in data) {
          setError(data.detail || data.error);
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

  // Triage → checkpoint: run the AI grouping pass over the surviving articles.
  const group = useCallback(async () => {
    setBusy('group');
    setError(null);
    try {
      const res = await fetch('/api/news/orchestrator/group', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, mode: 'group' }),
      });
      const data = await res.json();
      if ('error' in data) {
        setError(data.detail || data.error);
        return;
      }
      await refresh();
      setRejectedTopics(new Set());
    } catch (err) {
      setError(String(err).slice(0, 300));
    } finally {
      setBusy(null);
    }
  }, [chatId, refresh]);

  // Checkpoint → triage: drop the grouping and go back to the raw pool. Fast
  // (no model call), so no ProgressCard — `'regroup'` just holds the lock.
  const regroup = useCallback(async () => {
    setBusy('regroup');
    setError(null);
    try {
      const res = await fetch('/api/news/orchestrator/group', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, mode: 'regroup' }),
      });
      const data = await res.json();
      if ('error' in data) {
        setError(data.detail || data.error);
        return;
      }
      await refresh();
      setRejectedTopics(new Set());
    } catch (err) {
      setError(String(err).slice(0, 300));
    } finally {
      setBusy(null);
    }
  }, [chatId, refresh]);

  // Triage edits update the local candidate list optimistically for snappy
  // drag feedback, then persist. The /triage route CAS-writes, so a lost race
  // surfaces as an error and the follow-up refresh pulls the server truth.
  const triageEdit = useCallback(
    async (
      optimistic: Candidate[],
      payload:
        | { action: 'reorder'; order: string[] }
        | { action: 'remove'; url: string }
        | { action: 'removeMany'; urls: string[] }
        | { action: 'add'; candidate: Candidate },
    ) => {
      setError(null);
      setRun((prev) => (prev ? { ...prev, candidates: optimistic } : prev));
      setBusy('triage');
      try {
        const res = await fetch('/api/news/orchestrator/triage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, ...payload }),
        });
        const data = await res.json();
        if ('error' in data) {
          setError(data.detail || data.error);
        }
        // Either way, resync to the persisted truth — corrects a rejected
        // optimistic update and refreshes `updatedAt` for the next edit.
        await refresh();
      } catch (err) {
        setError(String(err).slice(0, 300));
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [chatId, refresh],
  );

  const reorderArticles = useCallback(
    (next: Candidate[]) =>
      triageEdit(next, { action: 'reorder', order: next.map((c) => c.url) }),
    [triageEdit],
  );

  const removeArticle = useCallback(
    (url: string) => {
      const next = (run?.candidates ?? []).filter((c) => c.url !== url);
      return triageEdit(next, { action: 'remove', url });
    },
    [run, triageEdit],
  );

  // Discard a whole theme group at once — one CAS write for the cluster.
  const removeGroup = useCallback(
    (urls: string[]) => {
      const drop = new Set(urls);
      const next = (run?.candidates ?? []).filter((c) => !drop.has(c.url));
      return triageEdit(next, { action: 'removeMany', urls });
    },
    [run, triageEdit],
  );

  // Keyword search is read-only — it doesn't touch the run, so it stays off
  // the global busy lock and the search panel owns its own loading state.
  const searchArticles = useCallback(
    async (query: string): Promise<Candidate[]> => {
      const res = await fetch('/api/news/orchestrator/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, query }),
      });
      const data = await res.json();
      if ('error' in data) throw new Error(data.detail || data.error);
      return data.hits as Candidate[];
    },
    [chatId],
  );

  // Pulling X posts is read-only too — same as keyword search, it returns
  // candidates the writer can add but doesn't touch the run itself, so the
  // X panel owns its own loading state.
  const pullXPosts = useCallback(async (): Promise<Candidate[]> => {
    const res = await fetch('/api/news/orchestrator/x-posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId }),
    });
    const data = await res.json();
    if ('error' in data) throw new Error(data.detail || data.error);
    return data.hits as Candidate[];
  }, [chatId]);

  // Adding a search hit is just an append — extraction is deferred to /group —
  // so it updates optimistically like reorder and remove. When the candidate
  // came from the "See more" overflow, drop it from `extraCandidates` in the
  // same optimistic step so it doesn't briefly render in both lists; the
  // server-side `add` handler does the same on the persisted run.
  const addArticle = useCallback(
    (candidate: Candidate) => {
      const existing = run?.candidates ?? [];
      if (existing.some((c) => c.url === candidate.url)) return Promise.resolve();
      setRun((prev) => {
        if (!prev || !prev.extraCandidates) return prev;
        if (!prev.extraCandidates.some((c) => c.url === candidate.url)) return prev;
        return {
          ...prev,
          extraCandidates: prev.extraCandidates.filter((c) => c.url !== candidate.url),
        };
      });
      return triageEdit([...existing, candidate], { action: 'add', candidate });
    },
    [run, triageEdit],
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
      const controller = new AbortController();
      topicAbortRef.current = controller;
      try {
        const res = await fetch('/api/news/orchestrator/topics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, ...payload }),
          signal: controller.signal,
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
        // A writer-initiated cancel isn't an error — unwind quietly. The
        // server bails before committing, so there's nothing to refresh.
        if (controller.signal.aborted) return false;
        setError(String(err).slice(0, 300));
        return false;
      } finally {
        topicAbortRef.current = null;
        setBusy(null);
      }
    },
    [chatId, refresh],
  );

  // Aborts an in-flight /topics gather. No-op when nothing is running.
  const cancelTopicAction = useCallback(() => {
    topicAbortRef.current?.abort();
  }, []);

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

  // Decide which view to show. A document run is identifiable by its extracted
  // stories; it uses the single merged review screen and never the checkpoint.
  const isDocRun = !!run?.extractedStories?.length;
  const showStart = run === null || run.stage === 'error' || forceStart;
  // The merged review-and-arrange screen: at 'arranged', or when reopening a
  // finished doc run to revise it.
  const showArrange =
    !showStart &&
    run !== null &&
    !!run.arc &&
    !!run.distill &&
    (run.stage === 'arranged' ||
      (isDocRun && run.stage === 'complete' && editingFromComplete));
  const showTriage = !showStart && run !== null && run.stage === 'triage';
  const showCheckpoint =
    !showStart &&
    run !== null &&
    !isDocRun &&
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
            Upload a research dossier to extract and arrange the stories, then deepen and write the
            script. Or discover today&rsquo;s top stories and triage them yourself.
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
              onStartDocument={startDocument}
              busy={busy === 'start' || busy === 'extract'}
              previousError={run?.stage === 'error' ? run.errorMessage : null}
            />
          ) : null}

          {busy === 'start' && !showCheckpoint && !showTriage ? (
            <ProgressCard
              label="Setting up your run…"
              detail="Pulling today's top stories into a raw list for you to triage. This is usually quick."
            />
          ) : null}

          {busy === 'extract' || run?.stage === 'extracting' ? (
            extractStream && extractStream.length > 0 ? (
              <StreamingExtractView stories={extractStream} />
            ) : (
              <ProgressCard
                label="Reading your dossier…"
                detail="Parsing the document and pulling out each story — sources, dry facts, and the Ark analysis of why it matters. Stories will appear here as they're found."
              />
            )
          ) : null}

          {showArrange && run?.arc && run?.distill ? (
            <MergedReviewView
              distill={run.distill}
              arc={run.arc}
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
              onDeepen={deepen}
              onTopicAction={topicAction}
              onCancelTopicAction={cancelTopicAction}
              onAttach={attachUrls}
              onWrite={writeScript}
              onBack={() => {
                if (
                  run?.finalScript &&
                  !window.confirm(
                    'Upload a different dossier? Your current stories and script for this run will be replaced.',
                  )
                ) {
                  return;
                }
                setForceStart(true);
              }}
              busy={busy}
              arcSuggesting={arcSuggesting}
              regenerating={editingFromComplete}
              onCancelEdit={editingFromComplete ? () => setEditingFromComplete(false) : null}
            />
          ) : null}

          {showTriage && run ? (
            <TriageView
              candidates={run.candidates}
              extraCandidates={run.extraCandidates ?? []}
              onReorder={reorderArticles}
              onRemove={removeArticle}
              onRemoveGroup={removeGroup}
              onSearch={searchArticles}
              onPullXPosts={pullXPosts}
              onAddCandidate={addArticle}
              onGroup={group}
              busy={busy}
            />
          ) : null}

          {busy === 'group' ? (
            <ProgressCard
              label="Grouping articles into topics…"
              detail="Verifying and extracting each survivor, clustering into topics, scoring sources, and pulling quotes. Typically 60–150 seconds."
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
              onDeepen={deepen}
              onGenerate={generate}
              onTopicAction={topicAction}
              onCancelTopicAction={cancelTopicAction}
              onAttach={attachUrls}
              busy={busy}
              regenerating={editingFromComplete}
              onCancelEdit={editingFromComplete ? () => setEditingFromComplete(false) : null}
              onRegroup={editingFromComplete ? null : regroup}
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
  onStartDocument,
  busy,
  previousError,
}: {
  today: string;
  onTodayChange: (v: string) => void;
  onStart: (p: { mode: 'discover' }) => void;
  onStartDocument: (file: File) => void;
  busy: boolean;
  previousError: string | null;
}) {
  const [mode, setMode] = useState<StartMode>('document');
  const [docFile, setDocFile] = useState<File | null>(null);

  const submit = () => {
    if (mode === 'document') {
      if (docFile) onStartDocument(docFile);
      return;
    }
    return onStart({ mode: 'discover' });
  };

  const canSubmit = mode === 'discover' || docFile !== null;

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
            ['document', 'Upload dossier'],
            ['discover', 'Discover stories'],
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

      {mode === 'document' ? (
        <div className="mb-4 flex flex-col gap-2">
          <label className="text-sm text-fg/70">Upload your research dossier</label>
          <label
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition',
              docFile
                ? 'border-sky-brand/40 bg-sky-brand/[0.04]'
                : 'border-overlay/20 bg-overlay/[0.01] hover:border-overlay/35',
            )}
          >
            <input
              type="file"
              accept=".docx,.md,.markdown,.txt"
              className="hidden"
              onChange={(e) => setDocFile(e.target.files?.[0] ?? null)}
            />
            {docFile ? (
              <>
                <FileText className="h-6 w-6 text-sky-brand" />
                <span className="text-sm font-medium text-fg">{docFile.name}</span>
                <span className="text-xs text-fg/45">Click to choose a different file</span>
              </>
            ) : (
              <>
                <Upload className="h-6 w-6 text-fg/40" />
                <span className="text-sm text-fg/70">Choose a .docx, .md, or .txt file</span>
                <span className="text-xs text-fg/40">
                  Export a Google Doc as Microsoft Word (.docx) to keep its source links.
                </span>
              </>
            )}
          </label>
          <p className="text-xs text-fg/40">
            We&rsquo;ll extract every story — sources, dry facts, and the Ark analysis of why it
            matters — for you to review, arrange, and deepen before writing the script.
          </p>
        </div>
      ) : null}

      {mode === 'discover' ? (
        <p className="mb-4 text-sm text-fg/55">
          Pull today&rsquo;s top stories into a raw list you can triage — rank, prune, and
          search for more — then group what&rsquo;s left into topics.
        </p>
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
          : mode === 'document'
            ? 'Extract & arrange'
            : 'Pull today’s stories'}
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

// Progressive view of stories as they stream in from /extract — turns the long
// extraction wait into something the editor can watch fill in. Display-only;
// the authoritative run loads (and this unmounts) once the stream completes.
function StreamingExtractView({ stories }: { stories: StreamingStory[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-fg">
        <Loader2 className="h-5 w-5 animate-spin text-sky-brand" />
        <span className="font-medium">
          Reading your dossier…{' '}
          <span className="text-fg/55">
            {stories.length} stor{stories.length === 1 ? 'y' : 'ies'} so far
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {stories.map((s, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl border border-overlay/10 bg-overlay/[0.03] px-4 py-3"
          >
            <span className="font-mono text-xs text-fg/40">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
              {s.headline || 'Untitled story'}
            </span>
            {s.sources && s.sources.length > 0 ? (
              <span className="shrink-0 text-xs text-fg/45">
                {s.sources.length} source{s.sources.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Review & arrange (document flow, merged) ----------

const ROLE_LETTERS = ['A', 'B', 'C', 'D'] as const;

// The single document-flow review screen. It folds the old "arrange" affordances
// (drag-reorder, positional A/B/C/D block, transitions) together with the topic
// tools (reject, deepen, refetch, attach, add) onto one list, then writes the
// script. Display order is the editor's local `order` of topic ids; the topic
// tools address `distill.topics` by their current position, and "Write script"
// hands /generate the non-rejected indices in arc order.
function MergedReviewView({
  distill,
  arc,
  rejectedTopics,
  onToggleReject,
  onRefetch,
  onDeepen,
  onTopicAction,
  onCancelTopicAction,
  onAttach,
  onWrite,
  onBack,
  busy,
  arcSuggesting,
  regenerating,
  onCancelEdit,
}: {
  distill: DistillResult;
  arc: NarrativeArc;
  rejectedTopics: Set<number>;
  onToggleReject: (index: number) => void;
  onRefetch: (index: number, guidance: string) => void;
  onDeepen: (index: number, guidance: string) => void;
  onTopicAction: (p: TopicAction) => Promise<boolean>;
  onCancelTopicAction: () => void;
  onAttach: (topicIndex: number, urls: string[]) => void;
  onWrite: (arc: NarrativeArc, approvedIndices: number[]) => void;
  onBack: () => void;
  busy: BusyState;
  // The deferred arc suggestion is still computing in the background.
  arcSuggesting: boolean;
  regenerating: boolean;
  onCancelEdit: (() => void) | null;
}) {
  const topics = distill.topics;
  // Topics in the document flow always carry an id (their source story id, or a
  // uuid if added on this screen); fall back to a positional key defensively.
  const idOf = useCallback(
    (t: TopicWithSources, i: number) => t.id ?? `pos:${i}`,
    [],
  );
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    topics.forEach((t, i) => m.set(idOf(t, i), i));
    return m;
  }, [topics, idOf]);
  const topicById = useMemo(() => {
    const m = new Map<string, TopicWithSources>();
    topics.forEach((t, i) => m.set(idOf(t, i), t));
    return m;
  }, [topics, idOf]);

  // Editor's working order of topic ids, seeded from the suggested arc.
  const [order, setOrder] = useState<string[]>(() => {
    const ids = topics.map(idOf);
    const idSet = new Set(ids);
    const seen = new Set<string>();
    const seq: string[] = [];
    for (const id of arc.order) {
      if (idSet.has(id) && !seen.has(id)) {
        seq.push(id);
        seen.add(id);
      }
    }
    for (const id of ids) if (!seen.has(id)) seq.push(id);
    return seq;
  });
  const [transitions, setTransitions] = useState<Record<string, string>>(arc.transitions);
  const [showAdd, setShowAdd] = useState(false);
  // Which arc suggestion (keyed by its rationale) the editor has already applied
  // or dismissed. Seeded from the arc at mount so an already-applied arc (e.g. a
  // re-edit of a finished run) doesn't nag; a NEW suggestion arriving later
  // (rationale goes from '' to non-empty) surfaces the banner.
  const [dismissedRationale, setDismissedRationale] = useState(arc.rationale);
  // A suggestion is available to apply when the arc has a rationale the editor
  // hasn't acted on yet.
  const suggestionPending = arc.rationale !== '' && arc.rationale !== dismissedRationale;

  // Adopt the suggested arc: re-seed the working order + transitions from it.
  const applySuggestedArc = () => {
    const ids = topics.map(idOf);
    const idSet = new Set(ids);
    const seen = new Set<string>();
    const seq: string[] = [];
    for (const id of arc.order) {
      if (idSet.has(id) && !seen.has(id)) {
        seq.push(id);
        seen.add(id);
      }
    }
    for (const id of ids) if (!seen.has(id)) seq.push(id);
    setOrder(seq);
    setTransitions(arc.transitions);
    setDismissedRationale(arc.rationale);
  };

  // Reconcile the working order whenever topics are added/removed by the tools
  // (each tool refreshes the run). Surviving ids keep the editor's order; new
  // ids append; deleted ids drop. Mirrors the rejectedTopics renumbering.
  const idsKey = topics.map(idOf).join('|');
  useEffect(() => {
    const ids = topics.map(idOf);
    const idSet = new Set(ids);
    setOrder((prev) => {
      const kept = prev.filter((id) => idSet.has(id));
      const added = ids.filter((id) => !kept.includes(id));
      const next = [...kept, ...added];
      const same = next.length === prev.length && next.every((id, i) => id === prev[i]);
      return same ? prev : next;
    });
    // idsKey captures the set+order of topic ids; idOf is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const roleForIndex = (i: number): 'A' | 'B' | 'C' | 'D' => ROLE_LETTERS[Math.min(i, 3)];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const locked = busy !== null;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(String(active.id));
    const newIndex = order.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    setOrder((prev) => arrayMove(prev, oldIndex, newIndex));
  };

  // Topics kept (not rejected) and with at least one source, in arc order.
  const keptCount = order.filter((id) => {
    const idx = indexById.get(id);
    if (idx == null) return false;
    return !rejectedTopics.has(idx) && topics[idx].articles.length > 0;
  }).length;

  const write = () => {
    const arcOut: NarrativeArc = {
      order,
      leadId: order[0] ?? '',
      roles: Object.fromEntries(order.map((id, i) => [id, roleForIndex(i)])),
      transitions,
      rationale: arc.rationale,
    };
    const approved = order
      .map((id) => indexById.get(id))
      .filter((i): i is number => i != null)
      .filter((i) => !rejectedTopics.has(i) && topics[i].articles.length > 0);
    onWrite(arcOut, approved);
  };

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        disabled={busy !== null}
        className="inline-flex items-center gap-1.5 self-start rounded-md border border-overlay/15 px-2.5 py-1 text-xs text-fg/60 transition hover:border-overlay/30 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        title="Discard this run and upload a different dossier"
      >
        <ArrowLeft className="h-3 w-3" /> Upload a different dossier
      </button>

      {regenerating ? (
        <div className="flex items-center justify-between rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <span>
            Editing this run — your previous script is preserved. Click <strong>Write script</strong>{' '}
            to replace it, or <strong>back</strong> to keep it as-is.
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

      {suggestionPending ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-sky-brand/30 bg-sky-brand/10 px-4 py-3 text-sm text-fg/80">
          <span className="inline-flex items-center gap-2">
            <Wand2 className="h-4 w-4 shrink-0 text-sky-brand" />
            <span>
              <strong className="text-fg">Suggested arc ready.</strong> Reorder the stories and fill
              transitions to match Ark&rsquo;s narrative flow?
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <button
              onClick={applySuggestedArc}
              disabled={busy !== null}
              className="rounded-md bg-sky-brand px-2.5 py-1 text-xs font-semibold text-ink-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply
            </button>
            <button
              onClick={() => setDismissedRationale(arc.rationale)}
              className="rounded-md border border-overlay/15 px-2.5 py-1 text-xs text-fg/60 transition hover:border-overlay/30 hover:text-fg"
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : arcSuggesting ? (
        <div className="inline-flex items-center gap-2 self-start rounded-lg border border-overlay/10 bg-overlay/[0.02] px-3 py-1.5 text-xs text-fg/55">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-brand" />
          Suggesting a narrative arc…
        </div>
      ) : null}

      <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] px-4 py-3 text-sm text-fg/70">
        <span className="font-semibold text-fg">
          {topics.length} stor{topics.length === 1 ? 'y' : 'ies'} extracted and arranged.
        </span>{' '}
        Drag to reorder, set each block, and edit the transitions. Reject, deepen, or attach sources
        per story, then write the script.
        {arc.rationale && !suggestionPending ? (
          <span className="mt-2 block text-fg/55">
            <span className="font-semibold text-fg/70">Suggested arc: </span>
            {arc.rationale}
          </span>
        ) : null}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {order.map((id, i) => {
              const topic = topicById.get(id);
              const serverIndex = indexById.get(id);
              if (!topic || serverIndex == null) return null;
              return (
                <SortableTopicRow
                  key={id}
                  id={id}
                  topic={topic}
                  serverIndex={serverIndex}
                  displayNumber={i + 1}
                  isLast={i === order.length - 1}
                  role={roleForIndex(i)}
                  roleOptions={ROLE_LETTERS.slice(0, Math.min(order.length, 4))}
                  transition={transitions[id] ?? ''}
                  onRoleChange={(r) => {
                    const target = ROLE_LETTERS.indexOf(r);
                    setOrder((prev) => {
                      const from = prev.indexOf(id);
                      const to = Math.min(target, prev.length - 1);
                      if (from === -1 || from === to) return prev;
                      return arrayMove(prev, from, to);
                    });
                  }}
                  onTransitionChange={(t) => setTransitions((prev) => ({ ...prev, [id]: t }))}
                  locked={locked}
                  rejected={rejectedTopics.has(serverIndex)}
                  onToggleReject={() => onToggleReject(serverIndex)}
                  onRefetch={(g) => onRefetch(serverIndex, g)}
                  onDeepen={(g) => onDeepen(serverIndex, g)}
                  onTopicAction={onTopicAction}
                  onCancelTopicAction={onCancelTopicAction}
                  onAttach={(urls) => onAttach(serverIndex, urls)}
                  busy={busy}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {showAdd ? (
        <AddTopicCard
          onCancel={() => {
            onCancelTopicAction();
            setShowAdd(false);
          }}
          onSubmit={async (payload) => {
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
          <Plus className="h-4 w-4" /> Add a story
        </button>
      )}

      <div className="sticky bottom-0 -mx-6 mt-2 border-t border-overlay/10 bg-canvas/90 px-6 py-4 backdrop-blur">
        <button
          onClick={write}
          disabled={busy !== null || keptCount === 0}
          className={cn(
            'w-full rounded-lg bg-sky-brand px-4 py-3 text-sm font-semibold text-ink-950',
            'transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {busy === 'generate' ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing…
            </span>
          ) : (
            `Write script (${keptCount} stor${keptCount === 1 ? 'y' : 'ies'})`
          )}
        </button>
      </div>
    </div>
  );
}

// One row on the merged review screen: a drag handle + positional block selector
// in a left rail, the full TopicCard (reject/deepen/refetch/attach/edit/delete),
// and the transition input below it.
function SortableTopicRow({
  id,
  topic,
  serverIndex,
  displayNumber,
  isLast,
  role,
  roleOptions,
  transition,
  onRoleChange,
  onTransitionChange,
  locked,
  rejected,
  onToggleReject,
  onRefetch,
  onDeepen,
  onTopicAction,
  onCancelTopicAction,
  onAttach,
  busy,
}: {
  id: string;
  topic: TopicWithSources;
  serverIndex: number;
  displayNumber: number;
  isLast: boolean;
  role: 'A' | 'B' | 'C' | 'D';
  roleOptions: ('A' | 'B' | 'C' | 'D')[];
  transition: string;
  onRoleChange: (r: 'A' | 'B' | 'C' | 'D') => void;
  onTransitionChange: (t: string) => void;
  locked: boolean;
  rejected: boolean;
  onToggleReject: () => void;
  onRefetch: (guidance: string) => void;
  onDeepen: (guidance: string) => void;
  onTopicAction: (p: TopicAction) => Promise<boolean>;
  onCancelTopicAction: () => void;
  onAttach: (urls: string[]) => void;
  busy: BusyState;
}) {
  const { attributes, listeners, setNodeRef, transform, transition: dndTransition, isDragging } =
    useSortable({ id, disabled: locked });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: dndTransition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('flex items-stretch gap-2', isDragging && 'opacity-60')}
    >
      <div className="flex flex-col items-center gap-2 pt-5">
        <button
          {...attributes}
          {...listeners}
          disabled={locked}
          className="cursor-grab touch-none text-fg/30 hover:text-fg/60 disabled:cursor-not-allowed active:cursor-grabbing"
          title="Drag to reorder"
        >
          <GripVertical className="h-5 w-5" />
        </button>
        <select
          value={role}
          onChange={(e) => onRoleChange(e.target.value as 'A' | 'B' | 'C' | 'D')}
          disabled={locked}
          className="rounded-md border border-overlay/15 ark-recessed px-1 py-0.5 text-xs text-fg disabled:opacity-60"
          title="Block role"
        >
          {roleOptions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="min-w-0 flex-1">
        <TopicCard
          topic={topic}
          index={serverIndex}
          displayNumber={displayNumber}
          rejected={rejected}
          onToggleReject={onToggleReject}
          onRefetch={onRefetch}
          onDeepen={onDeepen}
          onTopicAction={onTopicAction}
          onCancelTopicAction={onCancelTopicAction}
          onAttach={onAttach}
          busy={busy}
        />
        {!isLast ? (
          <div className="mt-2">
            <label className="text-[0.7rem] uppercase tracking-wider text-fg/45">
              Transition into next story
            </label>
            <input
              value={transition}
              onChange={(e) => onTransitionChange(e.target.value)}
              disabled={locked}
              placeholder="A one-line bridge into the next story"
              className="mt-1 w-full rounded-md border border-overlay/15 ark-recessed px-2 py-1 text-sm text-fg placeholder:text-fg/30 disabled:opacity-60"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------- Triage ----------

function TriageView({
  candidates,
  extraCandidates,
  onReorder,
  onRemove,
  onRemoveGroup,
  onSearch,
  onPullXPosts,
  onAddCandidate,
  onGroup,
  busy,
}: {
  candidates: Candidate[];
  extraCandidates: Candidate[];
  onReorder: (next: Candidate[]) => void;
  onRemove: (url: string) => void;
  onRemoveGroup: (urls: string[]) => void;
  onSearch: (query: string) => Promise<Candidate[]>;
  onPullXPosts: () => Promise<Candidate[]>;
  onAddCandidate: (candidate: Candidate) => void;
  onGroup: () => void;
  busy: BusyState;
}) {
  const existingUrls = useMemo(
    () => new Set(candidates.map((c) => c.url)),
    [candidates],
  );

  // Group candidates by theme for display. The candidate array arrives grouped
  // contiguously from clusterCandidates, so first-appearance order yields clean,
  // contiguous theme sections. Untagged candidates (added via search/X/"See
  // more", or a run that pre-dates clustering) fall under "Other".
  const groups = useMemo(() => {
    const out: { theme: string; items: Candidate[] }[] = [];
    const indexByTheme = new Map<string, number>();
    for (const c of candidates) {
      const theme = c.theme ?? 'Other';
      let g = indexByTheme.get(theme);
      if (g === undefined) {
        g = out.length;
        indexByTheme.set(theme, g);
        out.push({ theme, items: [] });
      }
      out[g].items.push(c);
    }
    return out;
  }, [candidates]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (theme: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(theme)) next.delete(theme);
      else next.add(theme);
      return next;
    });
  const sensors = useSensors(
    // A small distance threshold so a click on the title link isn't swallowed
    // as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The global busy lock serializes triage writes — drag and remove are
  // disabled while any request is in flight.
  const locked = busy !== null;

  // Drag-to-rank is scoped to within a theme: a move only commits when both
  // ends sit in the same group. Because groups are contiguous in `candidates`,
  // an in-group arrayMove on absolute indices keeps every group contiguous.
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = candidates.findIndex((c) => c.url === active.id);
    const newIndex = candidates.findIndex((c) => c.url === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const sameTheme =
      (candidates[oldIndex].theme ?? 'Other') === (candidates[newIndex].theme ?? 'Other');
    if (!sameTheme) return;
    onReorder(arrayMove(candidates, oldIndex, newIndex));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] px-4 py-3 text-sm text-fg/70">
        <span className="font-semibold text-fg">
          {candidates.length} article{candidates.length === 1 ? '' : 's'} found
        </span>{' '}
        across {groups.length} theme{groups.length === 1 ? '' : 's'}. Discard a whole theme
        you don&rsquo;t want, drag to rank within a theme, then group what&rsquo;s left.
        Sources are verified and read when you group.
      </div>

      {candidates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-overlay/15 bg-overlay/[0.01] p-6 text-center text-sm text-fg/55">
          No articles left in the pool. Search below to add some, or start a new run.
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-col gap-3">
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.theme);
              return (
                <div
                  key={group.theme}
                  className="rounded-lg border border-overlay/10 bg-overlay/[0.015]"
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(group.theme)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-expanded={!isCollapsed}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4 shrink-0 text-fg/40" />
                      ) : (
                        <ChevronDown className="h-4 w-4 shrink-0 text-fg/40" />
                      )}
                      <span className="truncate text-sm font-semibold text-fg">
                        {group.theme}
                      </span>
                      <span className="shrink-0 rounded-full bg-overlay/10 px-2 py-0.5 text-[0.7rem] text-fg/55">
                        {group.items.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveGroup(group.items.map((c) => c.url))}
                      disabled={locked}
                      className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[0.7rem] text-fg/45 transition hover:bg-red-500/15 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Discard theme
                    </button>
                  </div>

                  {isCollapsed ? null : (
                    <SortableContext
                      items={group.items.map((c) => c.url)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="flex flex-col gap-2 px-2 pb-2">
                        {group.items.map((candidate, i) => (
                          <TriageRow
                            key={candidate.url}
                            candidate={candidate}
                            index={i}
                            onRemove={() => onRemove(candidate.url)}
                            locked={locked}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  )}
                </div>
              );
            })}
          </div>
        </DndContext>
      )}

      {extraCandidates.length > 0 ? (
        <TriageExtrasPanel
          extras={extraCandidates}
          existingUrls={existingUrls}
          onAdd={onAddCandidate}
          busy={busy}
        />
      ) : null}

      <TriageSearchPanel
        existingUrls={existingUrls}
        onSearch={onSearch}
        onAdd={onAddCandidate}
        busy={busy}
      />

      <TriageXPanel
        existingUrls={existingUrls}
        onPull={onPullXPosts}
        onAdd={onAddCandidate}
        busy={busy}
      />

      <div className="sticky bottom-0 -mx-6 mt-2 border-t border-overlay/10 bg-canvas/90 px-6 py-4 backdrop-blur">
        <button
          onClick={onGroup}
          disabled={busy !== null || candidates.length === 0}
          className={cn(
            'w-full rounded-lg bg-sky-brand px-4 py-3 text-sm font-semibold text-ink-950',
            'transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {busy === 'group' ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Grouping articles…
            </span>
          ) : (
            `Group into topics (${candidates.length})`
          )}
        </button>
      </div>
    </div>
  );
}

function TriageRow({
  candidate,
  index,
  onRemove,
  locked,
}: {
  candidate: Candidate;
  index: number;
  onRemove: () => void;
  locked: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: candidate.url, disabled: locked });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-start gap-2 rounded-md border border-overlay/[0.06] bg-overlay/[0.02] px-2 py-2',
        isDragging && 'relative z-10 opacity-80 shadow-lg',
      )}
    >
      <button
        type="button"
        aria-label={`Reorder ${candidate.title}`}
        disabled={locked}
        className={cn(
          'mt-0.5 shrink-0 rounded p-1 text-fg/30 transition',
          locked
            ? 'cursor-not-allowed opacity-40'
            : 'cursor-grab hover:text-fg/60 active:cursor-grabbing',
        )}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="mt-1.5 w-5 shrink-0 text-right font-mono text-xs text-fg/35">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[0.7rem] uppercase tracking-wider text-fg/45">
            {candidate.source}
          </span>
          {candidate.publicationDate ? (
            <span className="text-[0.7rem] text-fg/35">
              {candidate.publicationDate.slice(0, 10)}
            </span>
          ) : null}
          {candidate.isFlagged ? (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wider text-amber-200">
              older story
            </span>
          ) : null}
        </div>
        <a
          href={candidate.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-sm text-fg/85 transition hover:text-fg"
        >
          {candidate.title}
        </a>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={locked}
        aria-label={`Remove ${candidate.title}`}
        className="mt-0.5 shrink-0 rounded p-1 text-fg/30 transition hover:bg-red-500/15 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// Overflow pool from discovery — the candidates that ranked below the top-N
// triage list. Collapsed by default so the writer isn't overwhelmed; expanded
// it's a fixed-height scroll container so a 60+ item list can be browsed
// without pushing the rest of the page off-screen. Promoting an extra goes
// through the same `onAdd` (→ /triage add) as the keyword search panel.
function TriageExtrasPanel({
  extras,
  existingUrls,
  onAdd,
  busy,
}: {
  extras: Candidate[];
  existingUrls: Set<string>;
  onAdd: (candidate: Candidate) => void;
  busy: BusyState;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-fg/70 transition hover:text-fg"
      >
        <span>
          <span className="font-semibold text-fg">See more candidates</span>{' '}
          <span className="text-fg/45">({extras.length})</span>{' '}
          <span className="text-fg/45">
            — extra stories from discovery you can browse and add.
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-fg/45 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <div className="max-h-96 overflow-y-auto border-t border-overlay/10 px-4 py-3">
          <HitList hits={extras} existingUrls={existingUrls} onAdd={onAdd} busy={busy} />
        </div>
      ) : null}
    </div>
  );
}

function TriageSearchPanel({
  existingUrls,
  onSearch,
  onAdd,
  busy,
}: {
  existingUrls: Set<string>;
  onSearch: (query: string) => Promise<Candidate[]>;
  onAdd: (candidate: Candidate) => void;
  busy: BusyState;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = async () => {
    const q = query.trim();
    if (q.length < 2 || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      setHits(await onSearch(q));
    } catch (err) {
      setSearchError(String(err).slice(0, 200));
      setHits(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="rounded-2xl border border-overlay/10 bg-overlay/[0.03] p-5">
      <div className="mb-1 text-sm font-semibold text-fg">Search approved outlets</div>
      <p className="mb-3 text-xs text-fg/45">
        Keyword search across the approved news sites and think tanks — use it when the
        automatic pull came up short. X/Twitter posts aren&rsquo;t searchable this way; use
        the X panel below for those.
      </p>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            }
          }}
          placeholder="e.g. Hezbollah ceasefire"
          className="flex-1 rounded-md border border-overlay/15 ark-recessed px-3 py-2 text-sm text-fg placeholder:text-fg/30"
        />
        <button
          onClick={runSearch}
          disabled={searching || query.trim().length < 2}
          className="inline-flex items-center gap-1.5 rounded-md bg-sky-brand/20 px-3 py-2 text-xs text-sky-brand transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {searching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Search
        </button>
      </div>

      {searchError ? (
        <div className="mt-3 rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {searchError}
        </div>
      ) : null}

      {hits !== null && !searchError ? (
        hits.length === 0 ? (
          <p className="mt-3 text-xs text-fg/45">
            No results from approved outlets for that query.
          </p>
        ) : (
          <HitList hits={hits} existingUrls={existingUrls} onAdd={onAdd} busy={busy} />
        )
      ) : null}
    </div>
  );
}

// Shared result list for the two triage-stage source finders — keyword search
// and the X-posts pull. Each hit is a Candidate the writer can append to the
// triage pool; adding goes through /triage, hence the global `busy` lock on
// the Add button (the panels themselves stay off the lock — they're read-only).
function HitList({
  hits,
  existingUrls,
  onAdd,
  busy,
}: {
  hits: Candidate[];
  existingUrls: Set<string>;
  onAdd: (candidate: Candidate) => void;
  busy: BusyState;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {hits.map((hit) => {
        const added = existingUrls.has(hit.url);
        return (
          <div
            key={hit.url}
            className="flex items-start gap-3 rounded-md border border-overlay/[0.06] bg-overlay/[0.02] px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[0.7rem] uppercase tracking-wider text-fg/45">
                  {hit.source}
                </span>
                {hit.publicationDate ? (
                  <span className="text-[0.7rem] text-fg/35">
                    {hit.publicationDate.slice(0, 10)}
                  </span>
                ) : null}
                {hit.isFlagged ? (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wider text-amber-200">
                    older story
                  </span>
                ) : null}
              </div>
              <a
                href={hit.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-sm text-fg/85 transition hover:text-fg"
              >
                {hit.title}
              </a>
            </div>
            <button
              onClick={() => onAdd(hit)}
              disabled={added || busy !== null}
              className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-overlay/15 px-2 py-1 text-xs text-fg/70 transition hover:border-overlay/30 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {added ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              {added ? 'Added' : 'Add'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Pull recent posts from the approved X/Twitter handles. Unlike keyword search
// this takes no query — it's a one-button grounded-model search over the 15
// handles — but it's the same read-only, owns-its-own-loading-state pattern.
function TriageXPanel({
  existingUrls,
  onPull,
  onAdd,
  busy,
}: {
  existingUrls: Set<string>;
  onPull: () => Promise<Candidate[]>;
  onAdd: (candidate: Candidate) => void;
  busy: BusyState;
}) {
  const [hits, setHits] = useState<Candidate[] | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  const runPull = async () => {
    if (pulling) return;
    setPulling(true);
    setPullError(null);
    try {
      setHits(await onPull());
    } catch (err) {
      setPullError(String(err).slice(0, 200));
      setHits(null);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="rounded-2xl border border-overlay/10 bg-overlay/[0.03] p-5">
      <div className="mb-1 text-sm font-semibold text-fg">Pull recent X posts</div>
      <p className="mb-3 text-xs text-fg/45">
        Searches the 15 approved X/Twitter accounts for recent posts on the beat.
        This one runs a grounded model search, so it takes longer than the keyword
        search above.
      </p>
      <button
        onClick={runPull}
        disabled={pulling}
        className="inline-flex items-center gap-1.5 rounded-md bg-sky-brand/20 px-3 py-2 text-xs text-sky-brand transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pulling ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <AtSign className="h-3.5 w-3.5" />
        )}
        {pulling ? 'Pulling X posts…' : 'Pull recent X posts'}
      </button>

      {pullError ? (
        <div className="mt-3 rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {pullError}
        </div>
      ) : null}

      {hits !== null && !pullError ? (
        hits.length === 0 ? (
          <p className="mt-3 text-xs text-fg/45">
            No recent posts found from the approved X accounts.
          </p>
        ) : (
          <HitList hits={hits} existingUrls={existingUrls} onAdd={onAdd} busy={busy} />
        )
      ) : null}
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
  onDeepen,
  onGenerate,
  onTopicAction,
  onCancelTopicAction,
  onAttach,
  busy,
  regenerating,
  onCancelEdit,
  onRegroup,
}: {
  distill: DistillResult;
  rejectedTopics: Set<number>;
  onToggleReject: (index: number) => void;
  onRefetch: (index: number, guidance: string) => void;
  onDeepen: (index: number, guidance: string) => void;
  onGenerate: () => void;
  onTopicAction: (p: TopicAction) => Promise<boolean>;
  onCancelTopicAction: () => void;
  onAttach: (topicIndex: number, urls: string[]) => void;
  busy: BusyState;
  regenerating: boolean;
  onCancelEdit: (() => void) | null;
  // Back to triage. Null when re-grouping doesn't apply — e.g. editing topics
  // from an already-complete run, where the run's stage isn't `checkpoint`.
  onRegroup: (() => void) | null;
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

      {onRegroup ? (
        <button
          onClick={onRegroup}
          disabled={busy !== null}
          title="Go back to the raw article list to re-rank, prune, or search for more"
          className="inline-flex items-center gap-1.5 self-start rounded-md border border-overlay/15 px-2.5 py-1 text-xs text-fg/60 transition hover:border-overlay/30 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'regroup' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ArrowLeft className="h-3 w-3" />
          )}
          Re-group articles
        </button>
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
          onDeepen={(guidance) => onDeepen(i, guidance)}
          onTopicAction={onTopicAction}
          onCancelTopicAction={onCancelTopicAction}
          onAttach={(urls) => onAttach(i, urls)}
          busy={busy}
        />
      ))}

      {showAdd ? (
        <AddTopicCard
          onCancel={() => {
            // Abort an in-flight gather (no-op if idle) before unmounting,
            // so cancelling actually stops the server-side work.
            onCancelTopicAction();
            setShowAdd(false);
          }}
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
          className="rounded-md px-3 py-1.5 text-xs text-fg/60 hover:bg-overlay/5 hover:text-fg"
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
  displayNumber,
  rejected,
  onToggleReject,
  onRefetch,
  onDeepen,
  onTopicAction,
  onCancelTopicAction,
  onAttach,
  busy,
}: {
  topic: TopicWithSources;
  index: number;
  // Label shown in the badge. Defaults to index+1; the merged review screen
  // passes the arc position instead, since its display order differs from the
  // topic's position in distill.topics (which is what `index` addresses for
  // the tool callbacks).
  displayNumber?: number;
  rejected: boolean;
  onToggleReject: () => void;
  onRefetch: (guidance: string) => void;
  onDeepen: (guidance: string) => void;
  onTopicAction: (p: TopicAction) => Promise<boolean>;
  onCancelTopicAction: () => void;
  onAttach: (urls: string[]) => void;
  busy: BusyState;
}) {
  const [showRefetch, setShowRefetch] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showDeepen, setShowDeepen] = useState(false);
  const [deepenGuidance, setDeepenGuidance] = useState('');
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
            <KindBadge tone="sky">Topic {displayNumber ?? index + 1}</KindBadge>
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
            {!showRefetch && !showAttach && !showDeepen ? (
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
                {!noSources ? (
                  <>
                    <span className="text-xs text-fg/20">·</span>
                    <button
                      onClick={() => setShowDeepen(true)}
                      className="inline-flex items-center gap-1.5 text-xs text-fg/55 transition hover:text-fg"
                    >
                      <Wand2 className="h-3 w-3" /> Deepen analysis
                    </button>
                  </>
                ) : null}
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
                    {gathering ? (
                      <button
                        onClick={onCancelTopicAction}
                        className="text-xs text-fg/55 transition hover:text-fg"
                      >
                        Cancel
                      </button>
                    ) : null}
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

          {showDeepen ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={deepenGuidance}
                onChange={(e) => setDeepenGuidance(e.target.value)}
                placeholder="Optional: what angle should the analysis push on? (leave blank for a general deepen)"
                rows={2}
                className="w-full rounded-md border border-overlay/15 ark-recessed px-3 py-2 text-sm text-fg placeholder:text-fg/30"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    onDeepen(deepenGuidance.trim());
                    setShowDeepen(false);
                    setDeepenGuidance('');
                  }}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-md bg-sky-brand/20 px-3 py-1.5 text-xs text-sky-brand transition hover:bg-sky-brand/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === 'deepen' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Wand2 className="h-3 w-3" />
                  )}
                  Deepen
                </button>
                <button
                  onClick={() => {
                    setShowDeepen(false);
                    setDeepenGuidance('');
                  }}
                  className="rounded-md px-3 py-1.5 text-xs text-fg/60 hover:bg-overlay/5 hover:text-fg"
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-fg/45">
                Expands this topic&rsquo;s analysis using its attached sources and pulls additional
                quotes. Typically 20–60 seconds.
              </p>
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
