/**
 * One-time setup: exchange an authorization code for a permanent Dropbox refresh token.
 * Run: node --import=tsx src/tools/dropboxRefreshSetup.ts
 */

import 'dotenv/config';
import readline from 'readline';

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
  console.error('Missing DROPBOX_APP_KEY or DROPBOX_APP_SECRET in .env');
  process.exit(1);
}

const authUrl =
  `https://www.dropbox.com/oauth2/authorize` +
  `?client_id=${APP_KEY}` +
  `&response_type=code` +
  `&token_access_type=offline`;

console.log('\n=== Dropbox Refresh Token Setup ===\n');
console.log('Step 1: Open this URL in your browser:\n');
console.log(`   ${authUrl}\n`);
console.log('Step 2: Click "Allow" to authorize');
console.log('Step 3: Copy the authorization code shown on the page\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the authorization code here: ', async (code) => {
  rl.close();

  const trimmed = code.trim();
  if (!trimmed) {
    console.error('No code provided.');
    process.exit(1);
  }

  const credentials = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code: trimmed,
      grant_type: 'authorization_code',
    }),
  });

  const data: any = await res.json();

  if (!res.ok || !data.refresh_token) {
    console.error('Failed to get refresh token:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('\n✅ SUCCESS!\n');
  console.log('Add this line to your .env file:\n');
  console.log(`DROPBOX_REFRESH_TOKEN=${data.refresh_token}`);
  console.log('\nThat is it — this token never expires.\n');
});
