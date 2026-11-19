/**
 * urlMapping — report-URL to published-URL mapping.
 *
 * Pure: every test below runs against fixtures or a throwaway temp database.
 * No Google API call, no network, no live spreadsheet.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../src/intelligence/db.js';
import {
  normalizeUrl,
  utmSourceOf,
  isStatusText,
  rawUrlsIn,
  extractReportUrl,
  extractPublishedUrls,
  slugOf,
  slugSimilarity,
  classifyMapping,
  normalizePlatform,
  platformFromHeader,
  findReportUrlColumn,
  findPublishedUrlColumns,
  findLastPostedColumn,
  headerIndex,
  latestOf,
  toIsoTimestamp,
  planRow,
  ingestFromSheet,
  upsertMapping,
  recordManualMapping,
  postsForReport,
  reportForPost,
  mappingCoverage,
  MIN_CONFIDENCE,
  DEFAULT_TAB,
} from '../../src/intelligence/urlMapping.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const REPORT = 'https://www.kenresearch.com/industry-reports/india-logistics-market';
const REPORT_UTM = `${REPORT}?utm_source=medium&utm_medium=referral&utm_campaign=automation`;

const HEADERS = [
  'Title', 'Target URL', 'Batch', 'Date', 'Name', 'New Name',
  'X Post URL', 'FB Post URL', 'LinkedIn Post URL', 'Medium Post URL',
  'Dev.to Post URL', 'Linkedin Pulse URL', 'HackMD Post URL',
  'Last Posted Medium', 'Last Posted X',
  'Download Report URL', 'Cover Image URL', 'X Status',
];

function h(name: string): number {
  const i = HEADERS.indexOf(name);
  if (i === -1) throw new Error(`fixture header missing: ${name}`);
  return i;
}

function row(values: Record<string, string>): string[] {
  const r = new Array(HEADERS.length).fill('');
  for (const [k, v] of Object.entries(values)) r[h(k)] = v;
  return r;
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urlmap-'));
  return openDb(path.join(dir, 'test.db'));
}

// ── normalizeUrl ────────────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  test('lowercases scheme and host, keeps path case', () => {
    assert.equal(
      normalizeUrl('HTTPS://WWW.KenResearch.com/Industry-Reports/X'),
      'https://www.kenresearch.com/Industry-Reports/X',
    );
  });

  test('strips every tracking parameter but keeps real ones', () => {
    assert.equal(
      normalizeUrl('https://a.com/p?utm_source=x&utm_medium=referral&id=7&fbclid=abc&gclid=z'),
      'https://a.com/p?id=7',
    );
  });

  test('drops a query that was nothing but tracking', () => {
    assert.equal(normalizeUrl(`${REPORT}?utm_source=medium`), REPORT);
  });

  test('drops the fragment', () => {
    assert.equal(normalizeUrl('https://a.com/p#section-2'), 'https://a.com/p');
  });

  test('strips a trailing slash on a path but keeps the root slash', () => {
    assert.equal(normalizeUrl('https://a.com/p/'), 'https://a.com/p');
    assert.equal(normalizeUrl('https://a.com/'), 'https://a.com/');
  });

  test('trims trailing punctuation glued on by prose', () => {
    assert.equal(normalizeUrl('https://a.com/p.'), 'https://a.com/p');
    assert.equal(normalizeUrl('https://a.com/p),'), 'https://a.com/p');
    assert.equal(normalizeUrl('"https://a.com/p"'.replace(/^"/, '')), 'https://a.com/p');
  });

  test('rejects non-URLs, relative paths and blanks', () => {
    for (const bad of ['', '   ', null, undefined, 'ERROR', '/industry-reports/x', 'www.a.com/p', 'ftp://a.com/p', 'http://localhost/p']) {
      assert.equal(normalizeUrl(bad as any), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  test('is idempotent', () => {
    const once = normalizeUrl(REPORT_UTM)!;
    assert.equal(normalizeUrl(once), once);
  });
});

// ── utmSourceOf ─────────────────────────────────────────────────────────────

describe('utmSourceOf', () => {
  test('reads and lowercases utm_source', () => {
    assert.equal(utmSourceOf('https://a.com/p?utm_source=Medium'), 'medium');
  });
  test('null when absent or unparseable', () => {
    assert.equal(utmSourceOf(REPORT), null);
    assert.equal(utmSourceOf('not a url'), null);
    assert.equal(utmSourceOf(''), null);
  });
});

// ── status text / raw extraction ────────────────────────────────────────────

describe('isStatusText', () => {
  test('recognises the status words that appear in URL columns', () => {
    for (const s of ['ERROR', 'failed', 'N/A', ' SKIPPED ', 'pending', '-', 'ERROR | FAILED']) {
      assert.equal(isStatusText(s), true, s);
    }
  });
  test('a real URL is not status text', () => {
    assert.equal(isStatusText(REPORT), false);
    assert.equal(isStatusText('ERROR | https://medium.com/@a/post'), false);
  });
  test('blank is not status text', () => {
    assert.equal(isStatusText(''), false);
    assert.equal(isStatusText(undefined), false);
  });
});

describe('rawUrlsIn', () => {
  test('finds URLs across the appended-history separator', () => {
    assert.deepEqual(
      rawUrlsIn('https://a.com/1 | https://a.com/2 | https://a.com/3'),
      ['https://a.com/1', 'https://a.com/2', 'https://a.com/3'],
    );
  });
  test('ignores surrounding status text', () => {
    assert.deepEqual(rawUrlsIn('ERROR | https://a.com/1'), ['https://a.com/1']);
  });
  test('empty for cells with no URL', () => {
    assert.deepEqual(rawUrlsIn('FAILED'), []);
    assert.deepEqual(rawUrlsIn(''), []);
  });
});

// ── extractReportUrl ────────────────────────────────────────────────────────

describe('extractReportUrl', () => {
  test('plain report URL', () => {
    assert.equal(extractReportUrl(REPORT), REPORT);
  });
  test('strips tracking params so the same report is one key', () => {
    assert.equal(extractReportUrl(REPORT_UTM), REPORT);
  });
  test('prefers the kenresearch URL over a co-located other URL', () => {
    assert.equal(extractReportUrl(`https://medium.com/@a/post | ${REPORT}`), REPORT);
  });
  test('falls back to the first URL when none is kenresearch', () => {
    assert.equal(extractReportUrl('https://other.com/a | https://other.com/b'), 'https://other.com/a');
  });
  test('null for blank, status text and junk', () => {
    for (const bad of ['', '   ', 'ERROR', 'N/A', 'see the deck', undefined]) {
      assert.equal(extractReportUrl(bad as any), null, JSON.stringify(bad));
    }
  });
  test('tolerates trailing punctuation', () => {
    assert.equal(extractReportUrl(`${REPORT},`), REPORT);
  });
});

// ── extractPublishedUrls ────────────────────────────────────────────────────

describe('extractPublishedUrls', () => {
  test('splits appended history into separate URLs', () => {
    assert.deepEqual(
      extractPublishedUrls('https://medium.com/@a/p1 | https://medium.com/@a/p2'),
      ['https://medium.com/@a/p1', 'https://medium.com/@a/p2'],
    );
  });
  test('de-duplicates, including duplicates that differ only by tracking params', () => {
    assert.deepEqual(
      extractPublishedUrls('https://medium.com/@a/p1 | https://medium.com/@a/p1?utm_source=medium | https://medium.com/@a/p1'),
      ['https://medium.com/@a/p1'],
    );
  });
  test('preserves order of first appearance', () => {
    assert.deepEqual(
      extractPublishedUrls('https://b.com/2 | https://a.com/1'),
      ['https://b.com/2', 'https://a.com/1'],
    );
  });
  test('empty for status text and blanks', () => {
    assert.deepEqual(extractPublishedUrls('ERROR'), []);
    assert.deepEqual(extractPublishedUrls('FAILED | N/A'), []);
    assert.deepEqual(extractPublishedUrls(''), []);
    assert.deepEqual(extractPublishedUrls(undefined), []);
  });
  test('recovers the URL from a half-failed history cell', () => {
    assert.deepEqual(
      extractPublishedUrls('ERROR | https://hackmd.io/@ken/abc'),
      ['https://hackmd.io/@ken/abc'],
    );
  });
  test('handles newline-separated cells', () => {
    assert.deepEqual(
      extractPublishedUrls('https://a.com/1\nhttps://a.com/2'),
      ['https://a.com/1', 'https://a.com/2'],
    );
  });
});

// ── slugOf ──────────────────────────────────────────────────────────────────

describe('slugOf', () => {
  test('last path segment of a report URL', () => {
    assert.equal(slugOf(REPORT), 'india-logistics-market');
  });
  test('ignores tracking params and fragments', () => {
    assert.equal(slugOf(`${REPORT}?utm_source=x#top`), 'india-logistics-market');
  });
  test('strips a file extension', () => {
    assert.equal(slugOf('https://a.com/posts/india-logistics-market.html'), 'india-logistics-market');
  });
  test("strips Medium's trailing hex post id", () => {
    assert.equal(
      slugOf('https://medium.com/@ken/india-logistics-market-a1b2c3d4e5f6'),
      'india-logistics-market',
    );
  });
  test('trailing slash does not produce an empty slug', () => {
    assert.equal(slugOf(`${REPORT}/`), 'india-logistics-market');
  });
  test('empty for a root URL or junk', () => {
    assert.equal(slugOf('https://a.com/'), '');
    assert.equal(slugOf('not a url'), '');
    assert.equal(slugOf(''), '');
  });
});

// ── slugSimilarity ──────────────────────────────────────────────────────────

describe('slugSimilarity', () => {
  test('1 when the whole report slug appears in the published URL', () => {
    assert.equal(slugSimilarity(REPORT, 'https://medium.com/@ken/india-logistics-market-a1b2c3d4e5f6'), 1);
  });
  test('high when most distinctive tokens survive a rewrite', () => {
    const s = slugSimilarity(REPORT, 'https://hackmd.io/@ken/india-logistics-2025-overview');
    assert.ok(s >= 0.5, `expected >= 0.5, got ${s}`);
  });
  test('low for an unrelated post', () => {
    const s = slugSimilarity(REPORT, 'https://medium.com/@ken/brazil-cosmetics-market-report');
    assert.ok(s < 0.5, `expected < 0.5, got ${s}`);
  });
  test('generic words alone do not create a match', () => {
    const s = slugSimilarity(
      'https://www.kenresearch.com/industry-reports/india-logistics-market',
      'https://medium.com/@ken/global-market-report-analysis',
    );
    assert.ok(s < 0.5, `generic-only overlap should stay low, got ${s}`);
  });
  test('0 when either side is unusable', () => {
    assert.equal(slugSimilarity('', 'https://a.com/x'), 0);
    assert.equal(slugSimilarity(REPORT, 'ERROR'), 0);
    assert.equal(slugSimilarity('https://a.com/', 'https://a.com/'), 0);
  });
  test('is bounded to 0..1', () => {
    for (const [a, b] of [[REPORT, REPORT], [REPORT, 'https://x.com/y'], ['https://x.com/y', REPORT]]) {
      const s = slugSimilarity(a, b);
      assert.ok(s >= 0 && s <= 1, `${s} out of range`);
    }
  });
});

// ── classifyMapping ─────────────────────────────────────────────────────────

describe('classifyMapping', () => {
  test("a sheet column is the strongest automatic evidence", () => {
    const c = classifyMapping(REPORT, 'https://medium.com/@ken/post', { fromSheetColumn: true, platform: 'medium' });
    assert.equal(c.method, 'sheet');
    assert.ok(c.confidence >= 0.95);
  });

  test('a sheet column plus an agreeing utm_source is stronger still', () => {
    const withUtm = classifyMapping(REPORT, 'https://medium.com/@ken/post?utm_source=medium', { fromSheetColumn: true, platform: 'medium' });
    const without = classifyMapping(REPORT, 'https://medium.com/@ken/post', { fromSheetColumn: true, platform: 'medium' });
    assert.ok(withUtm.confidence > without.confidence);
  });

  test('utm_source alone identifies the platform', () => {
    const c = classifyMapping(REPORT, 'https://somewhere.com/p?utm_source=hackmd');
    assert.equal(c.method, 'utm');
    assert.ok(c.confidence >= 0.7 && c.confidence < 0.95);
  });

  test('a utm_source contradicting the claimed platform loses confidence', () => {
    const agree = classifyMapping(REPORT, 'https://a.com/p?utm_source=medium', { platform: 'medium' });
    const clash = classifyMapping(REPORT, 'https://a.com/p?utm_source=devto', { platform: 'medium' });
    assert.equal(clash.method, 'utm');
    assert.ok(clash.confidence < agree.confidence, `${clash.confidence} should be < ${agree.confidence}`);
  });

  test('slug evidence is the weakest and never beats the sheet', () => {
    const slug = classifyMapping(REPORT, 'https://medium.com/@ken/india-logistics-market-a1b2c3d4e5');
    const sheet = classifyMapping(REPORT, 'https://medium.com/@ken/whatever', { fromSheetColumn: true });
    assert.equal(slug.method, 'slug');
    assert.ok(slug.confidence <= 0.7);
    assert.ok(slug.confidence < sheet.confidence);
  });

  test('a weak slug match falls below the recording threshold', () => {
    const c = classifyMapping(REPORT, 'https://medium.com/@ken/unrelated-topic-entirely');
    assert.equal(c.method, 'slug');
    assert.ok(c.confidence < 0.5);
  });

  test('never invents a manual mapping', () => {
    const cases: Array<[any, any, any]> = [
      [REPORT, 'https://a.com/p', {}],
      [REPORT, 'https://a.com/p?utm_source=x', { platform: 'x' }],
      [REPORT, 'https://a.com/p', { fromSheetColumn: true, platform: 'x' }],
      [REPORT, 'junk', {}],
    ];
    for (const [a, b, o] of cases) {
      assert.notEqual(classifyMapping(a, b, o).method, 'manual');
    }
  });

  test('unusable input scores zero and is below the threshold', () => {
    assert.equal(classifyMapping(REPORT, 'ERROR').confidence, 0);
    assert.equal(classifyMapping('', 'https://a.com/p').confidence, 0);
    assert.ok(classifyMapping(REPORT, '').confidence < MIN_CONFIDENCE);
  });
});

// ── platform + header mapping ───────────────────────────────────────────────

describe('normalizePlatform', () => {
  test('aliases the shorthand the sheet actually uses', () => {
    assert.equal(normalizePlatform('FB'), 'facebook');
    assert.equal(normalizePlatform('LI'), 'linkedin');
    assert.equal(normalizePlatform('Dev.to'), 'devto');
    assert.equal(normalizePlatform('Google Site'), 'googlesites');
    assert.equal(normalizePlatform('Linkedin Pulse'), 'linkedin-pulse');
  });
  test('passes through an already-canonical name', () => {
    assert.equal(normalizePlatform('medium'), 'medium');
    assert.equal(normalizePlatform('HackMD'), 'hackmd');
  });
  test('empty for blank', () => {
    assert.equal(normalizePlatform(''), '');
    assert.equal(normalizePlatform(undefined), '');
  });
});

describe('platformFromHeader', () => {
  test('recognises "<Platform> Post URL" columns', () => {
    assert.equal(platformFromHeader('Medium Post URL'), 'medium');
    assert.equal(platformFromHeader('FB Post URL'), 'facebook');
    assert.equal(platformFromHeader('Linkedin Pulse URL'), 'linkedin-pulse');
  });
  test('recognises the bare "<Platform> URL" columns the sheet also writes', () => {
    // src/sheets/sheets.ts writes these headers without the word "Post".
    // They are real published-URL columns; missing them means those platforms
    // can never be measured.
    assert.equal(platformFromHeader('Instapaper URL'), 'instapaper');
    assert.equal(platformFromHeader('Raindrop URL'), 'raindrop');
    assert.equal(platformFromHeader('Pearltrees URL'), 'pearltrees');
    assert.equal(platformFromHeader('PdfHost URL'), 'pdfhost');
    assert.equal(platformFromHeader('4shared URL'), '4shared');
    assert.equal(platformFromHeader('Scribd URL'), 'scribd');
    assert.equal(platformFromHeader('Mastodon URL'), 'mastodon');
  });
  test('refuses input and asset columns', () => {
    for (const bad of [
      'Target URL', 'Report URL', 'Download Report URL', 'Cover Image URL',
      'Images URL', 'Title', '', 'Batch', 'URL',
      // A platform name in a column that is not where we published.
      'LinkedIn Profile URL', 'Medium Author URL',
    ]) {
      assert.equal(platformFromHeader(bad), '', bad);
    }
  });
});

describe('column discovery by header name', () => {
  test('finds the report column regardless of naming variant', () => {
    assert.equal(findReportUrlColumn(HEADERS), h('Target URL'));
    assert.equal(findReportUrlColumn(['A', 'targetUrl']), 1);
    assert.equal(findReportUrlColumn(['A', 'Report URL']), 1);
    assert.equal(findReportUrlColumn(['A', 'B']), undefined);
  });

  test('finds exactly the published-URL columns, not the asset ones', () => {
    const cols = findPublishedUrlColumns(HEADERS).map(c => c.header);
    assert.deepEqual(cols, [
      'X Post URL', 'FB Post URL', 'LinkedIn Post URL', 'Medium Post URL',
      'Dev.to Post URL', 'Linkedin Pulse URL', 'HackMD Post URL',
    ]);
  });

  test('survives a reordered sheet — positions come from names', () => {
    const shuffled = ['Medium Post URL', 'Title', 'Target URL'];
    assert.equal(findReportUrlColumn(shuffled), 2);
    assert.deepEqual(findPublishedUrlColumns(shuffled), [{ header: 'Medium Post URL', index: 0, platform: 'medium' }]);
  });

  test('matches headers case- and whitespace-insensitively', () => {
    assert.equal(headerIndex([' Target URL '], 'target url'), 0);
  });

  test('finds the per-platform last-posted column', () => {
    assert.equal(findLastPostedColumn(HEADERS, 'medium'), h('Last Posted Medium'));
    assert.equal(findLastPostedColumn(HEADERS, 'x'), h('Last Posted X'));
    assert.equal(findLastPostedColumn(HEADERS, 'hackmd'), undefined);
  });
});

describe('latestOf / toIsoTimestamp', () => {
  test('latestOf takes the most recent appended value', () => {
    assert.equal(latestOf('2025-01-15 | 2025-01-16'), '2025-01-16');
    assert.equal(latestOf('2025-01-15'), '2025-01-15');
    assert.equal(latestOf(''), '');
  });
  test('a date becomes midnight UTC', () => {
    assert.equal(toIsoTimestamp('2025-01-16'), '2025-01-16T00:00:00.000Z');
  });
  test('an ISO timestamp round-trips', () => {
    assert.equal(toIsoTimestamp('2025-01-16T08:30:00.000Z'), '2025-01-16T08:30:00.000Z');
  });
  test('junk falls back', () => {
    assert.equal(toIsoTimestamp('not a date', '2020-01-01T00:00:00.000Z'), '2020-01-01T00:00:00.000Z');
    assert.equal(toIsoTimestamp('', '2020-01-01T00:00:00.000Z'), '2020-01-01T00:00:00.000Z');
  });
});

// ── planRow ─────────────────────────────────────────────────────────────────

describe('planRow', () => {
  test('maps every populated platform column', () => {
    const plan = planRow(HEADERS, row({
      'Title': 'India Logistics Market',
      'Target URL': REPORT,
      'Medium Post URL': 'https://medium.com/@ken/india-logistics-market-a1b2c3d4e5',
      'HackMD Post URL': 'https://hackmd.io/@ken/india-logistics',
      'New Name': 'ken_blog_1',
      'Last Posted Medium': '2025-01-16',
    }), { sheetTab: 'Blogs', sheetRow: 7 });

    assert.equal(plan.skipped, false);
    assert.deepEqual(plan.posts.map(p => p.platform).sort(), ['hackmd', 'medium']);
    assert.equal(plan.posts.every(p => p.reportUrl === REPORT), true);
    assert.equal(plan.posts.every(p => p.sheetTab === 'Blogs' && p.sheetRow === 7), true);
    assert.equal(plan.posts.every(p => p.title === 'India Logistics Market'), true);
    assert.equal(plan.posts.every(p => p.account === 'ken_blog_1'), true);
    const medium = plan.posts.find(p => p.platform === 'medium')!;
    assert.equal(medium.postedAt, '2025-01-16T00:00:00.000Z');
    assert.equal(plan.mappings.every(m => m.cls.method === 'sheet'), true);
  });

  test('skips a row with no report URL', () => {
    const plan = planRow(HEADERS, row({ 'Medium Post URL': 'https://medium.com/@ken/p' }));
    assert.equal(plan.skipped, true);
    assert.equal(plan.reason, 'no report url');
    assert.deepEqual(plan.posts, []);
  });

  test('skips a row whose URL columns are blank or status text', () => {
    const plan = planRow(HEADERS, row({
      'Target URL': REPORT,
      'Medium Post URL': 'ERROR',
      'FB Post URL': '   ',
      'X Post URL': 'FAILED | N/A',
    }));
    assert.equal(plan.skipped, true);
    assert.deepEqual(plan.posts, []);
  });

  test('recovers the good URL from a mixed ERROR/url history cell', () => {
    const plan = planRow(HEADERS, row({
      'Target URL': REPORT,
      'Medium Post URL': 'ERROR | https://medium.com/@ken/p2',
    }));
    assert.deepEqual(plan.posts.map(p => p.publishedUrl), ['https://medium.com/@ken/p2']);
  });

  test('expands appended history into one post per URL', () => {
    const plan = planRow(HEADERS, row({
      'Target URL': REPORT,
      'Medium Post URL': 'https://medium.com/@ken/p1 | https://medium.com/@ken/p2',
    }));
    assert.deepEqual(plan.posts.map(p => p.publishedUrl), [
      'https://medium.com/@ken/p1', 'https://medium.com/@ken/p2',
    ]);
  });

  test('duplicate URLs in one cell collapse to one post', () => {
    const plan = planRow(HEADERS, row({
      'Target URL': REPORT,
      'Medium Post URL': 'https://medium.com/@ken/p1 | https://medium.com/@ken/p1?utm_source=medium',
    }));
    assert.equal(plan.posts.length, 1);
  });

  test('ignores the download and cover-image columns entirely', () => {
    const plan = planRow(HEADERS, row({
      'Target URL': REPORT,
      'Download Report URL': 'https://www.kenresearch.com/download/x',
      'Cover Image URL': 'https://img.example.com/a.png',
    }));
    assert.equal(plan.skipped, true);
  });

  test('normalises the report URL so one report is one key', () => {
    const a = planRow(HEADERS, row({ 'Target URL': REPORT, 'Medium Post URL': 'https://medium.com/@ken/p' }));
    const b = planRow(HEADERS, row({ 'Target URL': REPORT_UTM, 'Medium Post URL': 'https://medium.com/@ken/p' }));
    assert.equal(a.posts[0].reportUrl, b.posts[0].reportUrl);
  });

  test('tolerates a short row (trailing cells simply missing)', () => {
    const short = [''];
    assert.equal(planRow(HEADERS, short).skipped, true);
    const partial = ['T', REPORT];
    assert.equal(planRow(HEADERS, partial).skipped, true);
  });
});

// ── ingestFromSheet ─────────────────────────────────────────────────────────

const SHEET_FIXTURE: string[][] = [
  HEADERS,
  row({
    'Title': 'India Logistics Market',
    'Target URL': REPORT,
    'Medium Post URL': 'https://medium.com/@ken/india-logistics-market-a1b2c3d4e5',
    'HackMD Post URL': 'https://hackmd.io/@ken/india-logistics',
    'New Name': 'ken_blog_1',
    'Last Posted Medium': '2025-01-16',
  }),
  row({
    'Title': 'Brazil Cosmetics Market',
    'Target URL': 'https://www.kenresearch.com/industry-reports/brazil-cosmetics-market?utm_source=x',
    'FB Post URL': 'ERROR | https://facebook.com/ken/posts/123',
    'X Post URL': 'FAILED',
  }),
  row({ 'Title': 'No report url here', 'Medium Post URL': 'https://medium.com/@ken/orphan' }),
  row({ 'Title': 'Nothing published', 'Target URL': 'https://www.kenresearch.com/industry-reports/c' }),
];

describe('ingestFromSheet', () => {
  test('is a no-op when the intelligence flag is off', async () => {
    // Explicit rather than ambient: the test must prove the gate, not inherit
    // whatever FEATURE_INTELLIGENCE happens to be in the shell.
    const prev = process.env.FEATURE_INTELLIGENCE;
    delete process.env.FEATURE_INTELLIGENCE;
    try {
      const db = tmpDb();
      const res = await ingestFromSheet({ db, tab: 'Blogs', readRows: async () => SHEET_FIXTURE });
      assert.equal(res.ok, true);
      assert.equal(res.postsUpserted, 0);
      assert.equal(res.runId, null);
      assert.match(res.reason ?? '', /disabled/);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM published_posts').get() as any).n, 0);
    } finally {
      if (prev === undefined) delete process.env.FEATURE_INTELLIGENCE;
      else process.env.FEATURE_INTELLIGENCE = prev;
    }
  });

  test('runs without force once the flag is explicitly on', async () => {
    const prev = process.env.FEATURE_INTELLIGENCE;
    process.env.FEATURE_INTELLIGENCE = '1';
    try {
      const db = tmpDb();
      const res = await ingestFromSheet({ db, tab: 'Blogs', readRows: async () => SHEET_FIXTURE });
      assert.equal(res.ok, true);
      assert.equal(res.postsUpserted, 3);
    } finally {
      if (prev === undefined) delete process.env.FEATURE_INTELLIGENCE;
      else process.env.FEATURE_INTELLIGENCE = prev;
    }
  });

  test('an omitted tab falls back to the default, never "undefined!A:BZ"', async () => {
    // runCycle.ts calls ingestFromSheet({ db, limit }) with no tab.
    const db = tmpDb();
    const res = await ingestFromSheet({ db, force: true, readRows: async () => SHEET_FIXTURE });
    assert.equal(res.ok, true);
    assert.equal(res.postsUpserted, 3);
    const run = db.prepare('SELECT collector FROM collection_runs ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(run.collector, `urlMapping:${DEFAULT_TAB}`);
    assert.match(run.collector, /^urlMapping:\S/);
    assert.doesNotMatch(run.collector, /undefined/);
  });

  test('ingests posts and mappings from a fixture sheet', async () => {
    const db = tmpDb();
    const res = await ingestFromSheet({ db, tab: 'Blogs', force: true, readRows: async () => SHEET_FIXTURE });

    assert.equal(res.ok, true);
    assert.equal(res.status, 'ok');
    assert.equal(res.rowsRead, 4);
    assert.equal(res.postsUpserted, 3);   // medium, hackmd, facebook
    assert.equal(res.mappingsUpserted, 3);
    assert.equal(res.skippedRows, 2);     // no report url; nothing published

    const posts = db.prepare('SELECT * FROM published_posts ORDER BY platform').all() as any[];
    assert.deepEqual(posts.map(p => p.platform), ['facebook', 'hackmd', 'medium']);
    assert.equal(posts.every(p => p.sheet_tab === 'Blogs'), true);
    assert.equal(posts.find(p => p.platform === 'medium').sheet_row, 2);
    assert.equal(posts.find(p => p.platform === 'facebook').sheet_row, 3);
  });

  test('is idempotent — a second run updates, never duplicates', async () => {
    const db = tmpDb();
    await ingestFromSheet({ db, tab: 'Blogs', force: true, readRows: async () => SHEET_FIXTURE });
    const first = db.prepare('SELECT COUNT(*) AS n FROM published_posts').get() as any;
    const firstMap = db.prepare('SELECT COUNT(*) AS n FROM url_mapping').get() as any;

    await ingestFromSheet({ db, tab: 'Blogs', force: true, readRows: async () => SHEET_FIXTURE });
    await ingestFromSheet({ db, tab: 'Blogs', force: true, readRows: async () => SHEET_FIXTURE });

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM published_posts').get() as any).n, first.n);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM url_mapping').get() as any).n, firstMap.n);
  });

  test('honours limit', async () => {
    const db = tmpDb();
    const res = await ingestFromSheet({ db, tab: 'Blogs', force: true, limit: 1, readRows: async () => SHEET_FIXTURE });
    assert.equal(res.rowsRead, 1);
    assert.equal(res.postsUpserted, 2);
  });

  test('records a failed run when the credential is missing, without throwing', async () => {
    const db = tmpDb();
    const res = await ingestFromSheet({
      db, tab: 'Blogs', force: true,
      readRows: async () => { throw new Error('no-credentials'); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'failed');
    assert.match(res.reason ?? '', /credential/i);

    const run = db.prepare('SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(run.status, 'failed');
    assert.equal(run.collector, 'urlMapping:Blogs');
    assert.ok(run.finished_at);
  });

  test('fails loudly when the tab has no report-URL column', async () => {
    const db = tmpDb();
    const res = await ingestFromSheet({
      db, tab: 'Weird', force: true,
      readRows: async () => [['A', 'B'], ['1', '2']],
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'failed');
    assert.match(res.reason ?? '', /report-URL column/);
  });

  test('an empty tab is an ok run with nothing written', async () => {
    const db = tmpDb();
    const res = await ingestFromSheet({ db, tab: 'Blogs', force: true, readRows: async () => [HEADERS] });
    assert.equal(res.ok, true);
    assert.equal(res.postsUpserted, 0);
    const run = db.prepare('SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(run.status, 'ok');
  });

  test('records a successful run in collection_runs', async () => {
    const db = tmpDb();
    await ingestFromSheet({ db, tab: 'Blogs', force: true, readRows: async () => SHEET_FIXTURE });
    const run = db.prepare('SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(run.status, 'ok');
    assert.equal(run.rows_written, 6);
    assert.match(run.started_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

// ── mapping precedence + queries ────────────────────────────────────────────

describe('mapping precedence', () => {
  test('stronger evidence replaces weaker, weaker never downgrades stronger', () => {
    const db = tmpDb();
    const pub = 'https://medium.com/@ken/p';
    upsertMapping(db, REPORT, pub, 'medium', { method: 'slug', confidence: 0.4, reason: 'test' });
    upsertMapping(db, REPORT, pub, 'medium', { method: 'sheet', confidence: 0.95, reason: 'test' });
    let r = db.prepare('SELECT * FROM url_mapping').all() as any[];
    assert.equal(r.length, 1);
    assert.equal(r[0].method, 'sheet');

    upsertMapping(db, REPORT, pub, 'medium', { method: 'slug', confidence: 0.4, reason: 'test' });
    r = db.prepare('SELECT * FROM url_mapping').all() as any[];
    assert.equal(r[0].method, 'sheet', 'a weak guess must not overwrite a recorded fact');
  });

  test('a manual mapping is never overwritten automatically', () => {
    const db = tmpDb();
    const pub = 'https://medium.com/@ken/p';
    recordManualMapping(db, REPORT, pub, 'Medium');
    upsertMapping(db, REPORT, pub, 'medium', { method: 'sheet', confidence: 0.99, reason: 'test' });
    const r = db.prepare('SELECT * FROM url_mapping').get() as any;
    assert.equal(r.method, 'manual');
    assert.equal(r.confidence, 1);
    assert.equal(r.platform, 'medium');
  });

  test('recordManualMapping is the only producer of manual, and validates input', () => {
    const db = tmpDb();
    assert.throws(() => recordManualMapping(db, 'nope', 'https://a.com/p'), /absolute http/);
  });

  test('queries read back what was ingested', async () => {
    const db = tmpDb();
    await ingestFromSheet({ db, tab: 'Blogs', force: true, readRows: async () => SHEET_FIXTURE });

    const posts = postsForReport(db, REPORT_UTM); // normalised on the way in
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map(p => p.platform).sort(), ['hackmd', 'medium']);

    assert.equal(reportForPost(db, 'https://hackmd.io/@ken/india-logistics'), REPORT);
    assert.equal(reportForPost(db, 'https://hackmd.io/@ken/india-logistics?utm_source=hackmd'), REPORT);
    assert.equal(reportForPost(db, 'https://nowhere.com/x'), null);

    assert.deepEqual(mappingCoverage(db), { sheet: 3 });
  });
});
