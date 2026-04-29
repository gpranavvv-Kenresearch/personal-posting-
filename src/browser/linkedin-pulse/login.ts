/**
 * LinkedIn Pulse Login
 * Reuses LinkedIn login — Pulse is a feature within LinkedIn
 */

import { loginToLinkedIn, closeLinkedInBrowser } from '../linkedin/login.js';
import type { Page } from 'playwright';

export async function loginToLinkedInPulse(nickname: string): Promise<Page> {
  console.log(`   [LinkedIn Pulse] Using LinkedIn login for account: ${nickname}`);
  const page = await loginToLinkedIn({ nickname });

  // Navigate to LinkedIn article composer
  console.log('   [LinkedIn Pulse] Navigating to article composer...');
  await page.goto('https://www.linkedin.com/article/new/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  return page;
}

export async function closeLinkedInPulseBrowser(): Promise<void> {
  console.log('   [LinkedIn Pulse] Closing browser...');
  await closeLinkedInBrowser();
}
