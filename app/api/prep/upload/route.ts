import { z } from 'zod';
import { uploadPrepDocToDrive } from '@/lib/drive';

export const runtime = 'nodejs';

const uploadRequestSchema = z.object({
  questionsText: z.string().min(1, 'Questions text is required'),
  show: z.string().nullable(),
  title: z.string().min(1, 'Title is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validation = uploadRequestSchema.safeParse(body);

    if (!validation.success) {
      return Response.json(
        { error: validation.error.issues[0]?.message || 'Invalid request' },
        { status: 400 },
      );
    }

    const { questionsText, show, title, date } = validation.data;

    const showPrefix = show ? `${show} Prep` : 'Episode Prep';
    const docTitle = `${showPrefix} — ${date} — ${title}`;

    const result = await uploadPrepDocToDrive(questionsText, docTitle, show);

    if (!result.ok) {
      return Response.json({ error: result.reason }, { status: 500 });
    }

    return Response.json({
      ok: true,
      driveUrl: result.driveUrl,
      fileId: result.fileId,
      matchedShow: result.matchedShow ?? null,
      fallback: result.fallback ?? false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Upload failed: ${message}` },
      { status: 500 },
    );
  }
}
