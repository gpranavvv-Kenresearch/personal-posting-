/**
 * accounts.ts — Accounts Manager
 * Manages X account credentials stored in .accounts/accounts.json
 *
 * Usage:
 *   npx tsx src/config/accounts.ts add    → interactive add account
 *   npx tsx src/config/accounts.ts list   → list all accounts
 *   npx tsx src/config/accounts.ts remove → remove an account
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const ACCOUNTS_FILE = '.accounts/accounts.json';

export interface XAccount {
  handle: string;
  username: string;
  password: string;
  sessionDir: string;
  sessionStatePath?: string;
  storageState?: string;
  nickname?: string;
  active: boolean;
}

export type Account = XAccount;

// ── Read all accounts ──────────────────────────────────────────────────────

export function getAccounts(): XAccount[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

export function getActiveAccounts(): XAccount[] {
  return getAccounts().filter(a => a.active);
}

export function getNextAccount(accounts: XAccount[]): XAccount {
  const active = accounts.filter(a => a.active);
  if (active.length === 0) throw new Error('No active accounts found. Run: npx tsx src/config/accounts.ts add');
  return active[0];
}

export function getAccountByHandle(handle: string): XAccount | undefined {
  const q = handle.toLowerCase();
  return getAccounts().find(a =>
    a.handle.toLowerCase() === q || a.nickname?.toLowerCase() === q
  );
}

// ── Write accounts ─────────────────────────────────────────────────────────

function saveAccounts(accounts: XAccount[]) {
  fs.mkdirSync('.accounts', { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function addAccount(account: Omit<XAccount, 'sessionDir' | 'active'>) {
  const accounts = getAccounts();
  const existing = accounts.findIndex(a => a.handle === account.handle);
  const full: XAccount = {
    ...account,
    sessionDir: `.sessions/chrome-${account.handle}`,
    active: true,
  };
  if (existing >= 0) {
    accounts[existing] = full;
    console.log(`✅ Updated @${account.handle}`);
  } else {
    accounts.push(full);
    console.log(`✅ Added @${account.handle}`);
  }
  saveAccounts(accounts);
  fs.mkdirSync(full.sessionDir, { recursive: true });
}

function removeAccount(handle: string) {
  const accounts = getAccounts().filter(a => a.handle !== handle);
  saveAccounts(accounts);
  console.log(`🗑️  Removed @${handle}`);
}

function toggleAccount(handle: string) {
  const accounts = getAccounts();
  const acc = accounts.find(a => a.handle === handle);
  if (!acc) { console.log('Account not found'); return; }
  acc.active = !acc.active;
  saveAccounts(accounts);
  console.log(`${acc.active ? '✅ Enabled' : '⏸️  Disabled'} @${handle}`);
}

// ── CLI interface ──────────────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function cliAdd() {
  console.log('\n➕ Add X Account\n');
  const handle   = await prompt('Handle (without @): ');
  const username = await prompt('Username / Email: ');
  const password = await prompt('Password: ');
  addAccount({ handle, username, password });
}

async function cliRemove() {
  const accounts = getAccounts();
  if (!accounts.length) { console.log('No accounts found.'); return; }
  console.log('\nAccounts:');
  accounts.forEach((a, i) => console.log(`  ${i + 1}. @${a.handle} [${a.active ? 'active' : 'disabled'}]`));
  const input = await prompt('\nEnter handle to remove: ');
  removeAccount(input.replace('@', ''));
}

function cliList() {
  const accounts = getAccounts();
  if (!accounts.length) { console.log('No accounts found. Run: npx tsx src/config/accounts.ts add'); return; }
  console.log('\n📋 X Accounts:\n');
  accounts.forEach((a, i) => {
    console.log(`  ${i + 1}. @${a.handle}`);
    console.log(`     Username : ${a.username}`);
    console.log(`     Session  : ${a.sessionDir}`);
    console.log(`     Status   : ${a.active ? '✅ active' : '⏸️  disabled'}`);
    console.log();
  });
}

// Run CLI if called directly
const isMain = process.argv[1]?.endsWith('accounts.ts') || process.argv[1]?.endsWith('accounts.js');
if (isMain) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'add')    { await cliAdd(); }
    else if (cmd === 'remove') { await cliRemove(); }
    else if (cmd === 'toggle') {
      const handle = process.argv[3];
      if (!handle) { console.log('Usage: accounts.ts toggle <handle>'); }
      else toggleAccount(handle);
    }
    else { cliList(); }
  })();
}
