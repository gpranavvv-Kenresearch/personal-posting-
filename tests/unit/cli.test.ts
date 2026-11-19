/**
 * cli.test.ts — the intelligence CLI.
 *
 * Scope, deliberately: argument parsing, masking/redaction, credential
 * detection, and the EMPTY-DATABASE rendering of every command. The empty
 * database is the important case — a human's first ever run hits it, and a
 * crash there is the difference between "this tool works" and "this tool is
 * broken".
 *
 * No test here touches a live API. Every feature flag is cleared before the
 * suite runs, so every collector short-circuits before any network call, and
 * every database is a throwaway file in the OS temp directory.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  parseArgs, flagStr, flagNum, flagBool, flagLimit, flagDays, MAX_LIMIT, MAX_DAYS,
  maskSecret, maskEmail, redactMessage,
  checkCredentials, formatCredentials, formatFlags,
  formatScoreTable, formatTableCounts, formatProposals, formatHelp,
  tableCounts, knownReportUrls, recentPublishedPosts, proposalsByStatus,
  formatCalibrationHistory,
  bufferOut, runCli, COMMANDS, VALUE_FLAGS,
} from '../../src/intelligence/cli.js';
import { openDb } from '../../src/intelligence/db.js';

// ── Isolation ────────────────────────────────────────────────────────────────

const FEATURE_VARS = [
  'FEATURE_INTELLIGENCE', 'FEATURE_GSC_COLLECTION', 'FEATURE_GA4_COLLECTION',
  'FEATURE_PIPEDRIVE_COLLECTION', 'FEATURE_INDEXATION_CHECKS',
  'FEATURE_OPPORTUNITY_SCORING', 'FEATURE_SCORING_INFLUENCES_ORDER',
  'FEATURE_PLATFORM_INTELLIGENCE', 'FEATURE_CONTENT_INTELLIGENCE',
  'FEATURE_INTERLINKING_PROPOSALS', 'FEATURE_INTERLINKING_APPLY',
];

let tmpDir = '';
let dbFile = '';

before(() => {
  for (const v of FEATURE_VARS) delete process.env[v];
  process.env.FEATURE_SHADOW_MODE = 'true';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-cli-'));
  dbFile = path.join(tmpDir, 'intelligence.db');
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* WAL may linger */ }
});

function freshDbFile(name: string): string {
  return path.join(tmpDir, `${name}.db`);
}

// ── Argument parsing ─────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('defaults to status when nothing is given', () => {
    const a = parseArgs([]);
    assert.equal(a.command, 'status');
    assert.deepEqual(a.positionals, []);
  });

  test('takes the first positional as the command', () => {
    assert.equal(parseArgs(['platforms']).command, 'platforms');
  });

  test('keeps later positionals as arguments', () => {
    const a = parseArgs(['approve', '17']);
    assert.equal(a.command, 'approve');
    assert.deepEqual(a.positionals, ['17']);
  });

  test('parses --name=value', () => {
    const a = parseArgs(['score', '--days=30']);
    assert.equal(flagStr(a, 'days'), '30');
    assert.equal(flagNum(a, 'days', 7), 30);
  });

  test('parses --name value for value-taking flags only', () => {
    const a = parseArgs(['score', '--limit', '5']);
    assert.equal(flagStr(a, 'limit'), '5');
    assert.deepEqual(a.positionals, []);
    assert.ok(VALUE_FLAGS.has('limit'));
  });

  test('treats an unknown --name as a boolean, not a value eater', () => {
    const a = parseArgs(['apply', '--apply', 'extra']);
    assert.equal(a.flags.apply, true);
    assert.deepEqual(a.positionals, ['extra']);
  });

  test('--apply is a boolean flag, never a positional', () => {
    const a = parseArgs(['apply', '--apply']);
    assert.equal(flagBool(a, 'apply'), true);
    assert.equal(flagBool(parseArgs(['apply']), 'apply'), false);
  });

  test('-h and --help set help', () => {
    assert.equal(parseArgs(['-h']).command, 'help');
    assert.equal(parseArgs(['--help']).flags.help, true);
  });

  test('everything after -- is positional', () => {
    const a = parseArgs(['approve', '--', '--weird-id']);
    assert.deepEqual(a.positionals, ['--weird-id']);
  });

  test('--by carries a multi-word value', () => {
    const a = parseArgs(['approve', '12', '--by=Abhinav K']);
    assert.equal(flagStr(a, 'by'), 'Abhinav K');
  });

  test('flagNum falls back when the value is not a number', () => {
    assert.equal(flagNum(parseArgs(['score', '--days=soon']), 'days', 90), 90);
  });
});

describe('integer flags are clamped', () => {
  test('a fractional --limit becomes an integer', () => {
    // node:sqlite binds integers only: 2.7 used to crash with "datatype mismatch".
    assert.equal(flagLimit(parseArgs(['queue', '--limit=2.7']), 50), 2);
  });

  test('a negative --limit becomes 0, never SQLite "unlimited"', () => {
    // LIMIT -1 in SQLite means NO limit, the opposite of what was typed.
    assert.equal(flagLimit(parseArgs(['index-check', '--limit=-1']), 25), 0);
  });

  test('an absurd --limit is capped', () => {
    assert.equal(flagLimit(parseArgs(['queue', '--limit=99999999999']), 50), MAX_LIMIT);
  });

  test('an unparseable --limit falls back to the default', () => {
    assert.equal(flagLimit(parseArgs(['queue', '--limit=banana']), 50), 50);
    assert.equal(flagLimit(parseArgs(['queue']), 50), 50);
  });

  test('--days is at least one day and at most ten years', () => {
    assert.equal(flagDays(parseArgs(['score', '--days=-30']), 90), 1);
    assert.equal(flagDays(parseArgs(['score', '--days=999999']), 90), MAX_DAYS);
    // Infinity is not a window; fall back to the default rather than guessing.
    assert.equal(flagDays(parseArgs(['score', '--days=1e400']), 90), 90);
    assert.equal(flagDays(parseArgs(['score', '--days=30']), 90), 30);
  });
});

// ── Masking ──────────────────────────────────────────────────────────────────

describe('masking', () => {
  test('an unset value says so without pretending to be a secret', () => {
    assert.equal(maskSecret(undefined), '(not set)');
    assert.equal(maskSecret(''), '(not set)');
    assert.equal(maskSecret('   '), '(not set)');
  });

  test('a short value is fully hidden', () => {
    assert.equal(maskSecret('abc123'), '*** (6 chars)');
  });

  test('a long token never appears in the output', () => {
    const token = 'pd_1234567890abcdefghijklmnop';
    const masked = maskSecret(token);
    assert.ok(!masked.includes(token));
    assert.ok(!masked.includes('1234567890'));
    assert.ok(masked.endsWith(`(${token.length} chars)`));
    assert.ok(masked.includes(token.slice(-4)));
  });

  test('a service-account email keeps its domain and hides the account', () => {
    const masked = maskEmail('ken-distribution-bot@proj-123.iam.gserviceaccount.com');
    assert.ok(masked.startsWith('ke***@'));
    assert.ok(!masked.includes('distribution-bot'));
  });

  test('maskEmail degrades to maskSecret for a non-email', () => {
    assert.equal(maskEmail('notanemailvalue'), maskSecret('notanemailvalue'));
  });
});

describe('redactMessage', () => {
  test('strips an api_token query parameter', () => {
    const out = redactMessage('GET https://api.pipedrive.com/v1/deals?api_token=abcdef123456 failed');
    assert.ok(!out.includes('abcdef123456'));
    assert.ok(out.includes('api_token=***'));
  });

  test('strips a key/secret assignment', () => {
    const out = redactMessage('auth failed: token=sk-live-ABCDEFGH12345678');
    assert.ok(!out.includes('ABCDEFGH12345678'));
  });

  test('strips a PEM private key block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----';
    const out = redactMessage(`bad credentials: ${pem}`);
    assert.ok(!out.includes('MIIEvQIBADAN'));
    assert.ok(out.includes('[private key redacted]'));
  });

  test('strips a Bearer token, which carries no keyword at all', () => {
    const out = redactMessage('401 from GA4: Bearer ya29.averylongoauthtokenvalue123456');
    assert.ok(!out.includes('ya29.averylongoauthtokenvalue123456'));
    assert.ok(/Bearer \*\*\*/.test(out));
  });

  test('strips a JSON credential field whose name continues past the keyword', () => {
    // "private_key_id" — the keyword rule must not stop at the underscore.
    const out = redactMessage('bad service account: {"private_key_id":"0123456789abcdef0123"}');
    assert.ok(!out.includes('0123456789abcdef0123'));
  });

  test('the PEM placeholder is not itself chewed by the keyword rule', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----';
    assert.ok(redactMessage(pem).includes('[private key redacted]'));
  });

  test('leaves an ordinary message alone', () => {
    assert.equal(redactMessage('sheet read failed: 404'), 'sheet read failed: 404');
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

describe('checkCredentials', () => {
  const noFile = () => false;
  const yesFile = () => true;

  test('reports every source as missing in a bare environment', () => {
    const checks = checkCredentials({}, noFile);
    assert.equal(checks.length, 4);
    assert.ok(checks.every(c => !c.ok));
    for (const c of checks) assert.ok(c.missing.length > 0, `${c.feature} should name what is missing`);
  });

  test('names the exact env var that is missing', () => {
    const checks = checkCredentials({ GSC_SITE_URL: 'sc-domain:example.com' }, yesFile);
    const gsc = checks.find(c => c.feature === 'Google Search Console')!;
    const ga4 = checks.find(c => c.feature === 'Google Analytics 4')!;
    assert.equal(gsc.ok, true);
    assert.equal(ga4.ok, false);
    assert.deepEqual(ga4.missing, ['GA4_PROPERTY_ID']);
  });

  test('the inline service-account JSON counts as a credential', () => {
    const checks = checkCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}' }, noFile);
    assert.equal(checks.find(c => c.feature === 'Google Sheets (ingest)')!.ok, true);
  });

  test('never prints the Pipedrive token', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const checks = checkCredentials({ PIPEDRIVE_API_TOKEN: token }, noFile);
    const pd = checks.find(c => c.feature === 'Pipedrive (leads)')!;
    assert.equal(pd.ok, true);
    assert.ok(!pd.detail.includes(token));
  });

  test('the rendered table counts what cannot work', () => {
    const text = formatCredentials(checkCredentials({}, noFile));
    assert.ok(text.includes('MISSING'));
    assert.ok(text.includes('4 of 4 data sources cannot work yet'));
  });

  test('a fully configured environment says so', () => {
    const text = formatCredentials(checkCredentials({
      GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
      GSC_SITE_URL: 'sc-domain:example.com',
      GA4_PROPERTY_ID: '123456789',
      PIPEDRIVE_API_TOKEN: 'tok-0123456789abcdef',
    }, () => true));
    assert.ok(text.includes('All data sources have credentials.'));
  });
});

// ── Pure formatters ──────────────────────────────────────────────────────────

describe('formatters', () => {
  test('formatFlags explains the master switch when it is off', () => {
    const text = formatFlags();
    assert.ok(text.includes('INTELLIGENCE_ENABLED'));
    assert.ok(text.includes('FEATURE_INTELLIGENCE is off'));
  });

  test('formatScoreTable says why there is nothing rather than printing an empty table', () => {
    const text = formatScoreTable([]);
    assert.ok(/No scores/.test(text));
    assert.ok(/ingest|OPPORTUNITY_SCORING/.test(text));
  });

  test('formatScoreTable shows the score and its explanation', () => {
    const text = formatScoreTable([{
      reportUrl: 'https://www.kenresearch.com/a',
      score: 0.5,
      components: [],
      recencyMultiplier: 1,
      weightsVersion: 'v0',
      coverage: 0.25,
      explanation: 'only 25% of signal available',
    }]);
    assert.ok(text.includes('0.500'));
    assert.ok(text.includes('25%'));
    assert.ok(text.includes('only 25% of signal available'));
  });

  test('formatTableCounts points at the next command when everything is empty', () => {
    const text = formatTableCounts([{ table: 'published_posts', rows: 0 }]);
    assert.ok(text.includes('Every table is empty'));
    assert.ok(text.includes('ingest'));
  });

  test('formatProposals returns the empty note rather than a header with no rows', () => {
    assert.equal(formatProposals([], 'nothing here'), 'nothing here');
  });

  test('formatProposals warns when the source platform cannot be edited', () => {
    const text = formatProposals([{
      id: 3, source_url: 'https://x.test/p', source_platform: 'twitter',
      destination_url: 'https://www.kenresearch.com/r', anchor_text: 'market report',
      relevance: 0.8, rationale: null, status: 'proposed',
      created_at: '2026-01-01T00:00:00.000Z', decided_by: null,
    }], 'none');
    assert.ok(text.includes('#3'));
    assert.ok(text.includes('cannot be edited after publishing'));
  });

  test('help lists every documented command', () => {
    const text = formatHelp();
    for (const [name] of COMMANDS) assert.ok(text.includes(name.split(' ')[0]), `help should mention ${name}`);
  });
});

// ── Empty-database queries ───────────────────────────────────────────────────

describe('queries against an empty database', () => {
  test('return empty results instead of throwing', () => {
    const db = openDb(freshDbFile('queries'));
    try {
      assert.deepEqual(knownReportUrls(db), []);
      assert.deepEqual(recentPublishedPosts(db), []);
      assert.deepEqual(proposalsByStatus(db, 'proposed'), []);
      assert.ok(formatCalibrationHistory(db).includes('No calibration has ever run'));
      const counts = tableCounts(db);
      assert.ok(counts.some(c => c.table === 'published_posts' && c.rows === 0));
      assert.ok(counts.some(c => c.table === 'interlink_proposals'));
    } finally {
      db.close();
    }
  });
});

// ── Commands against an empty database ───────────────────────────────────────

const READ_ONLY_COMMANDS = [
  'status', 'migrate', 'collect', 'ingest', 'index-check', 'score',
  'platforms', 'content', 'propose', 'queue', 'apply', 'calibrate', 'report',
];

describe('every command on an empty database', () => {
  for (const cmd of READ_ONLY_COMMANDS) {
    test(`${cmd} succeeds and prints something useful`, async () => {
      const out = bufferOut();
      const code = await runCli([cmd], { out, dbFile: freshDbFile(`cmd-${cmd}`), env: {} });
      assert.equal(code, 0, `${cmd} should exit 0; stderr: ${out.errors.join('\n')}`);
      assert.ok(out.lines.length > 0, `${cmd} printed nothing`);
      assert.ok(!out.text().includes('undefined'), `${cmd} printed "undefined"`);
    });
  }
});

describe('hostile flag values never crash a command', () => {
  const HOSTILE: Array<[string, string[]]> = [
    ['fractional limit', ['queue', '--limit', '2.7']],
    ['negative limit', ['index-check', '--limit', '-1']],
    ['enormous limit', ['queue', '--limit', '99999999999']],
    ['non-numeric limit', ['score', '--limit', 'banana']],
    ['negative days', ['score', '--days', '-30']],
    ['infinite days', ['platforms', '--days', '1e400']],
  ];
  for (const [name, argv] of HOSTILE) {
    test(name, async () => {
      const out = bufferOut();
      const code = await runCli(argv, { out, dbFile: freshDbFile(`hostile-${argv.join('-')}`), env: {} });
      assert.equal(code, 0, `${name} should exit 0; stderr: ${out.errors.join('\n')}`);
    });
  }
});

describe('status', () => {
  test('reports schema version, table counts and missing credentials', async () => {
    const out = bufferOut();
    const file = freshDbFile('status');
    const code = await runCli(['status'], { out, dbFile: file, env: {} });
    const text = out.text();
    assert.equal(code, 0);
    assert.ok(text.includes('did not exist — created now'));
    assert.ok(/Schema\s+: v\d+/.test(text));
    assert.ok(text.includes('CREDENTIALS'));
    assert.ok(text.includes('MISSING'));
    assert.ok(text.includes('published_posts'));
    assert.ok(text.includes('none yet'));
  });

  test('a second run sees the database it created', async () => {
    const file = freshDbFile('status-twice');
    await runCli(['status'], { out: bufferOut(), dbFile: file, env: {} });
    const out = bufferOut();
    await runCli(['status'], { out, dbFile: file, env: {} });
    assert.ok(out.text().includes('existed already'));
  });

  test('never prints a full spreadsheet id or token', async () => {
    const out = bufferOut();
    await runCli(['status'], {
      out,
      dbFile: freshDbFile('status-secrets'),
      env: { PIPEDRIVE_API_TOKEN: 'supersecrettoken1234567890' },
    });
    assert.ok(!out.text().includes('supersecrettoken1234567890'));
  });
});

describe('collect', () => {
  test('skips every collector and says exactly why', async () => {
    const out = bufferOut();
    const code = await runCli(['collect'], { out, dbFile: freshDbFile('collect'), env: {} });
    const text = out.text();
    assert.equal(code, 0);
    assert.ok(text.includes('SKIP  gsc'));
    assert.ok(text.includes('SKIP  ga4'));
    assert.ok(text.includes('SKIP  pipedrive'));
    assert.ok(text.includes('0 collector(s) ran, 3 skipped.'));
  });

  test('states that it never touches published content', async () => {
    const out = bufferOut();
    await runCli(['collect'], { out, dbFile: freshDbFile('collect-banner'), env: {} });
    assert.ok(out.text().includes('No published content is touched'));
  });
});

describe('apply', () => {
  test('defaults to a dry run and says so in a banner', async () => {
    const out = bufferOut();
    const code = await runCli(['apply'], { out, dbFile: freshDbFile('apply-dry'), env: {} });
    assert.equal(code, 0);
    assert.ok(out.text().includes('DRY RUN'));
    assert.ok(!out.text().includes('LIVE MODE'));
  });

  test('--apply prints the live banner before anything else', async () => {
    const out = bufferOut();
    await runCli(['apply', '--apply'], { out, dbFile: freshDbFile('apply-live'), env: {} });
    assert.ok(out.lines[0].includes('LIVE MODE') || out.text().includes('LIVE MODE'));
  });

  test('a dry run leaves an approved proposal untouched', async () => {
    const file = freshDbFile('apply-untouched');
    const db = openDb(file);
    db.prepare(
      `INSERT INTO interlink_proposals (source_url, destination_url, anchor_text, status, created_at, source_platform, relevance)
       VALUES (?, ?, ?, 'approved', ?, 'hackmd', 0.9)`,
    ).run('https://hackmd.io/abc', 'https://www.kenresearch.com/r', 'india market', '2026-01-01T00:00:00.000Z');
    db.close();

    const out = bufferOut();
    const code = await runCli(['apply'], { out, dbFile: file, env: {} });
    assert.equal(code, 0);
    assert.ok(out.text().includes('DRY RUN'));

    const check = openDb(file);
    const row = check.prepare('SELECT status FROM interlink_proposals WHERE id = 1').get() as any;
    check.close();
    assert.equal(row.status, 'approved', 'a dry run must not change any status');
  });
});

describe('approve / reject', () => {
  function seed(file: string): void {
    const db = openDb(file);
    db.prepare(
      `INSERT INTO interlink_proposals (source_url, destination_url, anchor_text, status, created_at, source_platform, relevance)
       VALUES (?, ?, ?, 'proposed', ?, 'hackmd', 0.7)`,
    ).run('https://hackmd.io/xyz', 'https://www.kenresearch.com/r2', 'gcc market', '2026-01-01T00:00:00.000Z');
    db.close();
  }

  test('requires an id', async () => {
    const out = bufferOut();
    const code = await runCli(['approve'], { out, dbFile: freshDbFile('approve-noid'), env: {} });
    assert.equal(code, 1);
    assert.ok(out.errors.join('\n').includes('proposal id is required'));
  });

  test('refuses an id that does not exist', async () => {
    const out = bufferOut();
    const code = await runCli(['approve', '999'], { out, dbFile: freshDbFile('approve-missing'), env: {} });
    assert.equal(code, 1);
    assert.ok(out.errors.join('\n').includes('No proposal #999'));
  });

  test('records who approved it', async () => {
    const file = freshDbFile('approve-ok');
    seed(file);
    const out = bufferOut();
    const code = await runCli(['approve', '1', '--by', 'Abhinav'], { out, dbFile: file, env: {} });
    assert.equal(code, 0);
    assert.ok(out.text().includes('approved by Abhinav'));

    const db = openDb(file);
    const row = db.prepare('SELECT status, decided_by, decided_at FROM interlink_proposals WHERE id = 1').get() as any;
    db.close();
    assert.equal(row.status, 'approved');
    assert.equal(row.decided_by, 'Abhinav');
    assert.ok(row.decided_at);
  });

  test('refuses to approve something already decided', async () => {
    const file = freshDbFile('approve-twice');
    seed(file);
    await runCli(['approve', '1', '--by', 'A'], { out: bufferOut(), dbFile: file, env: {} });
    const out = bufferOut();
    const code = await runCli(['approve', '1', '--by', 'A'], { out, dbFile: file, env: {} });
    assert.equal(code, 1);
    assert.ok(out.errors.join('\n').includes('refusing'));
  });

  test('reject records the decision too', async () => {
    const file = freshDbFile('reject-ok');
    seed(file);
    const out = bufferOut();
    const code = await runCli(['reject', '1', '--by', 'B', '--reason', 'anchor reads badly'], {
      out, dbFile: file, env: {},
    });
    assert.equal(code, 0);
    const db = openDb(file);
    const row = db.prepare('SELECT status, decided_by FROM interlink_proposals WHERE id = 1').get() as any;
    db.close();
    assert.equal(row.status, 'rejected');
    assert.equal(row.decided_by, 'B');
  });

  test('the queue shows a pending proposal and how to decide it', async () => {
    const file = freshDbFile('queue-one');
    seed(file);
    const out = bufferOut();
    const code = await runCli(['queue'], { out, dbFile: file, env: {} });
    assert.equal(code, 0);
    assert.ok(out.text().includes('#1'));
    assert.ok(out.text().includes('approve <id>') || out.text().includes('approve'));
  });
});

describe('dispatcher', () => {
  test('an unknown command fails with the help text', async () => {
    const out = bufferOut();
    const code = await runCli(['frobnicate'], { out, dbFile: freshDbFile('unknown'), env: {} });
    assert.equal(code, 1);
    const text = out.errors.join('\n');
    assert.ok(text.includes('Unknown command: frobnicate'));
    assert.ok(text.includes('Usage:'));
  });

  test('--help prints usage and exits 0', async () => {
    const out = bufferOut();
    const code = await runCli(['--help'], { out, dbFile: freshDbFile('help'), env: {} });
    assert.equal(code, 0);
    assert.ok(out.text().includes('Ken Research distribution intelligence'));
  });

  test('help is also reachable as a command', async () => {
    const out = bufferOut();
    assert.equal(await runCli(['help'], { out, dbFile: freshDbFile('help2'), env: {} }), 0);
    assert.ok(out.text().includes('Commands:'));
  });

  test('migrate reports the version before and after', async () => {
    const out = bufferOut();
    const code = await runCli(['migrate'], { out, dbFile: freshDbFile('migrate'), env: {} });
    assert.equal(code, 0);
    assert.ok(out.text().includes('Before'));
    assert.ok(out.text().includes('After'));
    assert.ok(out.text().includes('No pending migrations.'));
  });
});
