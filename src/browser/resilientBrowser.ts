/**
 * resilientBrowser.ts — 5-Layer Fallback Click/Type Helpers
 *
 * Claude CLI calls these when a platform poster fails.
 * No AI. No vision. Pure Playwright DOM intelligence.
 *
 * Layer 1: getByRole (aria)
 * Layer 2: getByText (visible text)
 * Layer 3: locator('button').filter({ hasText })
 * Layer 4: page.accessibility.snapshot() — full tree search
 * Layer 5: page.evaluate() — raw JS innerText search
 *
 * All 5 fail → { success: false, reason: 'NEEDS_HUMAN' }
 */

import { Page } from 'playwright';
import fs from 'fs';
import path from 'path';

export type ResilientResult =
  | { success: true }
  | { success: false; reason: 'NEEDS_HUMAN' | 'RETRYABLE' | 'FIXABLE'; error: string };

export interface ClickOptions {
  role: string;           // 'button' | 'textbox' | 'menuitem' | 'link'
  name: string | RegExp;  // aria-label or visible text
  label?: string;         // used in screenshot filename on failure
  timeout?: number;       // per-layer timeout ms (default 3000)
}

export interface TypeOptions extends ClickOptions {
  text: string;
}

// ── Layer 4 helper: search accessibility snapshot ─────────────────────────

function findInSnapshot(
  node: any,
  role: string,
  name: string | RegExp
): boolean {
  if (!node) return false;
  const nameStr = node.name ?? '';
  const roleMatch = node.role === role;
  const nameMatch =
    name instanceof RegExp ? name.test(nameStr) : nameStr.toLowerCase().includes((name as string).toLowerCase());
  if (roleMatch && nameMatch) return true;
  for (const child of node.children ?? []) {
    if (findInSnapshot(child, role, name)) return true;
  }
  return false;
}

// ── Layer 5 helper: find element by innerText via raw JS ──────────────────

async function evaluateFindAndClick(page: Page, tagName: string, text: string | RegExp): Promise<boolean> {
  const textStr = text instanceof RegExp ? text.source : text;
  return page.evaluate(
    ({ tag, txt }) => {
      const els = Array.from(document.querySelectorAll(tag)) as HTMLElement[];
      const regex = new RegExp(txt, 'i');
      const match = els.find(el => regex.test(el.innerText?.trim() ?? ''));
      if (match) { match.click(); return true; }
      return false;
    },
    { tag: tagName, txt: textStr }
  );
}

// ── Main: resilientClick ──────────────────────────────────────────────────

export async function resilientClick(
  page: Page,
  options: ClickOptions
): Promise<ResilientResult> {
  const { role, name, label = 'element', timeout = 3000 } = options;
  const errors: string[] = [];

  // Layer 1: aria getByRole
  try {
    const loc = page.getByRole(role as any, { name });
    await loc.first().waitFor({ state: 'visible', timeout });
    await loc.first().click({ force: true });
    console.log(`   [resilient] Layer1 (aria) clicked: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L1: ${e.message}`); }

  // Layer 2: getByText
  try {
    const loc = page.getByText(name instanceof RegExp ? name : new RegExp(name, 'i')).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click({ force: true });
    console.log(`   [resilient] Layer2 (text) clicked: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L2: ${e.message}`); }

  // Layer 3: locator filter
  try {
    const tagMap: Record<string, string> = { button: 'button', link: 'a', textbox: 'input,textarea', menuitem: '[role="menuitem"]' };
    const tag = tagMap[role] ?? role;
    const loc = page.locator(tag).filter({ hasText: name instanceof RegExp ? name : new RegExp(name, 'i') }).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click({ force: true });
    console.log(`   [resilient] Layer3 (filter) clicked: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L3: ${e.message}`); }

  // Layer 4: accessibility snapshot
  try {
    const snapshot = await page.accessibility.snapshot();
    const found = findInSnapshot(snapshot, role, name);
    if (found) {
      // snapshot found it — try clicking via text again with broader selector
      const nameStr = name instanceof RegExp ? name.source : name;
      const loc = page.locator(`[aria-label]`).filter({ hasText: new RegExp(nameStr, 'i') }).first();
      if (await loc.isVisible({ timeout }).catch(() => false)) {
        await loc.click({ force: true });
        console.log(`   [resilient] Layer4 (a11y tree) clicked: ${label}`);
        return { success: true };
      }
    }
    errors.push(`L4: not found in a11y tree`);
  } catch (e: any) { errors.push(`L4: ${e.message}`); }

  // Layer 5: raw JS evaluate
  try {
    const tagMap: Record<string, string> = { button: 'button', link: 'a', textbox: 'input', menuitem: '[role="menuitem"]' };
    const tag = tagMap[role] ?? 'button';
    const clicked = await evaluateFindAndClick(page, tag, name);
    if (clicked) {
      console.log(`   [resilient] Layer5 (JS eval) clicked: ${label}`);
      return { success: true };
    }
    errors.push(`L5: element not found via JS`);
  } catch (e: any) { errors.push(`L5: ${e.message}`); }

  // All 5 failed
  const errorMsg = errors.join(' | ');
  console.error(`   [resilient] ALL layers failed for: ${label} — ${errorMsg}`);
  await saveScreenshot(page, label).catch(() => {});
  return { success: false, reason: 'NEEDS_HUMAN', error: errorMsg };
}

// ── resilientType ─────────────────────────────────────────────────────────

export async function resilientType(
  page: Page,
  options: TypeOptions
): Promise<ResilientResult> {
  const { role, name, text, label = 'textbox', timeout = 3000 } = options;
  const errors: string[] = [];

  // Layer 1: aria getByRole
  try {
    const loc = page.getByRole(role as any, { name });
    await loc.first().waitFor({ state: 'visible', timeout });
    await loc.first().click();
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press('Control+v');
    console.log(`   [resilient] Layer1 (aria) typed into: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L1: ${e.message}`); }

  // Layer 2: getByPlaceholder
  try {
    const nameStr = name instanceof RegExp ? name.source : name as string;
    const loc = page.getByPlaceholder(new RegExp(nameStr, 'i')).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press('Control+v');
    console.log(`   [resilient] Layer2 (placeholder) typed into: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L2: ${e.message}`); }

  // Layer 3: contenteditable
  try {
    const loc = page.locator('[contenteditable="true"]').first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press('Control+v');
    console.log(`   [resilient] Layer3 (contenteditable) typed into: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L3: ${e.message}`); }

  // Layer 4: any input/textarea visible
  try {
    const loc = page.locator('input:visible, textarea:visible').first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press('Control+v');
    console.log(`   [resilient] Layer4 (input visible) typed into: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L4: ${e.message}`); }

  // Layer 5: focused element via JS
  try {
    await page.evaluate((t) => {
      const el = document.activeElement as HTMLElement;
      if (el) {
        el.focus();
        navigator.clipboard.writeText(t);
      }
    }, text);
    await page.keyboard.press('Control+v');
    console.log(`   [resilient] Layer5 (active element) typed into: ${label}`);
    return { success: true };
  } catch (e: any) { errors.push(`L5: ${e.message}`); }

  const errorMsg = errors.join(' | ');
  console.error(`   [resilient] ALL layers failed for type: ${label} — ${errorMsg}`);
  await saveScreenshot(page, label).catch(() => {});
  return { success: false, reason: 'NEEDS_HUMAN', error: errorMsg };
}

// ── saveScreenshot ────────────────────────────────────────────────────────

export async function saveScreenshot(page: Page, label: string): Promise<string> {
  const dir = path.resolve('screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${label.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}.png`;
  const filepath = path.join(dir, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`   📸 Screenshot saved: ${filepath}`);
  return filepath;
}

// ── Error classifier (for Claude to use when reading tool output) ─────────

export type ErrorReason = 'RETRYABLE' | 'NEEDS_HUMAN' | 'FATAL' | 'FIXABLE';

export function classifyError(error: string): ErrorReason {
  const e = error.toLowerCase();
  if (e.includes('otp') || e.includes('captcha') || e.includes('verification') ||
      e.includes('2fa') || e.includes('confirm your') || e.includes('verify your') ||
      e.includes('unusual activity') || e.includes('challenge')) return 'NEEDS_HUMAN';
  if (e.includes('suspended') || e.includes('locked') || e.includes('banned') ||
      e.includes('disabled') || e.includes('account restricted')) return 'FATAL';
  if (e.includes('timeout') || e.includes('net::') || e.includes('navigation') ||
      e.includes('network') || e.includes('econnreset') || e.includes('socket')) return 'RETRYABLE';
  return 'FIXABLE';
}

