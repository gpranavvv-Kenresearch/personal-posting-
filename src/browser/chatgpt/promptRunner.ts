import { Page } from 'playwright';
import TurndownService from 'turndown';
import { ensureChatGptPage, COMPOSER_SELECTOR } from './login.js';
import { getCurrentChatGptAccount, recordChatGptFailure, recordChatGptSuccess } from '../../config/chatGptAccountTracker.js';
import { isRefusal } from '../../utils/textChecks.js';

// Runs in Node (not serialized into the browser), so it sidesteps the
// evaluate()-in-browser sandboxing issues entirely.
const turndownService = new TurndownService({
  headingStyle: 'atx',
  emDelimiter: '*',
  strongDelimiter: '**',
});
turndownService.remove(['button']);

// This is plain post text, not a markdown document that gets re-parsed
// elsewhere, so turndown's default escaping of *_[]()>#+-. etc. (e.g. "1."
// becomes "1\." to avoid ordered-list ambiguity, "[X]" becomes "\[X\]" to
// avoid link ambiguity) only produces literal backslashes when pasted into
// FB/LinkedIn. Disable it — the strongDelimiter/emDelimiter markers we do
// want (**bold**) come from actual <strong>/<em> tags, not from escape().
turndownService.escape = (str: string) => str;

// These are plain-text social posts, not markdown documents rendered
// elsewhere — a bracketed [text](url) link would show its literal brackets
// when pasted into FB/LinkedIn. Output a bare URL instead (or "text (url)"
// on the rare case the visible text differs from the href).
turndownService.addRule('plainLinks', {
  filter: 'a',
  replacement: (content, node) => {
    const href = (node as HTMLAnchorElement).getAttribute('href') || '';
    if (!href) return content;
    return !content || content.trim() === href.trim() ? href : `${content} (${href})`;
  },
});

const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"]';
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

const RESPONSE_TIMEOUT_MS = 120_000; // long prompts (2,000+ chars) can take a while to fully stream
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Opens a new chat, pastes `prompt` into the composer via the clipboard
 * (not keystroke-by-keystroke — these prompts run 2,000+ characters), submits
 * it, waits for the reply to finish streaming, and returns the assistant's
 * final message text. Throws on any failure so the caller can fall back to
 * the API path.
 */
export async function runChatGptPrompt(prompt: string): Promise<string> {
  const accountName = getCurrentChatGptAccount();
  try {
    const page = await ensureChatGptPage(accountName);

    // Start a fresh conversation each time so replies don't inherit prior context.
    // /new (not just /) forces a brand-new chat instead of possibly landing back
    // on the last active conversation.
    await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded' });
    await page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 30_000 });

    await pasteIntoComposer(page, prompt);

    const sendBtn = page.locator(SEND_BUTTON_SELECTOR).first();
    await sendBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await sendBtn.click();

    await waitForReplyToFinish(page);

    const lastMessage = page.locator(ASSISTANT_MESSAGE_SELECTOR).last();

    // Web-search citation chips ("Source Name" + "+N" pills) and the message
    // action toolbar (Edit/Copy/Regenerate/Share buttons) render as real DOM
    // nodes inside the message container, so innerText() picks up their label
    // text as if it were part of the answer. Strip both, best-effort.
    await lastMessage.evaluate((node) => {
      node.querySelectorAll(
        '[data-testid*="citation" i], a[data-testid*="citation" i], [class*="citation" i], ' +
        'button, [role="button"], [data-testid*="turn-action" i]'
      ).forEach((el) => el.remove());
    }).catch(() => { /* selector may not exist on this ChatGPT build — fall through to regex cleanup */ });

    // ChatGPT renders **bold** markdown as real <strong> HTML in the UI, so a
    // plain innerText() scrape silently loses that formatting. innerHTML() is a
    // native Playwright call (no function serialized into the page), then
    // turndown converts it back to markdown (**bold**, etc.) here in Node.
    const rawHtml = await lastMessage.innerHTML();
    const rawText = turndownService.turndown(rawHtml);

    const text = stripScrapingArtifacts(rawText);
    if (!text?.trim()) {
      throw new Error('ChatGPT: reply came back empty');
    }
    if (isRefusal(text)) {
      throw new Error('ChatGPT declined to generate (likely missing source data)');
    }
    recordChatGptSuccess();
    return text.trim();
  } catch (err: any) {
    const { rotated, account, cycleExhausted } = recordChatGptFailure();
    if (rotated) {
      err.message = `${err.message} (account "${accountName}" rotated out — next attempt uses "${account}")`;
    }
    err.chatGptCycleExhausted = cycleExhausted;
    throw err;
  }
}

const TOOLBAR_LABELS = ['Edit', 'Copy', 'Copy code', 'Regenerate', 'Regenerate response', 'Share', 'Good response', 'Bad response', 'Read aloud'];

// Second line of defense: even without matching DOM nodes above, ChatGPT's
// citation chips and message toolbar leak into innerText as standalone lines.
// - Citation chip: "Source Name" line immediately followed by a bare "+N" line
//   (e.g. "Reuters\n+1") — real post content never has a bare "+N" line.
// - Toolbar labels: bare "Edit"/"Copy"/etc. lines from the action bar.
function stripScrapingArtifacts(text: string): string {
  const toolbarPattern = TOOLBAR_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text
    .replace(/\n[ \t]*[A-Z][\w&.,'-]*(?: [A-Z][\w&.,'-]*){0,4}\n\+\d+(?=\n|$)/g, '')
    .replace(/\n\+\d+(?=\n|$)/g, '')
    .replace(new RegExp(`^[ \\t]*(${toolbarPattern})[ \\t]*\\n+`, 'i'), '')
    .replace(new RegExp(`\\n[ \\t]*(${toolbarPattern})[ \\t]*(?=\\n|$)`, 'gi'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function pasteIntoComposer(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER_SELECTOR).first();
  await composer.click();

  await page.evaluate(async (t) => {
    await navigator.clipboard.writeText(t);
  }, text);

  await page.keyboard.press('Control+V');
  await sleep(300);
}

async function waitForReplyToFinish(page: Page): Promise<void> {
  // Stop button appears while generating, then disappears once done.
  await page.locator(STOP_BUTTON_SELECTOR).first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => { /* some short replies finish before we even see the stop button */ });

  await page.locator(STOP_BUTTON_SELECTOR).first()
    .waitFor({ state: 'hidden', timeout: RESPONSE_TIMEOUT_MS });

  // The stop button can briefly flicker hidden mid-stream (observed to cause
  // truncated scrapes ending mid-sentence). Confirm it stays hidden AND the
  // message text stops growing across two checks before treating it as done;
  // if the stop button reappears, generation resumed — wait it out again.
  const lastMessage = page.locator(ASSISTANT_MESSAGE_SELECTOR).last();
  let previousLength = -1;
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    const stopVisibleAgain = await page.locator(STOP_BUTTON_SELECTOR).first().isVisible().catch(() => false);
    if (stopVisibleAgain) {
      await page.locator(STOP_BUTTON_SELECTOR).first().waitFor({ state: 'hidden', timeout: RESPONSE_TIMEOUT_MS });
      previousLength = -1;
      continue;
    }
    const currentLength = (await lastMessage.innerText().catch(() => '')).length;
    if (currentLength > 0 && currentLength === previousLength) {
      return; // stable across two consecutive checks — truly finished
    }
    previousLength = currentLength;
  }
}
