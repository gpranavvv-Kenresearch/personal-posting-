/**
 * ledgerSeed.ts — mark today's slots up to a given IST time as already done,
 * so the catch-up sweeper does NOT re-run batches that an earlier daemon
 * already ran.
 *
 *   npm run ledger:seed -- 15:45      # everything scheduled at/before 15:45 IST = done
 *   npm run ledger:seed               # everything scheduled before now = done
 *
 * Stop the daemon first (Ctrl+C on the supervisor), run this, then start
 * `npm run dev:supervised` again.
 */
import 'dotenv/config';
import { DAILY_SLOTS } from '../scheduler-new.js';
import { seedLedgerBefore, ledgerSummary, nowIstString } from '../batchLedger.js';

const arg = process.argv[2];
let hhmm = arg;
if (!hhmm) {
  const t = nowIstString().replace(' IST', '');
  hhmm = t;
}
if (!/^\d{1,2}:\d{2}$/.test(hhmm)) {
  console.error(`Usage: npm run ledger:seed -- HH:MM   (got "${arg}")`);
  process.exit(1);
}
const seeded = seedLedgerBefore(DAILY_SLOTS, hhmm, 'seeded manually via ledger:seed');
console.log(`Marked ${seeded.length} slot(s) at/before ${hhmm} IST as done:${seeded.length ? '\n  - ' + seeded.join('\n  - ') : ' (none — already in ledger)'}`);
console.log(JSON.stringify(ledgerSummary(), null, 2));
process.exit(0);
