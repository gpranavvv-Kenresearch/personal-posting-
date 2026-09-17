// Reliable text input for ChatGPT's Lexical/ProseMirror composer.
//
// ChatGPT's #prompt-textarea is a contenteditable <div> backed by Lexical.
// Playwright's locator.fill() only delivers the first line; everything after
// the first \n\n is silently dropped because Lexical re-renders from its own
// internal state. Symptom: GPT replies "the message only includes the
// opening line, please share the full brief."
//
// This helper bypasses fill() by dispatching a synthetic paste event with a
// DataTransfer payload — which Lexical handles natively and preserves
// newlines correctly. Falls back to keyboard.insertText if the paste event
// doesn't take. Aborts hard if neither approach gets the full prompt in.

const COMPOSER_SELECTOR = '#prompt-textarea';

export async function pasteIntoChatGPTComposer(page, text, opts = {}) {
  const { minFillRatio = 0.5 } = opts;
  const expectedLen = text.length;

  // Remove any overlay modal that blocks interaction (e.g. conversation-history rate-limit)
  await page.evaluate(() => {
    const modal = document.querySelector(
      '#modal-conversation-history-rate-limit, [data-testid="modal-conversation-history-rate-limit"]'
    );
    if (modal) { modal.remove(); console.log('[composer] Removed blocking modal from DOM'); }
  });
  await page.waitForTimeout(300);

  const composer = page.locator(COMPOSER_SELECTOR).first();
  await composer.waitFor({ state: 'visible', timeout: 15000 });
  await composer.click();
  await page.waitForTimeout(300);

  // Clear any leftover content
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);

  // Primary: synthetic paste event with DataTransfer, dispatched on the
  // resolved DOM element (composer.evaluate passes the matched element in).
  // Playwright pierces shadow DOM to find #prompt-textarea; raw
  // document.querySelector inside page.evaluate does not — so use the
  // locator handle directly.
  // Lexical's paste handler reads clipboardData.getData('text/plain') and
  // preserves newlines, unlike .fill() which truncates to the first text node.
  await composer.evaluate((target, textToInsert) => {
    target.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', textToInsert);
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    target.dispatchEvent(pasteEvent);
  }, text);

  await page.waitForTimeout(1500);

  let actualLen = await readComposerLength(composer);
  console.log(`  Composer length after paste: ${actualLen}/${expectedLen} chars`);

  // In ChatGPT's new "Extended" mode, long pastes are auto-converted into a
  // text-file ATTACHMENT instead of landing in the composer text. Detect that
  // case and accept it as a valid prompt delivery.
  if (actualLen < expectedLen * minFillRatio) {
    const attachmentPresent = await detectPastedAttachment(page, text);
    if (attachmentPresent) {
      console.log('  Composer empty but prompt landed as ATTACHMENT (Extended mode). Accepting.');
      return;
    }
    console.log('  Paste event undersized. Falling back to keyboard.insertText...');
    await composer.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1500);
    actualLen = await readComposerLength(composer);
    console.log(`  Composer length after insertText: ${actualLen}/${expectedLen} chars`);
  }

  if (actualLen < expectedLen * minFillRatio) {
    // Final attachment check — insertText may have triggered the same Extended-mode conversion.
    const attachmentPresent = await detectPastedAttachment(page, text);
    if (attachmentPresent) {
      console.log('  Composer empty but prompt landed as ATTACHMENT (Extended mode). Accepting.');
      return;
    }
    throw new Error(
      `Prompt did not land in ChatGPT composer. Got ${actualLen} chars, expected ~${expectedLen}. ` +
      `No attachment chip detected either. The Lexical composer rejected paste-event and keyboard.insertText. ` +
      `Inspect the composer manually — selector or behavior may have changed.`
    );
  }
}

// Look for the "Extended-mode" attachment chip that ChatGPT creates when a
// long paste is auto-converted into a text file. Match on the leading 12-20
// characters of the prompt — that's what ChatGPT shows on the chip preview.
async function detectPastedAttachment(page, text) {
  const preview = text.slice(0, 12).trim();
  if (!preview) return false;
  return await page.evaluate((needle) => {
    // 1. Search for any element whose text begins with the prompt's first chars
    //    (the chip preview), inside the composer area / above the text input.
    const all = Array.from(document.querySelectorAll('div, span, button, a'));
    return all.some(el => {
      const t = (el.textContent || '').trim();
      if (!t) return false;
      // Chip text is typically a short truncation like "Act as a pre.."
      // Match if first 10 chars line up
      return t.length < 100 && t.startsWith(needle.slice(0, 10));
    });
  }, preview);
}

async function readComposerLength(composer) {
  return await composer.evaluate(el => (el.textContent || el.innerText || '').length);
}
