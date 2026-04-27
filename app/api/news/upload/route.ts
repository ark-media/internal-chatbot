import { z } from 'zod';
import { uploadScriptToDrive } from '@/lib/drive';

export const runtime = 'nodejs';

const uploadRequestSchema = z.object({
  scriptText: z.string().min(1, 'Script text is required'),
  title: z.string().min(1, 'Title is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
});

type UploadRequest = z.infer<typeof uploadRequestSchema>;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validation = uploadRequestSchema.safeParse(body);

    if (!validation.success) {
      return Response.json(
        { error: validation.error.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      );
    }

    const { scriptText, title, date } = validation.data;

    // Format: "Ark News Daily — YYYY-MM-DD — [headline]"
    const docTitle = `Ark News Daily — ${date} — ${title}`;

    const result = await uploadScriptToDrive(scriptText, docTitle);

    if (!result.ok) {
      return Response.json({ error: result.reason }, { status: 500 });
    }

    return Response.json({
      ok: true,
      driveUrl: result.driveUrl,
      fileId: result.fileId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Upload failed: ${message}` },
      { status: 500 }
    );
  }
}
