import { google } from 'googleapis';

const DRIVE_FOLDER_ID = '10eqtN0ARdkI17M6nUz81TdY3mMAhq33q'; // Ark News Daily root folder

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

export async function uploadScriptToDrive(
  scriptText: string,
  title: string
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

    // Create a Google Doc with the script content
    const fileMetadata = {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      parents: [DRIVE_FOLDER_ID],
    };

    // Convert script text to rich text by inserting as document body
    const media = {
      mimeType: 'text/plain',
      body: scriptText,
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
    } as any);

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
