/**
 * autoFix.ts — Resolution Executor
 *
 * Applies known fixes for classified errors inline during batch processing.
 * Rules:
 *   - Session/config fixes: applied immediately, automatically
 *   - Code fixes: written to logs/human-alerts.json for Claude CLI to handle
 *   - Never retries the failed row — fix is verified on the NEXT row
 */

import fs from 'fs';
import path from 'path';
import type { ErrorKBEntry, ResolutionType } from './errorInterceptor.js';

const HUMAN_ALERTS_FILE  = path.resolve('logs/human-alerts.json');
const SKIP_ACCOUNTS_FILE = path.resolve('.sessions/skip-accounts.json');

export interface FixResult {
  applied: boolean;
  action: ResolutionType | 'none';
  description: string;
  requiresHumanReview: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendHumanAlert(alert: object): void {
  try {
    fs.mkdirSync(path.dirname(HUMAN_ALERTS_FILE), { recursive: true });
    let alerts: any[] = [];
    try { alerts = JSON.parse(fs.readFileSync(HUMAN_ALERTS_FILE, 'utf-8')); } catch { /* new file */ }
    alerts.unshift({ ...alert, ts: new Date().toISOString() });
    alerts = alerts.slice(0, 50); // keep last 50 alerts
    fs.writeFileSync(HUMAN_ALERTS_FILE, JSON.stringify(alerts, null, 2));
  } catch { /* non-critical */ }
}

function loadSkipAccounts(): Array<{ platform: string; account: string; isPermanent: boolean }> {
  try { return JSON.parse(fs.readFileSync(SKIP_ACCOUNTS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveSkipAccounts(list: Array<{ platform: string; account: string; isPermanent: boolean }>): void {
  try {
    fs.mkdirSync(path.dirname(SKIP_ACCOUNTS_FILE), { recursive: true });
    fs.writeFileSync(SKIP_ACCOUNTS_FILE, JSON.stringify(list, null, 2));
  } catch { /* non-critical */ }
}

// ── Session directory resolver ────────────────────────────────────────────────

function resolveSessionDir(platform: string, accountName?: string): string | null {
  const sessionRoot = path.resolve('.sessions');
  const platformMap: Record<string, string> = {
    x: 'x', twitter: 'x',
    facebook: 'facebook', fb: 'facebook',
    linkedin: 'linkedin', li: 'linkedin',
    medium: 'medium',
    hackmd: 'hackmd',
    substack: 'substack',
    linkmate: 'linkmate',
    googlesite: 'googlesite',
    devto: 'devto',
    calisthenics: 'calisthenics',
  };

  const folder = platformMap[platform.toLowerCase()] ?? platform.toLowerCase();
  if (accountName) {
    const safe = accountName.replace(/[^a-z0-9_-]/gi, '_');
    return path.join(sessionRoot, folder, safe);
  }
  return path.join(sessionRoot, folder);
}

function clearSessionDir(dirPath: string): boolean {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`   🧹 Session cleared: ${dirPath}`);
      return true;
    }
    return false;
  } catch (err: any) {
    console.warn(`   ⚠️ Could not clear session dir ${dirPath}: ${err.message}`);
    return false;
  }
}

// ── Close browser helpers (dynamic import to avoid circular deps) ─────────────

async function closePlatformBrowser(platform: string): Promise<void> {
  try {
    const { closeAllBrowsers } = await import('./tools/browserTools.js');
    await closeAllBrowsers();
  } catch (err: any) {
    console.warn(`   ⚠️ Could not close browser for ${platform}: ${err.message}`);
  }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function applyFix(
  entry: ErrorKBEntry,
  context: { platform: string; accountName?: string; rowIndex?: number }
): Promise<FixResult> {
  const { resolution_type, diagnosis, normalizedPattern } = entry;

  switch (resolution_type) {

    case 'wait-and-retry':
      // Caller's batch loop handles skipping — we just signal it was "handled"
      return {
        applied: true,
        action: 'wait-and-retry',
        description: 'Transient error — row skipped, next row will proceed normally',
        requiresHumanReview: false,
      };

    case 'clear-session': {
      const sessionDir = resolveSessionDir(context.platform, context.accountName);
      let cleared = false;
      if (sessionDir) {
        cleared = clearSessionDir(sessionDir);
        // Also try without accountName in case per-account dir not found
        if (!cleared) {
          const rootDir = resolveSessionDir(context.platform);
          if (rootDir) cleared = clearSessionDir(rootDir);
        }
      }
      return {
        applied: cleared,
        action: 'clear-session',
        description: cleared
          ? `Session cleared for ${context.accountName ?? context.platform} — will re-login on next run`
          : `Session dir not found for ${context.platform}`,
        requiresHumanReview: false,
      };
    }

    case 'restart-browser':
      await closePlatformBrowser(context.platform);
      return {
        applied: true,
        action: 'restart-browser',
        description: `Browser context closed for ${context.platform} — will relaunch on next row`,
        requiresHumanReview: false,
      };

    case 'rotate-account': {
      if (context.accountName) {
        const list = loadSkipAccounts();
        const alreadySkipped = list.some(
          s => s.platform === context.platform && s.account === context.accountName
        );
        if (!alreadySkipped) {
          list.push({ platform: context.platform, account: context.accountName, isPermanent: false });
          saveSkipAccounts(list);
        }
      }
      return {
        applied: true,
        action: 'rotate-account',
        description: `Account ${context.accountName ?? 'unknown'} skipped for ${context.platform} this session`,
        requiresHumanReview: false,
      };
    }

    case 'fatal-skip': {
      if (context.accountName) {
        const list = loadSkipAccounts();
        const exists = list.some(
          s => s.platform === context.platform && s.account === context.accountName && s.isPermanent
        );
        if (!exists) {
          list.push({ platform: context.platform, account: context.accountName, isPermanent: true });
          saveSkipAccounts(list);
          console.log(`   🚫 FATAL: ${context.accountName} permanently skipped on ${context.platform}`);
        }
      }
      return {
        applied: true,
        action: 'fatal-skip',
        description: `Account ${context.accountName ?? 'unknown'} permanently banned/suspended on ${context.platform}`,
        requiresHumanReview: false,
      };
    }

    case 'skip-row':
      // masterCoordinator already handles this — nothing to do
      return {
        applied: false,
        action: 'skip-row',
        description: 'Row skipped by batch logic',
        requiresHumanReview: false,
      };

    case 'human-review-login':
    case 'human-review-code': {
      appendHumanAlert({
        type: resolution_type,
        platform: context.platform,
        account: context.accountName ?? 'unknown',
        rowIndex: context.rowIndex,
        errorPattern: normalizedPattern,
        diagnosis: diagnosis ?? 'No diagnosis available yet — run monitor cycle',
      });
      return {
        applied: false,
        action: resolution_type,
        description: `Human review needed for ${context.platform} — see logs/human-alerts.json`,
        requiresHumanReview: true,
      };
    }

    default:
      return {
        applied: false,
        action: 'none',
        description: `No resolution configured for type: ${resolution_type}`,
        requiresHumanReview: true,
      };
  }
}

// ── Check if account is in skip list ─────────────────────────────────────────

export function isAccountSkipped(platform: string, accountName: string): boolean {
  const list = loadSkipAccounts();
  return list.some(s => s.platform === platform && s.account === accountName);
}
