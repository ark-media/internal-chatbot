import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';

import {
  ALLOWED_UPLOAD_MEDIA_TYPES,
  MAX_FILE_BYTES,
  UPLOAD_PATH_PREFIX,
} from '@/lib/prep-limits';

export const runtime = 'nodejs';

// Issues short-lived Blob client tokens so the browser can upload attachments
// directly to the store, bypassing Vercel's 4.5 MB function body limit. Sits
// behind the same basic auth as every other route (proxy.ts).
//
// No `onUploadCompleted`: that callback is a webhook from Vercel Blob, which
// can't pass basic auth, and nothing needs recording — the client puts the
// blob URL straight into the chat message.
export async function POST(request: Request): Promise<Response> {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(UPLOAD_PATH_PREFIX)) {
          throw new Error(`Uploads must go under ${UPLOAD_PATH_PREFIX}`);
        }
        return {
          allowedContentTypes: [...ALLOWED_UPLOAD_MEDIA_TYPES],
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: true,
        };
      },
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
}
