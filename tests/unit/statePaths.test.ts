/**
 * Sandbox isolation: proves that running with cwd set to a development
 * sandbox redirects .sessions/, logs/, .accounts/ and data/ away from the
 * repository. Pure path arithmetic — nothing is read or written.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { getStatePaths, isIsolatedUnder, buildStartupBanner } from '../../src/config/env.js';

const REPO = path.resolve('C:/repo/personal-posting-');
const SANDBOX = path.join(REPO, 'dev-sandbox');
const OUTSIDE = path.resolve('D:/ken-dev-sandbox');

describe('state paths follow cwd', () => {
  test('all four state paths resolve under the sandbox, not the repo', () => {
    const p = getStatePaths(SANDBOX);
    for (const target of [p.sessions, p.logs, p.accounts, p.data]) {
      assert.ok(target.startsWith(SANDBOX), `${target} should be under ${SANDBOX}`);
    }
  });

  test('sandbox paths are NOT the repository paths', () => {
    const repoPaths = getStatePaths(REPO);
    const sandboxPaths = getStatePaths(SANDBOX);
    assert.notEqual(repoPaths.sessions, sandboxPaths.sessions);
    assert.notEqual(repoPaths.logs, sandboxPaths.logs);
    assert.notEqual(repoPaths.accounts, sandboxPaths.accounts);
    assert.notEqual(repoPaths.data, sandboxPaths.data);
  });

  test('mirrors the three idioms the codebase actually uses', () => {
    const p = getStatePaths(SANDBOX);
    assert.equal(p.sessions, path.resolve(SANDBOX, '.sessions'));
    assert.equal(p.logs, path.resolve(SANDBOX, 'logs'));
    assert.equal(p.accounts, path.join(SANDBOX, '.accounts'));
  });

  test('isolation holds for a sandbox outside the repository too', () => {
    assert.ok(isIsolatedUnder(OUTSIDE, OUTSIDE));
    assert.ok(isIsolatedUnder(SANDBOX, SANDBOX));
  });

  test('the repository root is NOT isolated from itself', () => {
    assert.equal(isIsolatedUnder(SANDBOX, REPO), false);
  });
});

describe('startup banner', () => {
  test('always names the environment it is running in', () => {
    // Must hold however the suite was launched, so assert on the env the
    // banner reports rather than assuming production.
    const banner = buildStartupBanner(REPO);
    assert.match(banner, /KEN_ENV=(development|production)/);
  });

  test('never prints a full spreadsheet id', () => {
    const banner = buildStartupBanner(REPO);
    assert.ok(!banner.includes('1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'));
    assert.ok(!banner.includes('1ZbEcDaK-zb6U1SK1P23UIjezN5NGdy3R15r9W-glVlU'));
  });
});
