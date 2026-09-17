// LinkedIn post generation via the ChatGPT browser session (Playwright), using
// the hook-formula system from https://github.com/sergebulaev/linkedin-skills
// (skills/linkedin-post-writer/SKILL.md), condensed into a single prompt.
import fs from 'fs';
import path from 'path';
import { runChatGptPrompt } from '../browser/chatgpt/promptRunner.js';

const OUTPUT_DIR = path.resolve('.generated/linkedin-posts');

export type LinkedinPostGoal = 'comments' | 'reposts' | 'likes' | 'saves';
export type LinkedinPostLength = 'short' | 'medium' | 'long';

const LENGTH_RANGES: Record<LinkedinPostLength, string> = {
  short: '300-500 characters',
  medium: '900-1,300 characters',
  long: '1,500-1,900 characters',
};

// Formula shortlist by goal, per the skill's "Pick by goal first" table.
const GOAL_FORMULAS: Record<LinkedinPostGoal, string> = {
  comments: 'F17 Controlled A/B Anecdote, F10 Contrarian + Historical Receipts, or F19 Anecdote-Meets-Evidence Bridge',
  reposts: 'F14 Named Gratitude/Tribute, F2 R.I.P. Obituary, or F20 Diverging-Curves Close',
  likes: 'F11 Emotional Cold-Open, F13 Bait-and-Switch Reversal, or F16 Status-Strip Humility',
  saves: 'F15 Explain-to-Kids, F7 Odd-Precision Money Ledger, or F8 Paid-vs-Free Reversal',
};

export function buildLinkedinPostWriterPrompt(params: {
  topic: string;
  url?: string;
  goal?: LinkedinPostGoal;
  audience?: string;
  length?: LinkedinPostLength;
}): string {
  const goal = params.goal || 'comments';
  const length = params.length || 'medium';
  const audience = params.audience || 'operators, founders and decision-makers evaluating market data';

  return [
    `Write ONE LinkedIn post for Ken Research (a market research and consulting firm) about: "${params.topic}".`,
    params.url ? `Reference report/source URL to weave in naturally (once, near the end): ${params.url}` : '',
    ``,
    `TARGET AUDIENCE: ${audience}`,
    `ENGAGEMENT GOAL: ${goal}. Favor one of these formulas: ${GOAL_FORMULAS[goal]}.`,
    `LENGTH: ${LENGTH_RANGES[length]} — this is a hard range, do not go under or over it.`,
    ``,
    `STRUCTURE RULES (2026 LinkedIn algorithm):`,
    `- Line 1 is a statement or a number — never a question, never "Here's what/how", never "Stop X, start Y", never ALL CAPS.`,
    `- Prefer a number-first opening line (an odd-precision stat, a year, a dollar figure).`,
    `- Double line-breaks between ideas, 1-2 sentence paragraphs.`,
    `- One contrast and one triple maximum in the whole post. No "The result?" / "Plot twist:" / "Here's what" reveal bridges.`,
    `- Include at least one moment of real specificity (a number, a named market/sector, a concrete detail) per 100 words.`,
    `- Close with a specific question (not the opening hook), and optionally a one-line "P.S." with a genuine follow-up.`,
    `- 0-2 hashtags placed at the very end. No links inside the body — if a URL is given above, mention it as plain text only near the close.`,
    `- Mention Ken Research at most once, only if it reads as the natural source of the data, never as a pitch.`,
    ``,
    `HARD ANTI-PATTERNS (reject internally and rewrite if present):`,
    `- Question as the first line; ALL-CAPS first line`,
    `- "Let me be honest" / "Confession:" framing without a real dated fact behind it`,
    `- "Comment X to get Y" gating`,
    `- More than about one em dash per 100 words`,
    `- "In today's fast-paced world", "game-changer", "deep dive", "leverage", "fundamentally"`,
    `- Rule-of-three lists with no receipts (numbers/specifics behind each item)`,
    `- Generic closers like "tag someone who needs this"`,
    ``,
    `SOURCING RULE: cite only Ken Research's own research and government/regulatory bodies (e.g. official statistics agencies, central banks, ministries). Never name or cite any competitor market-research or consulting firm.`,
    `HARD CHARACTER CAP: the entire post (including any link mention) must stay under 2,280 characters total.`,
    ``,
    `OUTPUT: return ONLY the finished LinkedIn post text — no formula name, no preamble, no explanation, no markdown code fences.`,
  ].filter(Boolean).join('\n');
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'post';
}

function recordResponse(topic: string, prompt: string, response: string): string {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUTPUT_DIR, `${slugify(topic)}-${stamp}.txt`);
  fs.writeFileSync(file, `PROMPT:\n${prompt}\n\n---\n\nRESPONSE:\n${response}\n`, 'utf8');
  return file;
}

const RETRY_DELAY_MS = 3000;
const COOLDOWN_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Sends the LinkedIn post-writer prompt to ChatGPT via the existing Playwright
 * browser session (src/browser/chatgpt) and records the raw response to
 * .generated/linkedin-posts/. Retries across accounts on failure the same way
 * contentAgentNew's FB/LI generation does — no API fallback, ChatGPT browser only.
 */
export async function generateLinkedinPostViaChatGpt(params: {
  topic: string;
  url?: string;
  goal?: LinkedinPostGoal;
  audience?: string;
  length?: LinkedinPostLength;
  maxAttempts?: number;
}): Promise<{ text: string; savedTo: string }> {
  const prompt = buildLinkedinPostWriterPrompt(params);
  const maxAttempts = params.maxAttempts ?? Infinity;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`   [linkedin-post-writer] Sending prompt for: "${params.topic}" (attempt ${attempt})...`);
      const text = await runChatGptPrompt(prompt);
      const savedTo = recordResponse(params.topic, prompt, text);
      console.log(`   [linkedin-post-writer] Response recorded -> ${savedTo}`);
      return { text, savedTo };
    } catch (err: any) {
      console.warn(`   ⚠️  [linkedin-post-writer] attempt failed (${err.message})`);
      if (attempt >= maxAttempts) throw err;
      if (err.chatGptCycleExhausted) {
        console.warn('   ⚠️  [linkedin-post-writer] every saved ChatGPT account failed a full cycle — waiting 10 minutes');
        await sleep(COOLDOWN_MS);
      } else {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error('generateLinkedinPostViaChatGpt: exhausted attempts');
}
