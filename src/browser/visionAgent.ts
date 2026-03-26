/**
 * visionAgent.ts — AI Vision Browser Agent
 *
 * Drives a Playwright page using Claude vision — no hardcoded selectors.
 * Loop: screenshot → Claude decides next action → execute → repeat.
 *
 * Usage:
 *   const result = await runVisionAgent(page, 'Post this tweet: "Hello world"');
 *   if (!result.success) throw new Error(result.message);
 */

import { Page } from 'playwright';
import { callOpenRouterVision } from '../config/openRouterClient.js';

const VISION_MODEL = 'anthropic/claude-3-5-sonnet';
const MAX_STEPS = 20;
const ACTION_SETTLE_MS = 1800;

// ── Action types the agent can emit ────────────────────────────────────────

interface BrowserAction {
  type: 'click' | 'type' | 'key' | 'scroll' | 'wait' | 'done' | 'error';
  /** Pixel X coordinate — for click */
  x?: number;
  /** Pixel Y coordinate — for click */
  y?: number;
  /** Text to type — for type */
  text?: string;
  /** Key to press, e.g. "Enter", "Control+Enter" — for key */
  key?: string;
  /** Scroll direction — for scroll */
  direction?: 'up' | 'down';
  /** Human-readable reason Claude gives for this action */
  reason: string;
}

// ── Vision agent loop ───────────────────────────────────────────────────────

export async function runVisionAgent(
  page: Page,
  goal: string,
  maxSteps: number = MAX_STEPS,
): Promise<{ success: boolean; message: string }> {
  console.log(`\n   🤖 Vision agent — goal: ${goal.slice(0, 80)}...`);

  const systemPrompt = `You are a browser automation agent controlling a real web browser.
You receive a screenshot of the current page and a goal to achieve.
You must return the NEXT SINGLE ACTION to take as valid JSON — no markdown, no explanation outside the JSON.

Action format:
{"type": "<action>", "x": <px>, "y": <px>, "text": "<text>", "key": "<key>", "direction": "up|down", "reason": "<why>"}

Action types:
- click   : left-click at pixel (x, y)
- type    : type text at current focus (no x/y needed)
- key     : press a keyboard key, e.g. "Enter", "Control+v", "Control+Enter"
- scroll  : scroll page (direction: "up" or "down")
- wait    : pause 2s for page to load (no other fields needed)
- done    : goal is complete — stop the loop
- error   : cannot complete goal, explain why in "reason"

Rules:
- Click buttons/inputs before typing into them
- Use clipboard paste (key: "Control+v") for large text blocks
- Always prefer clicking the visible element closest to the centre of the target
- Emit "done" as soon as the post/submit action succeeds
- If a dialog or confirmation appears unexpectedly, dismiss it and continue
- Coordinates must be within the visible viewport (1280 × 720)`;

  for (let step = 1; step <= maxSteps; step++) {
    // ── Take screenshot ────────────────────────────────────────────────────
    let base64: string;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: 1280, height: 720 } });
      base64 = buf.toString('base64');
    } catch (err: any) {
      return { success: false, message: `Screenshot failed at step ${step}: ${err.message}` };
    }

    // ── Ask Claude ────────────────────────────────────────────────────────
    let action: BrowserAction;
    try {
      const response = await callOpenRouterVision({
        model: VISION_MODEL,
        max_tokens: 250,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
            {
              type: 'text',
              text: `Goal: ${goal}\nStep: ${step}/${maxSteps}\n\nWhat is the NEXT single action?`,
            },
          ],
        }],
      });

      const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const match = raw.match(/\{[\s\S]*?\}/);
      if (!match) {
        console.warn(`   ⚠️  Step ${step}: Claude returned no JSON — waiting and retrying`);
        await page.waitForTimeout(2000);
        continue;
      }
      action = JSON.parse(match[0]) as BrowserAction;
    } catch (err: any) {
      console.warn(`   ⚠️  Step ${step}: Vision call failed — ${err.message}`);
      await page.waitForTimeout(2000);
      continue;
    }

    console.log(`   Step ${step}: [${action.type}] ${action.reason}`);

    // ── Execute action ────────────────────────────────────────────────────
    switch (action.type) {
      case 'done':
        console.log(`   ✅ Vision agent done: ${action.reason}`);
        return { success: true, message: action.reason };

      case 'error':
        console.error(`   ❌ Vision agent error: ${action.reason}`);
        return { success: false, message: action.reason };

      case 'click':
        if (typeof action.x === 'number' && typeof action.y === 'number') {
          await page.mouse.click(action.x, action.y);
        }
        break;

      case 'type':
        if (action.text) {
          // Write to clipboard then paste — preserves newlines and special chars
          await page.evaluate(async (t) => {
            await navigator.clipboard.writeText(t);
          }, action.text);
          await page.keyboard.press('Control+v');
        }
        break;

      case 'key':
        if (action.key) {
          await page.keyboard.press(action.key);
        }
        break;

      case 'scroll':
        await page.mouse.wheel(0, action.direction === 'down' ? 600 : -600);
        break;

      case 'wait':
        await page.waitForTimeout(2000);
        break;
    }

    // Let page settle after each action
    await page.waitForTimeout(ACTION_SETTLE_MS);
  }

  return { success: false, message: `Vision agent hit max steps (${maxSteps}) without completing goal` };
}
