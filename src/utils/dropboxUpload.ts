import fs from 'fs';
import path from 'path';
import 'dotenv/config';

export interface DropboxUploadResult {
  dropboxPath: string;
  sharedUrl: string;
}

async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;

  // Prefer refresh token flow (permanent)
  if (refreshToken && appKey && appSecret) {
    const credentials = Buffer.from(`${appKey}:${appSecret}`).toString('base64');
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    const data: any = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(`Dropbox token refresh failed: ${JSON.stringify(data)}`);
    }
    return data.access_token;
  }

  // Fallback: legacy short-lived token (expires in ~4h)
  const token = process.env.DROPBOX_API_KEY_PRANAV;
  if (!token) {
    throw new Error(
      'No Dropbox credentials found. Set DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET in .env, ' +
      'or run: node --import=tsx src/tools/dropboxRefreshSetup.ts'
    );
  }
  return token;
}

function toDirectDownloadUrl(url: string): string {
  return url.replace('?dl=0', '?dl=1');
}

export async function uploadFileToDropbox(
  localFilePath: string,
  dropboxFolder = '/Ken Research PDFs'
): Promise<DropboxUploadResult> {
  const accessToken = await getAccessToken();

  if (!fs.existsSync(localFilePath)) {
    throw new Error(`Local file not found: ${localFilePath}`);
  }

  const fileName = path.basename(localFilePath);
  const fileBuffer = fs.readFileSync(localFilePath);
  const dropboxPath = `${dropboxFolder}/${fileName}`;

  const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: 'overwrite',
        autorename: false,
        mute: false,
        strict_conflict: false,
      }),
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`Dropbox upload failed (${uploadRes.status}): ${text}`);
  }

  const sharedRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: dropboxPath,
      settings: { requested_visibility: 'public' },
    }),
  });

  let sharedUrl = '';

  if (sharedRes.ok) {
    const data: any = await sharedRes.json();
    sharedUrl = toDirectDownloadUrl(data.url);
  } else {
    const text = await sharedRes.text();

    if (text.includes('shared_link_already_exists')) {
      const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: dropboxPath, direct_only: true }),
      });

      if (!listRes.ok) {
        const listText = await listRes.text();
        throw new Error(`Dropbox shared link list failed (${listRes.status}): ${listText}`);
      }

      const listData: any = await listRes.json();
      const existing = listData.links?.[0]?.url;
      if (!existing) {
        throw new Error(`Dropbox shared link exists but no URL returned`);
      }

      sharedUrl = toDirectDownloadUrl(existing);
    } else {
      throw new Error(`Dropbox shared link failed (${sharedRes.status}): ${text}`);
    }
  }

  return { dropboxPath, sharedUrl };
}
