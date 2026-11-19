#!/usr/bin/env node
/**
 * devRun.mjs — the development launcher (Milestone 0, safety harness).
 *
 * Runs any entry point of this repository with:
 *   - KEN_ENV forced to "development"
 *   - the working directory set to the development sandbox, which redirects
 *     .sessions/, logs/, .accounts/ and data/ away from the repository's own
 *     (production) state with no source change
 *   - the tsx loader referenced by ABSOLUTE path into this repository's
 *     installed node_modules
 *
 * The absolute loader path matters. Verified on this machine:
 *   cwd inside the repo  + bare `--import=tsx` -> works (node walks up)
 *   cwd outside the repo + bare `--import=tsx` -> ERR_MODULE_NOT_FOUND
 *   any cwd              + absolute loader url -> works
 * Using the absolute form means the sandbox may live anywhere.
 *
 * Plain .mjs on purpose: the launcher must not itself need tsx to start.
 *
 * Usage:
 *   npm run dev:sandbox -- src/index.ts once
 *   KEN_DEV_SANDBOX=D:/ken-dev npm run dev:sandbox -- src/index.ts
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX = path.resolve(process.env.KEN_DEV_SANDBOX || path.join(REPO_ROOT, 'dev-sandbox'));
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

function fail(msg) {
  console.error(`\n[devRun] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(TSX_LOADER)) {
  fail(`tsx loader not found at ${TSX_LOADER}. Run "npm ci" in ${REPO_ROOT} first.`);
}

if (path.resolve(SANDBOX) === path.resolve(REPO_ROOT)) {
  fail(
    `The development sandbox resolves to the repository root (${REPO_ROOT}).\n` +
    `That would give a development run the repository's own .sessions/, logs/\n` +
    `and .accounts/ — the exact isolation this launcher exists to provide.`
  );
}

for (const dir of ['.sessions', 'logs', '.accounts', 'data']) {
  fs.mkdirSync(path.join(SANDBOX, dir), { recursive: true });
}

const args = process.argv.slice(2);
if (args.length === 0) fail('No entry point given. Example: npm run dev:sandbox -- src/index.ts once');

// Resolve a repo-relative entry point against the REPO, not the sandbox.
const entry = path.isAbsolute(args[0]) ? args[0] : path.join(REPO_ROOT, args[0]);
if (!fs.existsSync(entry)) fail(`Entry point not found: ${entry}`);

const env = { ...process.env, KEN_ENV: 'development' };

console.log(`[devRun] KEN_ENV=development`);
console.log(`[devRun] sandbox : ${SANDBOX}`);
console.log(`[devRun] entry   : ${entry}`);

const child = spawn(
  process.execPath,
  [`--import=${pathToFileURL(TSX_LOADER).href}`, entry, ...args.slice(1)],
  { cwd: SANDBOX, env, stdio: 'inherit' },
);

child.on('exit', code => process.exit(code ?? 1));
