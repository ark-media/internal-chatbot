import { parseDocumentToMarkdown, UnsupportedDocError } from '@/lib/orchestrator/doc-parse';
import { extractStories } from '@/lib/orchestrator/extract';
import {
  ensureOrchestratorTables,
  loadRun,
  saveRun,
} from '@/lib/orchestrator/state';
import type { ExtractedStory, OrchestratorRun } from '@/lib/orchestrator/types';
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

    const next: OrchestratorRun = {
      ...run,
      stage: 'extracted',
      sourceDocument: documentMarkdown,
      extractedStories: stories,
      // A re-extract supersedes any prior arc/distill from this run.
      arc: null,
      distill: null,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };
    await saveRun(next);

    console.log(
      JSON.stringify({
        event: 'orchestrator.extract.complete',
        chatId,
        ms: Date.now() - started,
        docChars: documentMarkdown.length,
        storyCount: stories.length,
      }),
    );

    return Response.json({ stage: 'extracted', stories });
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
