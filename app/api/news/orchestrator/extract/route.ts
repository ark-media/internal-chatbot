import { extractedOrderArc } from '@/lib/orchestrator/arrange';
import { parseDocumentToMarkdown, UnsupportedDocError } from '@/lib/orchestrator/doc-parse';
import { normalizeStoryDraft, streamExtractStories } from '@/lib/orchestrator/extract';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
  saveRunIfUnchanged,
} from '@/lib/orchestrator/state';
import {
  extractedStoriesToDistill,
  type ExtractedStory,
  type OrchestratorRun,
} from '@/lib/orchestrator/types';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Reject absurdly large uploads before reading them into memory.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
// Guard against a near-empty doc that would waste a model call.
const MIN_DOC_CHARS = 200;

export async function POST(req: Request) {
  await ensureOrchestratorTables();

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const { ok } = await checkRateLimit(`orch-extract:${ip}`);
  if (!ok) return new Response('Rate limit exceeded', { status: 429 });

  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return new Response('Forbidden', { status: 403 });
      }
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  // Reject oversized uploads via Content-Length BEFORE `formData()` buffers the
  // whole body into memory. The post-parse `file.size` check below is the
  // backstop for requests that lie about or omit the header.
  const contentLength = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    return Response.json({ error: 'file_too_large' }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const chatId = form.get('chatId');
  const file = form.get('file');
  if (typeof chatId !== 'string' || !chatId) {
    return Response.json({ error: 'missing_chatId' }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return Response.json({ error: 'missing_file' }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: 'file_too_large' }, { status: 413 });
  }

  const run = await loadRun(chatId);
  if (!run) return Response.json({ error: 'run_not_found' }, { status: 404 });
  // Only the freshly-created run shell ('extracting') may be extracted. Extract
  // lands directly on 'arranged' (the arc suggestion is deferred and computed
  // separately via /arrange suggest), so reject once a run has moved on.
  if (run.stage !== 'extracting') {
    return Response.json({ error: 'wrong_stage', stage: run.stage }, { status: 409 });
  }

  const started = Date.now();
  // Snapshot for optimistic locking on the success save: extraction runs a
  // multi-second model call, so a double-submit (e.g. re-upload) could finish
  // twice and clobber. The terminal error saves below stay best-effort.
  const expectedUpdatedAt = run.updatedAt;

  let documentMarkdown: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    documentMarkdown = await parseDocumentToMarkdown(buffer, file.name, file.type);
  } catch (err) {
    const detail = err instanceof UnsupportedDocError ? err.message : 'Could not read the uploaded file.';
    await saveRun({
      ...run,
      stage: 'error',
      errorMessage: detail,
      updatedAt: new Date().toISOString(),
    });
    return Response.json({ stage: 'error', errorMessage: detail }, { status: 200 });
  }

  if (documentMarkdown.trim().length < MIN_DOC_CHARS) {
    const detail = 'The uploaded document looks empty or too short to extract stories from.';
    await saveRun({
      ...run,
      stage: 'error',
      sourceDocument: documentMarkdown,
      errorMessage: detail,
      updatedAt: new Date().toISOString(),
    });
    return Response.json({ stage: 'error', errorMessage: detail }, { status: 200 });
  }

  // Stream the extraction as newline-delimited JSON so the client can show each
  // story as it parses. The full set is persisted (stories + extracted-order arc
  // + distill, landing on 'arranged') *before* the stream closes, so the
  // client's post-stream refresh always reads the saved run — no serverless
  // persist/refresh race. The arc suggestion is deferred: the client triggers
  // /arrange suggest in the background once it lands on 'arranged'.
  const encoder = new TextEncoder();
  const line = (obj: unknown) => encoder.encode(`${JSON.stringify(obj)}\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = streamExtractStories(documentMarkdown, req.signal);
        // Surface each completed story for live display (no id yet — display only).
        for await (const story of result.elementStream) {
          controller.enqueue(line({ type: 'story', story }));
        }
        const drafts = await result.object;
        const stories: ExtractedStory[] = drafts.map((s) => ({
          ...normalizeStoryDraft(s),
          id: crypto.randomUUID(),
        }));

        if (stories.length === 0) {
          const detail =
            'No stories could be extracted from this document. Check the formatting and try again.';
          await saveRun({
            ...run,
            stage: 'error',
            sourceDocument: documentMarkdown,
            errorMessage: detail,
            updatedAt: new Date().toISOString(),
          });
          controller.enqueue(line({ type: 'error', message: detail }));
          controller.close();
          return;
        }

        // Land on 'arranged' with the no-model extracted-order arc, and
        // materialize the distill (in that order) so the merged review screen's
        // per-topic tools have a working set. Block + transition stay editable
        // on the screen; they're folded only at "Write script" (/arrange apply).
        const arc = extractedOrderArc(stories);
        const distill = extractedStoriesToDistill(stories, arc.order);
        const next: OrchestratorRun = {
          ...run,
          stage: 'arranged',
          sourceDocument: documentMarkdown,
          extractedStories: stories,
          arc,
          distill,
          approvedTopicIndices: distill.topics.map((_, i) => i),
          errorMessage: null,
          updatedAt: new Date().toISOString(),
        };
        const saved = await saveRunIfUnchanged(next, expectedUpdatedAt);
        if (!saved) {
          controller.enqueue(
            line({ type: 'error', message: 'The run changed while extracting. Try again.' }),
          );
          controller.close();
          return;
        }

        console.log(
          JSON.stringify({
            event: 'orchestrator.extract.complete',
            chatId,
            ms: Date.now() - started,
            docChars: documentMarkdown.length,
            storyCount: stories.length,
          }),
        );

        controller.enqueue(line({ type: 'done' }));
        controller.close();
      } catch (err) {
        // A client disconnect aborts the model mid-stream — unwind quietly
        // without persisting an error over the run.
        if (req.signal.aborted) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }
        await saveRun({
          ...run,
          stage: 'error',
          sourceDocument: documentMarkdown,
          errorMessage: String(err).slice(0, 500),
          updatedAt: new Date().toISOString(),
        });
        console.error(
          JSON.stringify({ event: 'orchestrator.extract.error', chatId, err: String(err) }),
        );
        try {
          controller.enqueue(line({ type: 'error', message: String(err).slice(0, 500) }));
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
