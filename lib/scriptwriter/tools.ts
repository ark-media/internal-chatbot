// Conductor tool set. The conductor (Sonnet 5) interprets the writer's free
// text and acts through these tools; each execute mutates the run and
// persists it. Heavy tools (draftBlock, assembleEpisode, reviseEpisode) run
// Opus and stream their output to the client as data parts via ctx.emit.
//
// Persistence note: within one conductor turn, tools run sequentially against
// the same in-memory run and use plain saves. The sourcing turn is the only
// operation claimed via stage CAS; conversational turns are single-writer in
// practice, and the run GET on reload always shows the latest saved state.

import { tool } from 'ai';
import { z } from 'zod';

import { getNewsExamples, getNewsExamplesForBlock, newsContextForDate, newsSystemPrompt } from '../news-prompt';
import { extractUrlToArticle } from '../orchestrator/source-gathering';
import { loadStyleProfile } from '../orchestrator/style-memory';
import { webSearch } from '../web-search';
import { assembleEpisode, reviseEpisodeText } from './assemble';
import { blockTail, draftBlock, reviewBlock } from './block-craft';
import { buildBlockSystemContent, buildTopicDigest } from './prompts';
import { saveRun } from './state';
import type { BlockSlot, ScriptRun, Scope } from './types';
import {
  approveTopicBlock,
  confirmContract,
  recordBlockDraft,
  recordBlockRevision,
  recordEpisode,
  reviseEpisode as reviseEpisodeReducer,
  scopeWantsAssembly,
  slotsInScope,
  startTopic,
  topicForSlot,
  undoEpisode as undoEpisodeReducer,
} from './types';
import { normalizeScope, scopeSchema } from './scope';
import { buildReviewerSystemContent } from '../orchestrator/reflect';

export type EmitPart = (part: { type: string; id?: string; data: unknown }) => void;

export type ConductorContext = {
  getRun: () => ScriptRun;
  setRun: (run: ScriptRun) => void;
  emit: EmitPart;
  signal?: AbortSignal;
};

// Serialize a topic for tool results / data parts without the heavy source
// content field.
export function topicSummary(run: ScriptRun, index: number) {
  const t = run.topics[index];
  return {
    index,
    slot: t.story.blockSlot,
    headline: t.story.headline,
    stage: t.stage,
    hasContract: t.contract !== null,
    blockVersion: t.block?.version ?? 0,
    editorNotes: t.reviewNotes,
  };
}

function requireTopic(run: ScriptRun, index: number) {
  const t = run.topics[index];
  if (!t) throw new Error(`No topic at index ${index}; run has ${run.topics.length} topics.`);
  return t;
}

async function persist(ctx: ConductorContext, run: ScriptRun): Promise<void> {
  ctx.setRun(run);
  await saveRun(run);
}

// The per-block register examples + style profile, loaded once per draft and
// shared by the writer and reviewer systems (both need them). Kept out of
// blockSystemFor so a single draft doesn't fetch each twice.
type BlockAssets = { examples: string; styleText?: string };

async function loadBlockAssets(slot: BlockSlot): Promise<BlockAssets> {
  const [examples, style] = await Promise.all([
    getNewsExamplesForBlock(slot),
    loadStyleProfile().catch(() => null),
  ]);
  return { examples, styleText: style?.text };
}

// Build the cached system for one topic's block writer. Stable per
// (topic, block) across draft + revisions so every call after the first is a
// cache read.
function blockSystemFor(run: ScriptRun, topicIndex: number, assets: BlockAssets): string {
  const t = run.topics[topicIndex];
  return buildBlockSystemContent({
    slot: t.story.blockSlot,
    blockExamples: assets.examples,
    topicDigest: buildTopicDigest(t),
    today: run.today,
    styleProfile: assets.styleText,
  });
}

// The tail of the nearest preceding approved block, for transition awareness.
function precedingApprovedTail(run: ScriptRun, slot: BlockSlot): string | undefined {
  const order: BlockSlot[] = ['A', 'B', 'C'];
  const myIdx = order.indexOf(slot);
  for (let i = myIdx - 1; i >= 0; i--) {
    const ti = topicForSlot(run, order[i]);
    const t = ti >= 0 ? run.topics[ti] : undefined;
    if (t?.block && t.stage === 'approved') return blockTail(t.block.text);
  }
  return undefined;
}

function blockPartId(slot: BlockSlot): string {
  return `block-${slot}`;
}

export function createConductorTools(ctx: ConductorContext) {
  return {
    setScope: tool({
      description:
        'Change the run scope when the writer asks for a different deliverable mid-run (e.g. "actually just give me the A block"). Scope was initially parsed from their original prompt.',
      inputSchema: scopeSchema,
      execute: async (input) => {
        const scope: Scope = normalizeScope(input);
        const run = { ...ctx.getRun(), scope };
        await persist(ctx, run);
        return { ok: true, scope };
      },
    }),

    replaceTopic: tool({
      description:
        'Swap a proposed topic for one of the backup stories. Only for topics with no confirmed contract yet.',
      inputSchema: z.object({
        topicIndex: z.number().int().min(0),
        backupIndex: z.number().int().min(0),
      }),
      execute: async ({ topicIndex, backupIndex }) => {
        let run = ctx.getRun();
        const t = requireTopic(run, topicIndex);
        if (t.contract) {
          return { ok: false, error: 'Topic already has a confirmed contract; amend it instead of replacing the story.' };
        }
        const backup = run.backups[backupIndex];
        if (!backup) return { ok: false, error: `No backup at index ${backupIndex}.` };
        const backups = run.backups.slice();
        backups[backupIndex] = { ...t.story, blockSlot: backup.blockSlot };
        const topics = run.topics.slice();
        topics[topicIndex] = {
          stage: 'proposed',
          story: { ...backup, blockSlot: t.story.blockSlot },
          contract: null,
          block: null,
          blockVersions: [],
          reviewNotes: [],
        };
        run = { ...run, topics, backups };
        await persist(ctx, run);
        ctx.emit({ type: 'data-topics', data: run.topics.map((_, i) => topicSummary(run, i)) });
        return { ok: true, topic: topicSummary(run, topicIndex) };
      },
    }),

    startTopic: tool({
      description:
        'Enter the understanding gate for a topic the writer wants to work. Returns the full source digest — use it to write the six-dimension readback in your reply. Do NOT draft on this turn.',
      inputSchema: z.object({ topicIndex: z.number().int().min(0) }),
      execute: async ({ topicIndex }) => {
        let run = ctx.getRun();
        requireTopic(run, topicIndex);
        run = startTopic(run, topicIndex);
        await persist(ctx, run);
        return {
          ok: true,
          topic: topicSummary(run, topicIndex),
          sourceDigest: buildTopicDigest(run.topics[topicIndex]),
        };
      },
    }),

    confirmUnderstanding: tool({
      description:
        "Record the writer-confirmed six-dimension read as the topic's substance contract. Call only after the writer explicitly confirms (or confirms with corrections — fold every correction into the contract text).",
      inputSchema: z.object({
        topicIndex: z.number().int().min(0),
        contract: z
          .string()
          .describe('The full confirmed read, one short paragraph per dimension, corrections folded in'),
      }),
      execute: async ({ topicIndex, contract }) => {
        let run = ctx.getRun();
        requireTopic(run, topicIndex);
        run = confirmContract(run, topicIndex, contract);
        await persist(ctx, run);
        return { ok: true, topic: topicSummary(run, topicIndex) };
      },
    }),

    amendContract: tool({
      description:
        "Update a topic's contract when the writer changes the analysis (adds/cuts/re-weights a beat) after confirmation. Pass the FULL updated contract, not a diff. Call before any redraft that depends on the change.",
      inputSchema: z.object({
        topicIndex: z.number().int().min(0),
        contract: z.string(),
      }),
      execute: async ({ topicIndex, contract }) => {
        let run = ctx.getRun();
        const t = requireTopic(run, topicIndex);
        if (!t.contract) return { ok: false, error: 'No confirmed contract to amend; run the understanding gate first.' };
        run = confirmContract(run, topicIndex, contract);
        await persist(ctx, run);
        return { ok: true, topic: topicSummary(run, topicIndex) };
      },
    }),

    draftBlock: tool({
      description:
        'Have the writing model draft the block for a topic with a confirmed contract. The draft streams to the writer directly — do not repeat its text. Returns editor notes from the review pass.',
      inputSchema: z.object({ topicIndex: z.number().int().min(0) }),
      execute: async ({ topicIndex }) => {
        let run = ctx.getRun();
        const t = requireTopic(run, topicIndex);
        if (!t.contract) return { ok: false, error: 'No confirmed contract; run the understanding gate first.' };
        if (t.stage === 'approved') return { ok: false, error: 'Block already approved.' };
        const slot = t.story.blockSlot;
        const partId = blockPartId(slot);
        const emitBlock = (text: string, status: 'streaming' | 'review' | 'ready', extra?: object) =>
          ctx.emit({
            type: 'data-block',
            id: partId,
            data: { slot, topicIndex, text, status, version: (t.block?.version ?? 0) + 1, ...extra },
          });

        const assets = await loadBlockAssets(slot);
        const cachedSystemContent = blockSystemFor(run, topicIndex, assets);
        const { text: draftText } = await draftBlock({
          slot,
          cachedSystemContent,
          contract: t.contract,
          previousBlockTail: precedingApprovedTail(run, slot),
          onDelta: (soFar) => emitBlock(soFar, 'streaming'),
          signal: ctx.signal,
        });

        emitBlock(draftText, 'review');
        const reviewerSystemContent = await buildReviewerSystemContent({
          exampleScripts: assets.examples,
          styleProfile: assets.styleText,
        });
        const review = await reviewBlock({
          slot,
          draftText,
          sources: t.story.sources,
          cachedSystemContent,
          reviewerSystemContent,
          contract: t.contract,
          onDelta: (soFar) => emitBlock(soFar, 'streaming'),
          signal: ctx.signal,
        });

        run = recordBlockDraft(ctx.getRun(), topicIndex, review.finalText);
        const topics = run.topics.slice();
        topics[topicIndex] = { ...topics[topicIndex], reviewNotes: review.editorNotes };
        run = { ...run, topics };
        await persist(ctx, run);
        ctx.emit({
          type: 'data-block',
          id: partId,
          data: {
            slot,
            topicIndex,
            text: review.finalText,
            status: 'ready',
            version: run.topics[topicIndex].block?.version ?? 1,
            editorNotes: review.editorNotes,
            hardFixApplied: review.hardFixApplied,
          },
        });
        return {
          ok: true,
          version: run.topics[topicIndex].block?.version,
          editorNotes: review.editorNotes,
          hardFixApplied: review.hardFixApplied,
        };
      },
    }),

    reviseBlock: tool({
      description:
        "Revise a topic's block per the writer's instruction (passed verbatim to the writing model). Use for phrasing/length/structure changes; for analytical changes call amendContract first.",
      inputSchema: z.object({
        topicIndex: z.number().int().min(0),
        instruction: z.string(),
      }),
      execute: async ({ topicIndex, instruction }) => {
        let run = ctx.getRun();
        const t = requireTopic(run, topicIndex);
        if (!t.block || !t.contract) return { ok: false, error: 'No draft to revise.' };
        if (t.stage === 'approved') return { ok: false, error: 'Block already approved; ask the writer to un-approve by revising explicitly.' };
        const slot = t.story.blockSlot;
        const partId = blockPartId(slot);
        const nextVersion = t.block.version + 1;
        const cachedSystemContent = blockSystemFor(run, topicIndex, await loadBlockAssets(slot));
        const { text } = await draftBlock({
          slot,
          cachedSystemContent,
          contract: t.contract,
          previousBlockTail: precedingApprovedTail(run, slot),
          previousDraft: t.block.text,
          instruction,
          onDelta: (soFar) =>
            ctx.emit({
              type: 'data-block',
              id: partId,
              data: { slot, topicIndex, text: soFar, status: 'streaming', version: nextVersion },
            }),
          signal: ctx.signal,
        });
        run = recordBlockRevision(ctx.getRun(), topicIndex, text, instruction);
        await persist(ctx, run);
        ctx.emit({
          type: 'data-block',
          id: partId,
          data: {
            slot,
            topicIndex,
            text,
            status: 'ready',
            version: nextVersion,
            editorNotes: run.topics[topicIndex].reviewNotes,
          },
        });
        return { ok: true, version: nextVersion };
      },
    }),

    approveBlock: tool({
      description:
        "Mark a topic's block approved after the writer signs off. Returns whether every in-scope block is now approved (and, for episode scope, that assembly is available).",
      inputSchema: z.object({ topicIndex: z.number().int().min(0) }),
      execute: async ({ topicIndex }) => {
        let run = ctx.getRun();
        const t = requireTopic(run, topicIndex);
        if (!t.block) return { ok: false, error: 'No block to approve.' };
        run = approveTopicBlock(run, topicIndex);
        await persist(ctx, run);
        const slots = slotsInScope(run.scope);
        const allApproved = slots.every((slot) => {
          const i = topicForSlot(run, slot);
          return i >= 0 && run.topics[i].stage === 'approved';
        });
        return {
          ok: true,
          allInScopeApproved: allApproved,
          assemblyAvailable: allApproved && scopeWantsAssembly(run.scope) && !run.episode,
        };
      },
    }),

    assembleEpisode: tool({
      description:
        'Assemble the approved blocks into the full episode (episode scope only, once every in-scope block is approved). Streams to the writer directly.',
      inputSchema: z.object({}),
      execute: async () => {
        let run = ctx.getRun();
        if (!scopeWantsAssembly(run.scope)) {
          return { ok: false, error: 'Scope is not a full episode; the approved block(s) are the deliverable.' };
        }
        const blocks = slotsInScope(run.scope).flatMap((slot) => {
          const i = topicForSlot(run, slot);
          const t = i >= 0 ? run.topics[i] : undefined;
          return t?.block && t.stage === 'approved' ? [{ slot, text: t.block.text }] : [];
        });
        if (blocks.length < slotsInScope(run.scope).length) {
          return { ok: false, error: 'Not every in-scope block is approved yet.' };
        }
        const emitEpisode = (text: string, status: 'streaming' | 'ready', extra?: object) =>
          ctx.emit({ type: 'data-episode', id: 'episode', data: { text, status, ...extra } });
        const { fullText, usedFallback } = await assembleEpisode({
          blocks,
          today: run.today,
          timezone: run.timezone,
          onDelta: (soFar) => emitEpisode(soFar, 'streaming'),
          signal: ctx.signal,
        });
        run = recordEpisode(ctx.getRun(), fullText);
        await persist(ctx, run);
        emitEpisode(fullText, 'ready', { usedFallback });
        return { ok: true, usedFallback };
      },
    }),

    reviseEpisode: tool({
      description:
        "Apply the writer's post-completion instruction to the assembled episode (edit in place; prior version kept for undo).",
      inputSchema: z.object({ instruction: z.string() }),
      execute: async ({ instruction }) => {
        let run = ctx.getRun();
        if (!run.episode) return { ok: false, error: 'No assembled episode yet.' };
        const examples = await getNewsExamples();
        const cachedSystemContent = `${newsSystemPrompt('orchestrator')}\n\n== Reference Examples ==\n\n${examples}\n\n== Date Context ==\n\n${newsContextForDate(run.today)}`;
        const { fullText } = await reviseEpisodeText({
          currentEpisode: run.episode.fullText,
          instruction,
          cachedSystemContent,
          onDelta: (soFar) =>
            ctx.emit({ type: 'data-episode', id: 'episode', data: { text: soFar, status: 'streaming' } }),
          signal: ctx.signal,
        });
        run = reviseEpisodeReducer(ctx.getRun(), fullText, instruction);
        await persist(ctx, run);
        ctx.emit({ type: 'data-episode', id: 'episode', data: { text: fullText, status: 'ready' } });
        return { ok: true, versions: run.episodeVersions.length };
      },
    }),

    undoEpisode: tool({
      description: 'Restore the previous episode version (undo the last reviseEpisode).',
      inputSchema: z.object({}),
      execute: async () => {
        let run = ctx.getRun();
        if (run.episodeVersions.length === 0) return { ok: false, error: 'Nothing to undo.' };
        run = undoEpisodeReducer(run);
        await persist(ctx, run);
        ctx.emit({
          type: 'data-episode',
          id: 'episode',
          data: { text: run.episode!.fullText, status: 'ready' },
        });
        return { ok: true, versions: run.episodeVersions.length };
      },
    }),

    webSearch: tool({
      description:
        'Open-web search (Tavily) for recent news and context — for writer questions beyond the topic digests. Returns up to 6 results.',
      inputSchema: z.object({
        query: z.string(),
        daysBack: z.number().int().min(1).max(365).optional(),
      }),
      execute: async ({ query, daysBack }) => {
        const res = await webSearch(query, { maxResults: 6, daysBack });
        if (!res.ok) return { results: [], note: res.note };
        return {
          results: res.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            published: r.publishedDate ?? null,
          })),
        };
      },
    }),

    fetchArticle: tool({
      description:
        'Fetch and extract the full text of one article URL (handles paywalls/JS-heavy pages; Hebrew is translated). Use when the writer supplies a link or a digest needs verification.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const run = ctx.getRun();
        const a = await extractUrlToArticle(url, run.today);
        return {
          title: a.title,
          url: a.url,
          source: a.source,
          date: a.publicationDate,
          isFlagged: a.isFlagged ?? false,
          fetchError: a.fetchError ?? null,
          text: a.content.slice(0, 12_000),
        };
      },
    }),
  };
}
