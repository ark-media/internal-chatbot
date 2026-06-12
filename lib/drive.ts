import { google } from 'googleapis';

const NEWS_DAILY_FOLDER_ID = '10eqtN0ARdkI17M6nUz81TdY3mMAhq33q'; // Ark News Daily root folder

interface DriveUploadResult {
  ok: boolean;
  driveUrl?: string;
  fileId?: string;
  reason?: string;
}

async function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oauth2Client;
}

async function uploadDocToFolder(
  text: string,
  name: string,
  folderId: string,
): Promise<DriveUploadResult> {
  const auth = await getOAuth2Client();

  if (!auth) {
    return {
      ok: false,
      reason: 'Google Drive not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN missing)',
    };
  }

  try {
    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId],
    };

    const media = {
      mimeType: 'text/plain',
      body: text,
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, webViewLink',
    });

    const fileId = response.data.id || '';
    const webViewLink = response.data.webViewLink || '';

    if (!fileId || !webViewLink) {
      return {
        ok: false,
        reason: 'Failed to get file ID or Drive link from response',
      };
    }

    return {
      ok: true,
      fileId,
      driveUrl: webViewLink,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Drive upload failed: ${message}`,
    };
  }
}

export async function uploadScriptToDrive(
  scriptText: string,
  title: string,
): Promise<DriveUploadResult> {
  return uploadDocToFolder(scriptText, title, NEWS_DAILY_FOLDER_ID);
}

// Map normalized show name -> { canonical display name, env var holding the folder ID }.
// Keys are matched case-insensitively after stripping punctuation; see normalizeShowKey.
const SHOW_FOLDER_LOOKUP: Record<string, { canonical: string; envVar: string }> = {
  'call me back': {
    canonical: 'Call me Back',
    envVar: 'GOOGLE_DRIVE_FOLDER_CALL_ME_BACK',
  },
  'inside call me back': {
    canonical: 'Inside Call me Back',
    envVar: 'GOOGLE_DRIVE_FOLDER_INSIDE_CALL_ME_BACK',
  },
  'for heavens sake': {
    canonical: "For Heaven's Sake",
    envVar: 'GOOGLE_DRIVE_FOLDER_FOR_HEAVENS_SAKE',
  },
  'whats your number': {
    canonical: "What's Your Number?",
    envVar: 'GOOGLE_DRIVE_FOLDER_WHATS_YOUR_NUMBER',
  },
};

function normalizeShowKey(show: string): string {
  return show
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[?.!,:;]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whether a show name resolves to a known per-show folder entry (independent of
// whether its env var is actually configured). Lets prep-shows.ts assert that
// every canonical it exposes is routable here, so the two tables can't drift.
export function isRoutableShow(show: string | null | undefined): boolean {
  return !!show && normalizeShowKey(show) in SHOW_FOLDER_LOOKUP;
}

export interface PrepFolderResolution {
  folderId: string | null;
  matchedShow: string | null;
  fallback: boolean;
}

export function resolvePrepFolder(show: string | null): PrepFolderResolution {
  if (show) {
    const entry = SHOW_FOLDER_LOOKUP[normalizeShowKey(show)];
    if (entry) {
      const folderId = process.env[entry.envVar];
      if (folderId) {
        return { folderId, matchedShow: entry.canonical, fallback: false };
      }
    }
  }
  const fallbackId = process.env.GOOGLE_DRIVE_FOLDER_PREP_DEFAULT;
  if (fallbackId) {
    return { folderId: fallbackId, matchedShow: null, fallback: true };
  }
  return { folderId: null, matchedShow: null, fallback: false };
}

export async function uploadPrepDocToDrive(
  questionsText: string,
  title: string,
  show: string | null,
): Promise<DriveUploadResult & { matchedShow?: string | null; fallback?: boolean }> {
  const resolved = resolvePrepFolder(show);
  if (!resolved.folderId) {
    return {
      ok: false,
      reason: show
        ? `No Drive folder configured for "${show}". Set the matching GOOGLE_DRIVE_FOLDER_* env var or GOOGLE_DRIVE_FOLDER_PREP_DEFAULT.`
        : 'No prep folder configured. Set GOOGLE_DRIVE_FOLDER_PREP_DEFAULT or a per-show folder env var.',
    };
  }
  const result = await uploadDocToFolder(questionsText, title, resolved.folderId);
  return {
    ...result,
    matchedShow: resolved.matchedShow,
    fallback: resolved.fallback,
  };
}
