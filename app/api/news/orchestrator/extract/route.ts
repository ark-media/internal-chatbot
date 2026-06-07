import { getNewsExamples } from '@/lib/news-prompt';
import { suggestArc } from '@/lib/orchestrator/arrange';
import { parseDocumentToMarkdown, UnsupportedDocError } from '@/lib/orchestrator/doc-parse';
import { extractStories } from '@/lib/orchestrator/extract';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
  saveRunIfUnchanged,
} from '@/lib/orchestrator/state';
import type { ExtractedStory, NarrativeArc, OrchestratorRun } from '@/lib/orchestrator/types';
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
  // Allow first extract ('extracting') and re-extract from the review
  // checkpoint ('extracted'). Reject once the editor has moved on.
  if (run.stage !== 'extracting' && run.stage !== 'extracted') {
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

  try {
    const extracted = await extractStories(documentMarkdown);
    const stories: ExtractedStory[] = extracted.map((s) => ({
      ...s,
      id: crypto.randomUUID(),
    }));

    if (stories.length === 0) {
      const detail = 'No stories could be extracted from this document. Check the formatting and try again.';
      await saveRun({
        ...run,
        stage: 'error',
        sourceDocument: documentMarkdown,
        errorMessage: detail,
        updatedAt: new Date().toISOString(),
      });
      return Response.json({ stage: 'error', errorMessage: detail }, { status: 200 });
    }

    // Extraction and arc suggestion are folded into a single step: the editor
    // had no action to take on a bare extraction beyond "now arrange it", so we
    // run the arc agent here and land directly on the review-and-arrange screen.
    // If the arc agent fails we don't strand the stories — fall back to a
    // straight extracted-order arc the editor can reshape by hand.
    let arc: NarrativeArc;
    try {
      const exampleScripts = await getNewsExamples();
      arc = await suggestArc(stories, exampleScripts);
    } catch (err) {
      console.warn(
        JSON.stringify({ event: 'orchestrator.extract.arc_fallback', chatId, err: String(err) }),
      );
      arc = {
        order: stories.map((s) => s.id),
        leadId: stories[0].id,
        roles: Object.fromEntries(
          stories.map((s, i) => [s.id, s.blockHint ?? (i === 0 ? 'A' : 'D')]),
        ),
        transitions: {},
        rationale: '',
      };
    }

    const next: OrchestratorRun = {
      ...run,
      stage: 'arranged',
      sourceDocument: documentMarkdown,
      extractedStories: stories,
      arc,
      // A re-extract supersedes any prior distill from this run.
      distill: null,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };
    const saved = await saveRunIfUnchanged(next, expectedUpdatedAt);
    if (!saved) {
      return Response.json(
        { error: 'conflict', detail: 'The run changed while extracting. Try again.' },
        { status: 409 },
      );
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

    return Response.json({ stage: 'arranged', stories, arc });
  } catch (err) {
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
    return Response.json(
      { stage: 'error', errorMessage: String(err).slice(0, 500) },
      { status: 500 },
    );
  }
}
