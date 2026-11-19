/**
 * Spreadsheet id resolution and the development/production interlock.
 * Pure: no network, no Google API, no spreadsheet access.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSheetId, parseKenEnv, isProductionId, maskId } from '../../src/config/sheetIds.js';

const PROD_MAIN = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const PROD_DIST = '1ZbEcDaK-zb6U1SK1P23UIjezN5NGdy3R15r9W-glVlU';
const DEV_ID = '1DEVdevDEVdevDEVdevDEVdevDEVdevDEVdevDEVdev';

describe('KEN_ENV strict validation', () => {
  test('unset behaves as production (preserves existing behaviour)', () => {
    assert.equal(parseKenEnv(undefined), 'production');
    assert.equal(parseKenEnv(''), 'production');
  });
  test('accepts exactly the two valid values', () => {
    assert.equal(parseKenEnv('development'), 'development');
    assert.equal(parseKenEnv('production'), 'production');
  });
  test('throws on anything else — a typo must never read as production', () => {
    for (const bad of ['dev', 'Development', 'DEV', 'prod', 'staging', 'true', '1']) {
      assert.throws(() => parseKenEnv(bad), /Invalid KEN_ENV/, `expected throw for ${bad}`);
    }
  });
});

describe('production mode', () => {
  test('no env set resolves to the exact historical production id', () => {
    assert.equal(resolveSheetId('MAIN_SHEET_ID', PROD_MAIN, {}, 'production'), PROD_MAIN);
    assert.equal(resolveSheetId('DISTRIBUTED_URL_SHEET_ID', PROD_DIST, {}, 'production'), PROD_DIST);
  });
  test('an explicit override is honoured', () => {
    assert.equal(
      resolveSheetId('MAIN_SHEET_ID', PROD_MAIN, { MAIN_SHEET_ID: DEV_ID }, 'production'),
      DEV_ID,
    );
  });
});

describe('development interlock', () => {
  test('refuses to start when the id is missing — no silent production fallback', () => {
    assert.throws(
      () => resolveSheetId('MAIN_SHEET_ID', PROD_MAIN, {}, 'development'),
      /is not set/,
    );
  });
  test('refuses a blank id', () => {
    assert.throws(
      () => resolveSheetId('MAIN_SHEET_ID', PROD_MAIN, { MAIN_SHEET_ID: '   ' }, 'development'),
      /is not set/,
    );
  });
  test('refuses when the override IS the production id', () => {
    assert.throws(
      () => resolveSheetId('MAIN_SHEET_ID', PROD_MAIN, { MAIN_SHEET_ID: PROD_MAIN }, 'development'),
      /PRODUCTION/,
    );
  });
  test('refuses the OTHER production id too (both are checked)', () => {
    assert.throws(
      () => resolveSheetId('MAIN_SHEET_ID', PROD_MAIN, { MAIN_SHEET_ID: PROD_DIST }, 'development'),
      /PRODUCTION/,
    );
    assert.throws(
      () => resolveSheetId('DISTRIBUTED_URL_SHEET_ID', PROD_DIST, { DISTRIBUTED_URL_SHEET_ID: PROD_MAIN }, 'development'),
      /PRODUCTION/,
    );
  });
  test('accepts a genuine development id', () => {
    assert.equal(
      resolveSheetId('MAIN_SHEET_ID', PROD_MAIN, { MAIN_SHEET_ID: DEV_ID }, 'development'),
      DEV_ID,
    );
  });
});

describe('id masking', () => {
  test('never emits a full production id', () => {
    const masked = maskId(PROD_MAIN);
    assert.ok(!masked.includes(PROD_MAIN));
    assert.ok(masked.length < PROD_MAIN.length);
  });
  test('isProductionId recognises both live spreadsheets', () => {
    assert.ok(isProductionId(PROD_MAIN));
    assert.ok(isProductionId(PROD_DIST));
    assert.ok(!isProductionId(DEV_ID));
  });
});
