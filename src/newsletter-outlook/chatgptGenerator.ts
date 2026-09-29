/**
 * chatgptGenerator.ts — generates newsletter content from 3-4 report URLs
 * via the user's own logged-in ChatGPT session (browser automation, not an
 * API call — same approach blogGenAgent.ts uses for blog articles).
 *
 * Uses a dedicated ChatGPT account ("newsletter") so this never collides
 * with the accounts already allocated to blog text / carousels / social
 * images. Log into it once via:
 *   npx tsx src/tools/loginChatGpt.ts newsletter
 *
 * NEWSLETTER_PROMPT_TEMPLATE below is a PLACEHOLDER — swap its body for the
 * real prompt once it's provided. The only contract the rest of the pipeline
 * depends on is the output shape: a "Subject: ..." line followed by the
 * email body — see parseNewsletterResponse().
 */

import { ensureChatGptPage, closeChatGptBrowser, COMPOSER_SELECTOR } from '../browser/chatgpt/login.js';
import { pasteIntoChatGptComposer, dismissBlockingModals } from '../utils/chatgptComposer.js';
import type { Page } from 'playwright';

export const NEWSLETTER_CHATGPT_ACCOUNT = 'newsletter';

const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
// Matches both the old data-message-author-role attribute and the new UI's
// div[data-markdown-text-style="assistant-message"] (confirmed live
// 2026-09-26 — ChatGPT dropped the old attribute in a UI redesign).
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';

// Newsletters are a few short paragraphs, not a 1500-word article — shorter
// completion threshold and polling window than blogGenAgent's equivalents.
const MIN_DONE_CHARS = 150;
const POLL_MS = 20 * 1000;
const MAX_POLLS = 15; // 15 * 20s = 5 min hard cap

/**
 * TODO: replace with the real newsletter prompt once provided. This
 * placeholder just asks for a short multi-report roundup in the expected
 * "Subject: ..." + body output shape so the rest of the pipeline is testable
 * end-to-end before the real prompt lands.
 */
export function buildNewsletterPrompt(reportUrls: string[]): string {
  const urlList = reportUrls.map((u, i) => `${i + 1}. ${u}`).join('\n');
  return [
    'You are writing a short market-intelligence newsletter email for Ken Research, covering the following published reports:',
    urlList,
    '',
    'For each report, open the page and pull the real title, market size, and 1-2 key findings — do not invent figures.',
    'Write one short newsletter combining all of them: a compelling subject line, then 1 short paragraph per report with its key finding, each ending with its own report URL for the reader to click through.',
    '',
    'Output format — return exactly this, nothing else:',
    'Subject: <the subject line>',
    '',
    '<the newsletter body, plain text with a blank line between paragraphs>',
  ].join('\n');
}

async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    return msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '';
  }, ASSISTANT_MESSAGE_SELECTOR);
}

async function waitForCompletion(page: Page): Promise<void> {
  let goneChecks = 0;
  let lastLength = -1;
  let unchangedChecks = 0;
  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    await page.waitForTimeout(POLL_MS);
    await dismissBlockingModals(page).catch(() => {});
    const stopping = await page.locator(STOP_BUTTON_SELECTOR).first().isVisible({ timeout: 2000 }).catch(() => false);
    const text = await lastAssistantText(page);
    console.log(`   [newsletter:chatgpt] …check ${poll}/${MAX_POLLS}: ${stopping ? 'still writing' : 'looks finished'} (${text.length} chars)`);
    if (!stopping && text.length > MIN_DONE_CHARS) {
      goneChecks++;
      if (goneChecks >= 2) return;
    } else {
      goneChecks = 0;
    }
    if (text.length > MIN_DONE_CHARS && text.length === lastLength) {
      unchangedChecks++;
      if (unchangedChecks >= 2) return;
    } else {
      unchangedChecks = 0;
    }
    lastLength = text.length;
  }
}

/** Splits ChatGPT's reply into { subject, body } per the "Subject: ..." convention in buildNewsletterPrompt(). */
export function parseNewsletterResponse(text: string): { subject: string; body: string } {
  const lines = text.split('\n');
  const subjectLineIdx = lines.findIndex(l => /^subject:/i.test(l.trim()));
  if (subjectLineIdx === -1) {
    // No "Subject:" line found — fall back to the first non-empty line as
    // the subject and treat the rest as the body, rather than failing.
    const firstNonEmpty = lines.findIndex(l => l.trim().length > 0);
    return {
      subject: (lines[firstNonEmpty] ?? 'Ken Research Update').trim(),
      body: lines.slice(firstNonEmpty + 1).join('\n').trim(),
    };
  }
  const subject = lines[subjectLineIdx].replace(/^subject:/i, '').trim();
  const body = lines.slice(subjectLineIdx + 1).join('\n').trim();
  return { subject, body };
}

/** Converts the plain-text body ChatGPT returns into paragraph HTML. */
export function textToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export interface GeneratedNewsletter {
  subject: string;
  bodyHtml: string;
}

export async function generateNewsletterViaChatGpt(reportUrls: string[]): Promise<GeneratedNewsletter> {
  if (reportUrls.length === 0) throw new Error('generateNewsletterViaChatGpt: no report URLs given');

  const page = await ensureChatGptPage(NEWSLETTER_CHATGPT_ACCOUNT);
  await dismissBlockingModals(page);

  const prompt = buildNewsletterPrompt(reportUrls);
  console.log(`   [newsletter:chatgpt] Sending prompt for ${reportUrls.length} report(s)...`);
  await pasteIntoChatGptComposer(page, prompt);
  await page.waitForTimeout(800);
  await dismissBlockingModals(page);

  const sendBtn = page.locator(SEND_BUTTON_SELECTOR).first();
  if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sendBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await waitForCompletion(page);
  const raw = await lastAssistantText(page);
  if (!raw || raw.length < 30) {
    throw new Error('generateNewsletterViaChatGpt: response too short — generation likely failed');
  }

  const { subject, body } = parseNewsletterResponse(raw);
  return { subject, bodyHtml: textToHtml(body) };
}

export { closeChatGptBrowser, COMPOSER_SELECTOR };
