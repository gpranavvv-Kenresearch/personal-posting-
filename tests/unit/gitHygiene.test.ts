/**
 * Git hygiene and legacy-test isolation.
 *
 * Read-only: runs `git check-ignore` / `git ls-files` against this repository.
 * No network, no spreadsheet, no posting.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function isIgnored(rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
}

describe('sensitive paths are excluded from git', () => {
  for (const rel of [
    '.env',
    '.env.local',
    '.env.production',
    '.accounts/google-service-account.json',
    '.sessions/slot-ledger.json',
    'backups/2026-01-01/manifest.json',
    '.pre-restore/2026-01-01/x.json',
    'data/intelligence.db',
    'dev-sandbox/.sessions/slot-ledger.json',
  ]) {
    test(`${rel} is ignored`, () => assert.ok(isIgnored(rel), `${rel} must be gitignored`));
  }
});

describe('the committed template stays trackable', () => {
  test('.env.example is NOT ignored despite the .env.* rule', () => {
    assert.equal(isIgnored('.env.example'), false);
  });
  test('.env.example exists', () => {
    assert.ok(fs.existsSync(path.join(REPO, '.env.example')));
  });
  test('.env.example contains no real-looking secret values', () => {
    const body = fs.readFileSync(path.join(REPO, '.env.example'), 'utf-8');
    assert.ok(!/BEGIN (RSA |EC )?PRIVATE KEY/.test(body));
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(body));
  });
});

describe('src/scripts is not shadowed by the scripts/ ignore rule', () => {
  test('a new file under src/scripts/ would be tracked', () => {
    assert.equal(isIgnored('src/scripts/some-new-file.ts'), false);
  });
});

describe('no credentials are tracked', () => {
  test('no .env or credential file appears in git ls-files', () => {
    // .env.example is the one .env-prefixed file that SHOULD be tracked: it is
    // the committed template and is asserted to be secret-free above.
    const bad = trackedFiles().filter(f =>
      f !== '.env.example' && (
        /(^|\/)\.env($|\.)/.test(f) ||
        /(^|\/)\.accounts\//.test(f) ||
        /google-service-account\.json$/.test(f)
      ),
    );
    assert.deepEqual(bad, []);
  });
});

describe('legacy test scripts stay isolated', () => {
  test('the four legacy scripts still exist and are untouched by this suite', () => {
    for (const f of [
      'test-content-agent.ts',
      'test-coordinator.ts',
      'test-seo-agent.ts',
      'test-week2-features.ts',
    ]) {
      assert.ok(fs.existsSync(path.join(REPO, 'tests', f)), `tests/${f} must still exist`);
    }
  });

  test('the unit runner glob cannot reach them', () => {
    // npm test runs tests/unit/*.test.ts — legacy scripts live in tests/ root
    // and do not end in .test.ts, so neither condition can match them.
    const legacy = fs.readdirSync(path.join(REPO, 'tests'))
      .filter(f => f.endsWith('.ts'));
    assert.ok(legacy.length > 0);
    for (const f of legacy) {
      assert.ok(!f.endsWith('.test.ts'), `tests/${f} would be picked up by the runner`);
    }
  });
});
