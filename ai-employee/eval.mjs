import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAgent } from './lib/agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const allCases = JSON.parse(await fs.readFile(path.join(here, 'eval', 'cases.json'), 'utf8'));
const requestedIds = new Set(process.argv.slice(2));
const cases = requestedIds.size ? allCases.filter(item => requestedIds.has(item.id)) : allCases;
if (!cases.length) throw new Error('No evaluation case matched the requested IDs');
let failed = 0;
for (const item of cases) {
  try {
    const startedAt = Date.now();
    const result = await runAgent(item.prompt);
    const answer = result.answer.toLowerCase();
    const positive = item.mustContainAny.some(term => answer.includes(term.toLowerCase()));
    const negative = item.mustNotContain.some(term => answer.includes(term.toLowerCase()));
    const pass = positive && !negative;
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${item.id} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    if (!pass) console.log(result.answer);
  } catch (error) {
    failed++;
    console.log(`FAIL ${item.id} (${error.message})`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} evaluation cases passed.`);
if (failed) process.exitCode = 1;
