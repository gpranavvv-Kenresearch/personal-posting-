/**
 * Tab guard: confining a development run to one tab inside the production
 * spreadsheet. Pure — the "client" here is a fake that records calls. No
 * network, no Google API, no real spreadsheet.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitRange, quoteTab, rewriteRange, assertStructuralChangeAllowed,
} from '../../src/config/tabGuard.js';

const DEV_TAB = 'Test_Abhinav';

describe('range parsing', () => {
  test('splits a plain tab', () => {
    assert.deepEqual(splitRange('Blogs!A1:Z'), { tab: 'Blogs', cells: 'A1:Z' });
  });
  test('splits a quoted tab with a space', () => {
    assert.deepEqual(splitRange("'New Logic'!A1:Z"), { tab: 'New Logic', cells: 'A1:Z' });
  });
  test('a range with no tab has no tab component', () => {
    assert.deepEqual(splitRange('A1:Z'), { tab: null, cells: 'A1:Z' });
  });
});

describe('tab quoting', () => {
  test('simple names are left bare', () => {
    assert.equal(quoteTab('Test_Abhinav'), 'Test_Abhinav');
  });
  test('names with spaces are quoted', () => {
    assert.equal(quoteTab('New Logic'), "'New Logic'");
  });
});

describe('every live tab is rewritten onto the dev tab', () => {
  const liveTabs = [
    'Social Media', 'Blogs', 'Algo Reports', 'Content Pool',
    'New Logic', 'RSS Extraction', 'Newsletter',
  ];

  for (const tab of liveTabs) {
    test(`"${tab}" is redirected`, () => {
      const out = rewriteRange(`${quoteTab(tab)}!A1:Z100`, DEV_TAB);
      assert.equal(out, 'Test_Abhinav!A1:Z100');
      assert.ok(!out.includes(tab), `${out} must not still reference ${tab}`);
    });
  }

  test('the cell portion is preserved exactly', () => {
    assert.equal(rewriteRange("'New Logic'!B2:F500", DEV_TAB), 'Test_Abhinav!B2:F500');
    assert.equal(rewriteRange('Blogs!A1', DEV_TAB), 'Test_Abhinav!A1');
  });

  test('a tab-less range is given the dev tab, not left to default', () => {
    // Without "!", Sheets targets whichever tab is first — live data.
    assert.equal(rewriteRange('A1:Z', DEV_TAB), 'Test_Abhinav!A1:Z');
  });

  test('a dev tab needing quotes is quoted', () => {
    assert.equal(rewriteRange('Blogs!A1', 'Test Abhinav'), "'Test Abhinav'!A1");
  });

  test('rewriting is idempotent', () => {
    const once = rewriteRange('Blogs!A1:Z', DEV_TAB);
    assert.equal(rewriteRange(once, DEV_TAB), once);
  });
});

describe('our own tabs are usable; live tabs are not', () => {
  test('a Test_ tab is left exactly as addressed', () => {
    assert.equal(rewriteRange('Test_Social!A1:Z', DEV_TAB, 'Test_'), 'Test_Social!A1:Z');
    assert.equal(rewriteRange('Test_NewLogic!B2', DEV_TAB, 'Test_'), 'Test_NewLogic!B2');
  });

  test('the primary dev tab is left alone', () => {
    assert.equal(rewriteRange('Test_Abhinav!A1', DEV_TAB, 'Test_'), 'Test_Abhinav!A1');
  });

  test('live tabs are still redirected', () => {
    assert.equal(rewriteRange('Blogs!A1', DEV_TAB), 'Test_Abhinav!A1');
    assert.equal(rewriteRange("'Social Media'!A1", DEV_TAB), 'Test_Abhinav!A1');
  });
});

describe('structural changes', () => {
  // Explicit config so these assertions hold regardless of how the suite was
  // launched — they must not depend on ambient KEN_ENV.
  const LOCK = { active: true, devTab: DEV_TAB, prefix: 'Test_' };
  const add = (title: string) => ({
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });

  test('the checker is a no-op when the lock is inactive', () => {
    assert.doesNotThrow(() =>
      assertStructuralChangeAllowed({ requestBody: { requests: [{ deleteSheet: { sheetId: 0 } }] } },
        { active: false }));
  });

  test('creating a Test_ tab is allowed', () => {
    assert.doesNotThrow(() => assertStructuralChangeAllowed(add('Test_NewLogic'), LOCK));
    assert.doesNotThrow(() => assertStructuralChangeAllowed(add('Test_Abhinav'), LOCK));
  });

  test('creating a tab named like a live tab is refused', () => {
    assert.throws(() => assertStructuralChangeAllowed(add('Blogs'), LOCK), /not a development tab/);
    assert.throws(() => assertStructuralChangeAllowed(add('Social Media'), LOCK), /not a development tab/);
  });

  test('deleting a tab is refused outright', () => {
    assert.throws(
      () => assertStructuralChangeAllowed({ requestBody: { requests: [{ deleteSheet: { sheetId: 0 } }] } }, LOCK),
      /deleteSheet.*blocked/s,
    );
  });

  test('renaming a tab is refused outright', () => {
    assert.throws(
      () => assertStructuralChangeAllowed({
        requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: 0, title: 'x' } } }] },
      }, LOCK),
      /updateSheetProperties.*blocked/s,
    );
  });

  test('an unreadable request list is refused', () => {
    assert.throws(() => assertStructuralChangeAllowed({}, LOCK), /cannot be checked/);
  });

  test('a mixed batch is refused if ANY request is unsafe', () => {
    assert.throws(
      () => assertStructuralChangeAllowed({
        requestBody: {
          requests: [
            { addSheet: { properties: { title: 'Test_ok' } } },
            { deleteSheet: { sheetId: 123 } },
          ],
        },
      }, LOCK),
      /blocked/,
    );
  });
});
