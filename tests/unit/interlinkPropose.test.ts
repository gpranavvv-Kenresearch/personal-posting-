/**
 * Tests for src/intelligence/interlink/propose.ts.
 *
 * Everything here is offline: a temp SQLite file and injected source text.
 * No network call, no live API, no spreadsheet.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type DB } from '../../src/intelligence/db.js';
import { DEFAULT_INTERLINK_LIMITS, type InterlinkLimits } from '../../src/intelligence/weights.js';
import {
  tokenize, bigrams, relevanceScore, RELEVANCE_WEIGHTS,
  splitParagraphs, wordCount, isHeading, isCodeBlock, isListItem,
  countLinks, containsLinkTo, linkKey, linkRanges,
  paragraphRejection, findBestParagraph,
  generateAnchorText, isBannedAnchor, BANNED_ANCHORS, MAX_ANCHOR_CHARS,
  selectSources, selectDestinations, destinationGap, normaliseIndexation,
  paragraphHash, insertProposal, activeProposalsForSource,
  proposalsForDestinationSince, lastEditOfSource,
  generateProposals, formatProposalRun, tagDestinationUrl,
  type SourceCandidate,
} from '../../src/intelligence/interlink/propose.js';

// ── temp db plumbing ─────────────────────────────────────────────────────────

let dir: string;
let db: DB;

function fresh(): DB {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlink-'));
  return openDb(path.join(dir, 'test.db'));
}

beforeEach(() => { db = fresh(); });
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function withProposalFlags<T>(fn: () => T): T {
  const before = {
    master: process.env.FEATURE_INTELLIGENCE,
    prop: process.env.FEATURE_INTERLINKING_PROPOSALS,
  };
  process.env.FEATURE_INTELLIGENCE = '1';
  process.env.FEATURE_INTERLINKING_PROPOSALS = '1';
  try {
    return fn();
  } finally {
    if (before.master === undefined) delete process.env.FEATURE_INTELLIGENCE;
    else process.env.FEATURE_INTELLIGENCE = before.master;
    if (before.prop === undefined) delete process.env.FEATURE_INTERLINKING_PROPOSALS;
    else process.env.FEATURE_INTERLINKING_PROPOSALS = before.prop;
  }
}

const NOW = new Date('2026-11-16T12:00:00.000Z');
const isoAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function addPost(over: Partial<{
  report_url: string; platform: string; published_url: string; title: string; posted_at: string;
}> = {}): void {
  const r = {
    report_url: 'https://www.kenresearch.com/industry-reports/india-hospital-market',
    platform: 'hackmd',
    published_url: `https://hackmd.io/@ken/${Math.random().toString(36).slice(2, 10)}`,
    title: 'India Hospital Market Outlook 2030',
    posted_at: isoAgo(240),
    ...over,
  };
  db.prepare(`INSERT INTO published_posts
      (report_url, platform, published_url, title, posted_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(r.report_url, r.platform, r.published_url, r.title, r.posted_at, r.posted_at);
}

function addIndexation(url: string, status: 'indexed' | 'not_indexed' | 'unknown', checkedAt = isoAgo(1)): void {
  db.prepare(`INSERT INTO indexation_checks (url, checked_at, status, provider, confidence)
              VALUES (?, ?, ?, 'test', 0.8)`).run(url, checkedAt, status);
}

function addPerformance(url: string, position: number): void {
  db.prepare(`INSERT INTO url_performance
      (url, source, metric_date, metric_scope, position, collected_at)
      VALUES (?, 'gsc', '2026-11-10', 'url', ?, ?)`).run(url, position, NOW.toISOString());
}

// Realistic-ish source body used across the paragraph/anchor tests.
const SOURCE_TEXT = [
  '# India Healthcare Briefing',
  'The India hospital market has expanded quickly over the past five years, and the ' +
  'India hospital market outlook for 2030 depends on how fast tier-two cities add ' +
  'capacity across private hospital networks and diagnostic chains nationwide.',
  '- a bullet about the India hospital market outlook 2030 that is long enough to otherwise qualify for a link here easily',
  '```\nconst indiaHospitalMarketOutlook2030 = true; // the India hospital market outlook 2030 code sample long enough\n```',
  'Short note.',
  'Separately, the Indonesia logistics market grew on the back of e-commerce volumes, ' +
  'with cold chain operators and last mile delivery firms both adding warehouse space ' +
  'through the year across the archipelago and its secondary port cities.',
].join('\n\n');

// ── 3. relevance ─────────────────────────────────────────────────────────────

describe('tokenize / bigrams', () => {
  test('lowercases, drops stopwords, short tokens and urls', () => {
    const t = tokenize('The India Hospital Market is at https://example.com/x a big one');
    assert.ok(!t.includes('the'));
    assert.ok(!t.includes('is'));
    assert.ok(!t.includes('example'));
    assert.ok(t.includes('india'));
    assert.ok(t.includes('hospital'));
  });

  test('"report" is a stopword — it is in every title we own', () => {
    assert.deepEqual(tokenize('Report'), []);
    assert.deepEqual(tokenize('reports'), []);
  });

  test('plural and -ies forms collapse onto the singular', () => {
    assert.deepEqual(tokenize('hospitals'), tokenize('hospital'));
    assert.deepEqual(tokenize('industries'), tokenize('industry'));
  });

  test('bigrams are adjacent token pairs', () => {
    assert.deepEqual(bigrams(['a', 'b', 'c']), ['a b', 'b c']);
    assert.deepEqual(bigrams(['a']), []);
    assert.deepEqual(bigrams([]), []);
  });
});

describe('relevanceScore', () => {
  test('is 0 for empty source text', () => {
    assert.equal(relevanceScore('', 'India Hospital Market', 'india-hospital-market'), 0);
    assert.equal(relevanceScore(null, 'India Hospital Market', ''), 0);
  });

  test('is 0 when the destination has no usable tokens', () => {
    assert.equal(relevanceScore('a long piece of text about hospitals', 'The Report', ''), 0);
  });

  test('is 1 for an exact topical restatement', () => {
    const s = relevanceScore(
      'India hospital market outlook 2030',
      'India Hospital Market Outlook 2030',
      'india-hospital-market-outlook-2030',
    );
    assert.equal(s, 1);
  });

  test('is 0 when nothing at all overlaps', () => {
    const s = relevanceScore(
      'Norwegian salmon aquaculture feed conversion ratios',
      'India Hospital Market Outlook 2030',
      'india-hospital-market-outlook-2030',
    );
    assert.equal(s, 0);
  });

  test('ranks a closely related page above a loosely related one', () => {
    const close = relevanceScore(
      'The India hospital market is growing and the hospital market outlook is strong.',
      'India Hospital Market Outlook 2030', 'india-hospital-market-outlook-2030');
    const loose = relevanceScore(
      'The India logistics market is growing fast across the country.',
      'India Hospital Market Outlook 2030', 'india-hospital-market-outlook-2030');
    assert.ok(close > loose, `${close} should beat ${loose}`);
    assert.ok(loose > 0 && loose < 0.5);
  });

  test('stays within 0..1 for any input', () => {
    const inputs = ['', 'x', SOURCE_TEXT, 'india '.repeat(500)];
    for (const i of inputs) {
      const s = relevanceScore(i, 'India Hospital Market Outlook 2030', 'india-hospital-market');
      assert.ok(s >= 0 && s <= 1, `${s} out of range`);
    }
  });

  test('missing slug does not drag the score down (weights renormalise)', () => {
    const withSlug = relevanceScore('India hospital market outlook 2030',
      'India Hospital Market Outlook 2030', 'india-hospital-market-outlook-2030');
    const noSlug = relevanceScore('India hospital market outlook 2030',
      'India Hospital Market Outlook 2030', '');
    assert.equal(withSlug, noSlug);
  });

  test('bigram component rewards word ORDER, not just vocabulary', () => {
    const ordered = relevanceScore('the india hospital market is large',
      'India Hospital Market', '');
    const scrambled = relevanceScore('market the hospital a india',
      'India Hospital Market', '');
    assert.ok(ordered > scrambled, `${ordered} should beat ${scrambled}`);
  });

  test('component weights sum to 1', () => {
    const sum = RELEVANCE_WEIGHTS.unigram + RELEVANCE_WEIGHTS.bigram + RELEVANCE_WEIGHTS.slug;
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

// ── 4. paragraph selection ───────────────────────────────────────────────────

describe('paragraph helpers', () => {
  test('splitParagraphs splits on blank lines and trims', () => {
    assert.deepEqual(splitParagraphs('one\n\n  two  \n\n\n three'), ['one', 'two', 'three']);
    assert.deepEqual(splitParagraphs(''), []);
    assert.deepEqual(splitParagraphs(null), []);
  });

  test('splitParagraphs handles CRLF', () => {
    assert.deepEqual(splitParagraphs('one\r\n\r\ntwo'), ['one', 'two']);
  });

  test('wordCount', () => {
    assert.equal(wordCount('  a  b   c '), 3);
    assert.equal(wordCount(''), 0);
  });

  test('isHeading detects markdown, html and setext headings', () => {
    assert.ok(isHeading('## India Hospital Market'));
    assert.ok(isHeading('<h2>India</h2>'));
    assert.ok(isHeading('Title\n====='));
    assert.ok(!isHeading('#hashtag not a heading'));
    assert.ok(!isHeading('A normal sentence.'));
  });

  test('isCodeBlock detects fences, indents and html', () => {
    assert.ok(isCodeBlock('```js\nconst a = 1;\n```'));
    assert.ok(isCodeBlock('~~~\ncode\n~~~'));
    assert.ok(isCodeBlock('    indented code'));
    assert.ok(isCodeBlock('<pre>x</pre>'));
    assert.ok(!isCodeBlock('Normal prose about code.'));
  });

  test('isListItem detects bullets, numbers, quotes and html lists', () => {
    assert.ok(isListItem('- bullet'));
    assert.ok(isListItem('* bullet'));
    assert.ok(isListItem('1. first'));
    assert.ok(isListItem('2) second'));
    assert.ok(isListItem('> quoted'));
    assert.ok(isListItem('<ul><li>x</li></ul>'));
    assert.ok(!isListItem('Prose - with a dash inside.'));
  });

  test('countLinks counts markdown, html and bare urls without double counting', () => {
    assert.equal(countLinks('no links here'), 0);
    assert.equal(countLinks('[a](https://x.com) and [b](https://y.com)'), 2);
    assert.equal(countLinks('<a href="https://x.com">a</a>'), 1);
    assert.equal(countLinks('see https://x.com/page for more'), 1);
  });

  test('linkKey normalises protocol, www, query, hash and trailing slash', () => {
    const a = linkKey('https://www.kenresearch.com/x/y/?utm_source=hackmd#top');
    assert.equal(a, 'kenresearch.com/x/y');
    assert.equal(linkKey('http://kenresearch.com/x/y'), a);
    assert.equal(linkKey(''), '');
    assert.equal(linkKey(null), '');
  });

  test('containsLinkTo sees the destination however it is written', () => {
    const dest = 'https://www.kenresearch.com/industry-reports/india-hospital-market';
    assert.ok(containsLinkTo('text [anchor](https://kenresearch.com/industry-reports/india-hospital-market) more', dest));
    assert.ok(containsLinkTo('text https://www.kenresearch.com/industry-reports/india-hospital-market?utm_source=x', dest));
    assert.ok(!containsLinkTo('text about hospitals with no link', dest));
  });

  test('linkRanges reports the spans occupied by links', () => {
    const p = 'start [anchor](https://x.com) end';
    const r = linkRanges(p);
    assert.ok(r.length >= 1);
    assert.equal(p.slice(r[0][0], r[0][1]), '[anchor](https://x.com)');
  });
});

describe('paragraphRejection', () => {
  const dest = { url: 'https://www.kenresearch.com/industry-reports/india-hospital-market', title: 'India Hospital Market' };
  const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

  test('rejects a paragraph below minParagraphWords', () => {
    assert.equal(paragraphRejection('too short indeed', dest), 'too_short');
  });

  test('rejects headings, code and list items before counting words', () => {
    assert.equal(paragraphRejection(`## ${long(40)}`, dest), 'heading');
    assert.equal(paragraphRejection('```\n' + long(40) + '\n```', dest), 'code_block');
    assert.equal(paragraphRejection(`- ${long(40)}`, dest), 'list_item');
  });

  test('rejects a paragraph that already links to that destination', () => {
    const p = `${long(40)} [x](${dest.url})`;
    assert.equal(paragraphRejection(p, dest), 'already_links');
  });

  test('rejects a link-dense paragraph', () => {
    const p = `${long(40)} [a](https://a.com) [b](https://b.com)`;
    assert.equal(paragraphRejection(p, dest), 'link_dense');
  });

  test('accepts a plain prose paragraph of adequate length', () => {
    assert.equal(paragraphRejection(long(40), dest), null);
  });

  test('a single existing link is tolerated', () => {
    assert.equal(paragraphRejection(`${long(40)} [a](https://a.com)`, dest), null);
  });
});

describe('findBestParagraph', () => {
  const dest = {
    url: 'https://www.kenresearch.com/industry-reports/india-hospital-market-outlook-2030',
    title: 'India Hospital Market Outlook 2030',
    slug: 'india-hospital-market-outlook-2030',
  };

  test('picks the prose paragraph, skipping heading, list, code and short text', () => {
    const pick = findBestParagraph(SOURCE_TEXT, dest);
    assert.ok(pick);
    assert.ok(pick!.paragraph.startsWith('The India hospital market has expanded'));
    assert.equal(pick!.index, 1);
    assert.ok(pick!.score > 0.5);
  });

  test('index refers to the position among ALL paragraphs, skipped ones included', () => {
    const text = '# Heading\n\nshort\n\n' + SOURCE_TEXT;
    const pick = findBestParagraph(text, dest);
    assert.ok(pick);
    assert.equal(splitParagraphs(text)[pick!.index], pick!.paragraph);
  });

  test('returns null when every paragraph is ineligible', () => {
    const text = '# Heading only\n\n- a list item\n\n```\ncode\n```\n\nshort one';
    assert.equal(findBestParagraph(text, dest), null);
  });

  test('returns null when nothing is topically related at all', () => {
    const text = 'Norwegian salmon aquaculture feed conversion ratios have improved steadily ' +
      'over the last decade across the fjords, with farmed biomass rising every single year since then.';
    assert.equal(findBestParagraph(text, dest), null);
  });

  test('a paragraph already linking to the destination is never chosen', () => {
    const text = `The India hospital market outlook 2030 is explored at length in [this](${dest.url}) ` +
      'piece, with the India hospital market outlook 2030 analysed across every state and union territory.';
    assert.equal(findBestParagraph(text, dest), null);
  });

  test('honours a raised minParagraphWords', () => {
    const limits: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS, minParagraphWords: 500 };
    assert.equal(findBestParagraph(SOURCE_TEXT, dest, limits), null);
  });
});

// ── 5. anchor text ───────────────────────────────────────────────────────────

describe('generateAnchorText', () => {
  test('exact match found: returns the phrase verbatim from the paragraph', () => {
    const p = 'Demand across the india hospital market has risen every quarter since 2024.';
    const r = generateAnchorText(p, 'India Hospital Market Outlook 2030');
    assert.equal(r.strategy, 'verbatim');
    assert.equal(r.foundInParagraph, true);
    assert.ok(p.includes(r.anchor), `"${r.anchor}" is not verbatim in the paragraph`);
    assert.equal(r.anchor.toLowerCase(), 'india hospital market');
  });

  test('prefers the LONGEST verbatim phrase available', () => {
    const p = 'The india hospital market outlook 2030 is the subject of this note.';
    const r = generateAnchorText(p, 'India Hospital Market Outlook 2030');
    assert.equal(r.anchor.toLowerCase(), 'india hospital market outlook 2030');
  });

  test('no match: falls back to a descriptive phrase', () => {
    const p = 'Norwegian salmon aquaculture feed ratios improved again this year.';
    const r = generateAnchorText(p, 'India Hospital Market Outlook 2030');
    assert.equal(r.strategy, 'descriptive');
    assert.equal(r.foundInParagraph, false);
    assert.equal(r.anchor, 'India Hospital Market Outlook 2030');
  });

  test('anchor too long: a very long title is trimmed in the descriptive fallback', () => {
    const title = 'Comprehensive Strategic Assessment Of Nationwide Tertiary Healthcare Infrastructure ' +
      'Investment Across Emerging Economies Through 2035';
    const r = generateAnchorText('Entirely unrelated prose about shipping containers in Rotterdam harbour.', title);
    assert.equal(r.strategy, 'descriptive');
    assert.ok(r.anchor.length <= MAX_ANCHOR_CHARS, `${r.anchor.length} chars`);
    assert.ok(r.anchor.split(/\s+/).length <= 8);
    assert.ok(title.startsWith(r.anchor));
  });

  test('a verbatim candidate longer than the char cap is not used', () => {
    const title = 'Comprehensive Strategic Assessment Of Nationwide Tertiary Healthcare Infrastructure Investment';
    const p = `The ${title} was published today, and the healthcare infrastructure debate continues.`;
    const r = generateAnchorText(p, title);
    assert.ok(r.anchor.length <= MAX_ANCHOR_CHARS);
    if (r.strategy === 'verbatim') assert.ok(p.includes(r.anchor));
  });

  test('never lands inside an existing link', () => {
    const p = 'See [india hospital market](https://other.com/x) for context, though the ' +
      'indian private hospital capacity story is separate.';
    const r = generateAnchorText(p, 'India Hospital Market');
    if (r.strategy === 'verbatim') {
      // At least one occurrence of the chosen anchor must sit outside every link.
      const ranges = linkRanges(p);
      const occurrences: number[] = [];
      for (let i = p.indexOf(r.anchor); i !== -1; i = p.indexOf(r.anchor, i + 1)) occurrences.push(i);
      const free = occurrences.some(at => !ranges.some(([a, b]) => at >= a && at < b));
      assert.ok(free, 'every occurrence of the anchor is inside an existing link');
    } else {
      assert.equal(r.foundInParagraph, false);
    }
  });

  test('picks the occurrence OUTSIDE the link when one exists', () => {
    const p = 'See [india hospital market](https://other.com/x) for context. The india hospital ' +
      'market itself keeps growing in every single state of the country.';
    const r = generateAnchorText(p, 'India Hospital Market');
    assert.equal(r.strategy, 'verbatim');
    const at = p.indexOf(r.anchor, p.indexOf('for context'));
    assert.ok(at > 0);
  });

  test('punctuation at the boundaries is trimmed off the anchor', () => {
    const p = 'Growth continued (india hospital market), and capacity rose across the country again.';
    const r = generateAnchorText(p, 'India Hospital Market');
    assert.equal(r.anchor, 'india hospital market');
    assert.ok(!/^[^A-Za-z0-9]/.test(r.anchor));
    assert.ok(!/[^A-Za-z0-9)\]]$/.test(r.anchor));
  });

  test('matches across a line break inside the paragraph', () => {
    const p = 'Capacity rose because the india hospital\nmarket absorbed new private beds quickly.';
    const r = generateAnchorText(p, 'India Hospital Market');
    assert.equal(r.strategy, 'verbatim');
    assert.ok(/india hospital\s+market/i.test(r.anchor));
  });

  test('never emits a banned anchor', () => {
    for (const banned of BANNED_ANCHORS) {
      const r = generateAnchorText(`Please ${banned} to continue reading this page.`, banned);
      assert.equal(r.anchor, '', `generated banned anchor "${banned}"`);
    }
  });

  test('a stopword-only title yields no anchor rather than a bad one', () => {
    const r = generateAnchorText('Some prose about the thing and the other thing entirely.', 'The Report');
    assert.equal(r.anchor, '');
  });

  test('empty title yields no anchor', () => {
    assert.equal(generateAnchorText('Some prose here.', '').anchor, '');
    assert.equal(generateAnchorText('Some prose here.', null).anchor, '');
  });

  test('isBannedAnchor is case and punctuation insensitive', () => {
    assert.ok(isBannedAnchor('Click Here'));
    assert.ok(isBannedAnchor('  read more  '));
    assert.ok(isBannedAnchor(''));
    assert.ok(!isBannedAnchor('india hospital market'));
  });

  test('a single distinctive word is used when no phrase matches', () => {
    const p = 'Capacity across Indonesian provinces grew steadily throughout the reporting period.';
    const r = generateAnchorText(p, 'Indonesian Cold Chain Outlook');
    assert.equal(r.strategy, 'verbatim');
    assert.equal(r.anchor.toLowerCase(), 'indonesian');
  });
});

// ── 1 & 2. selection ─────────────────────────────────────────────────────────

describe('selectSources', () => {
  test('excludes platforms that cannot be edited, including "unknown"', () => {
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/a' });
    addPost({ platform: 'mataroa', published_url: 'https://mataroa.blog/ken/a' });
    addPost({ platform: 'medium', published_url: 'https://medium.com/@ken/a' });   // unknown
    addPost({ platform: 'twitter', published_url: 'https://x.com/ken/1' });        // none
    const got = selectSources({ db }).map(s => s.platform).sort();
    assert.deepEqual(got, ['hackmd', 'mataroa']);
  });

  test('prefers sources with positive indexation evidence', () => {
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/notindexed', posted_at: isoAgo(10) });
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/unknown', posted_at: isoAgo(20) });
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/indexed', posted_at: isoAgo(30) });
    addIndexation('https://hackmd.io/@ken/notindexed', 'not_indexed');
    addIndexation('https://hackmd.io/@ken/unknown', 'unknown');
    addIndexation('https://hackmd.io/@ken/indexed', 'indexed');

    const order = selectSources({ db }).map(s => s.indexation);
    assert.deepEqual(order, ['indexed', 'unknown', 'not_indexed']);
  });

  test('uses the most recent indexation check', () => {
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/a' });
    addIndexation('https://hackmd.io/@ken/a', 'not_indexed', isoAgo(100));
    addIndexation('https://hackmd.io/@ken/a', 'indexed', isoAgo(1));
    assert.equal(selectSources({ db })[0].indexation, 'indexed');
  });

  test('no indexation evidence reads as "unknown", never as a failure', () => {
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/a' });
    assert.equal(selectSources({ db })[0].indexation, 'unknown');
  });

  test('skips rows with no published_url and respects limit', () => {
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/a' });
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/b' });
    db.prepare(`INSERT INTO published_posts (report_url, platform, published_url, posted_at, created_at)
                VALUES ('https://www.kenresearch.com/r/x', 'hackmd', '', ?, ?)`)
      .run(isoAgo(5), isoAgo(5));
    assert.equal(selectSources({ db }).length, 2);
    assert.equal(selectSources({ db, limit: 1 }).length, 1);
  });
});

describe('destinationGap', () => {
  test('a confirmed gap outranks an unknown', () => {
    assert.ok(destinationGap('not_indexed', null) > destinationGap('unknown', null));
  });

  test('an unknown is not treated as a confirmed gap', () => {
    assert.ok(destinationGap('unknown', null) < 1);
    assert.ok(destinationGap('unknown', null) > 0);
  });

  test('an indexed, top-ranked page has no gap and is dropped', () => {
    assert.equal(destinationGap('indexed', 5), 0);
  });

  test('a mid-page rank has more upside than a far-back one', () => {
    assert.ok(destinationGap('indexed', 45) > destinationGap('indexed', 180));
  });

  test('indexed with no rank data gets a small, non-zero gap', () => {
    const g = destinationGap('indexed', null);
    assert.ok(g > 0 && g < 0.5);
  });
});

describe('selectDestinations', () => {
  const R1 = 'https://www.kenresearch.com/industry-reports/report-one';
  const R2 = 'https://www.kenresearch.com/industry-reports/report-two';
  const R3 = 'https://www.kenresearch.com/industry-reports/report-three';

  test('ranks a confirmed not-indexed report above an unknown one', () => {
    addPost({ report_url: R1, published_url: 'https://hackmd.io/@ken/1' });
    addPost({ report_url: R2, published_url: 'https://hackmd.io/@ken/2' });
    addIndexation(R1, 'unknown');
    addIndexation(R2, 'not_indexed');
    const got = selectDestinations({ db });
    assert.equal(got[0].url, R2);
    assert.equal(got[1].url, R1);
  });

  test('drops a strongly ranked indexed report', () => {
    addPost({ report_url: R3, published_url: 'https://hackmd.io/@ken/3' });
    addIndexation(R3, 'indexed');
    addPerformance(R3, 4);
    assert.deepEqual(selectDestinations({ db }).map(d => d.url), []);
  });

  test('keeps an indexed but weakly ranked report', () => {
    addPost({ report_url: R3, published_url: 'https://hackmd.io/@ken/3' });
    addIndexation(R3, 'indexed');
    addPerformance(R3, 48);
    const got = selectDestinations({ db });
    assert.equal(got.length, 1);
    assert.equal(got[0].position, 48);
  });

  test('derives a slug and carries the title through', () => {
    addPost({ report_url: R1, published_url: 'https://hackmd.io/@ken/1', title: 'Report One Title' });
    const d = selectDestinations({ db })[0];
    assert.equal(d.slug, 'report-one');
    assert.equal(d.title, 'Report One Title');
  });

  test('deduplicates a report promoted on many platforms', () => {
    addPost({ report_url: R1, published_url: 'https://hackmd.io/@ken/1' });
    addPost({ report_url: R1, published_url: 'https://medium.com/@ken/1', platform: 'medium' });
    assert.equal(selectDestinations({ db }).filter(d => d.url === R1).length, 1);
  });
});

// ── 7. persistence helpers ───────────────────────────────────────────────────

describe('paragraphHash', () => {
  test('is stable and whitespace-insensitive', () => {
    assert.equal(paragraphHash('a  b\n c'), paragraphHash(' a b c '));
  });
  test('changes when the text changes', () => {
    assert.notEqual(paragraphHash('a b c'), paragraphHash('a b d'));
  });
  test('is a fixed-length hex string', () => {
    assert.match(paragraphHash('anything'), /^[0-9a-f]{32}$/);
  });
});

describe('insertProposal', () => {
  const base = {
    sourceUrl: 'https://hackmd.io/@ken/a',
    sourcePlatform: 'hackmd',
    destinationUrl: 'https://www.kenresearch.com/r/one',
    anchorText: 'india hospital market',
    paragraph: 'A paragraph about the india hospital market.',
    relevance: 0.8,
  };

  test('inserts with status proposed and stores the paragraph hash', () => {
    const id = insertProposal(db, base, NOW.toISOString());
    assert.ok(id);
    const row = db.prepare('SELECT * FROM interlink_proposals WHERE id = ?').get(id!) as any;
    assert.equal(row.status, 'proposed');
    assert.equal(row.paragraph_hash, paragraphHash(base.paragraph));
    assert.equal(row.anchor_text, base.anchorText);
  });

  test('is idempotent on (source, destination, anchor)', () => {
    assert.ok(insertProposal(db, base, NOW.toISOString()));
    assert.equal(insertProposal(db, base, NOW.toISOString()), null);
    const n = db.prepare('SELECT COUNT(*) AS n FROM interlink_proposals').get() as any;
    assert.equal(Number(n.n), 1);
  });

  test('truncates a very long paragraph excerpt', () => {
    const id = insertProposal(db, { ...base, anchorText: 'x', paragraph: 'y'.repeat(5000) }, NOW.toISOString());
    const row = db.prepare('SELECT paragraph_excerpt FROM interlink_proposals WHERE id = ?').get(id!) as any;
    assert.equal(row.paragraph_excerpt.length, 500);
  });

  test('counting helpers ignore rejected proposals', () => {
    insertProposal(db, base, NOW.toISOString());
    insertProposal(db, { ...base, anchorText: 'other anchor' }, NOW.toISOString());
    db.prepare(`UPDATE interlink_proposals SET status='rejected' WHERE anchor_text='other anchor'`).run();
    assert.equal(activeProposalsForSource(db, base.sourceUrl), 1);
    assert.equal(proposalsForDestinationSince(db, base.destinationUrl, isoAgo(24 * 7)), 1);
  });

  test('proposalsForDestinationSince respects the window', () => {
    insertProposal(db, base, isoAgo(24 * 30));
    assert.equal(proposalsForDestinationSince(db, base.destinationUrl, isoAgo(24 * 7)), 0);
  });
});

describe('lastEditOfSource', () => {
  test('is the publication time when nothing has been applied', () => {
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/a', posted_at: isoAgo(50) });
    assert.equal(lastEditOfSource(db, 'https://hackmd.io/@ken/a'), isoAgo(50));
  });

  test('is the most recent applied interlink when later', () => {
    addPost({ platform: 'hackmd', published_url: 'https://hackmd.io/@ken/a', posted_at: isoAgo(50) });
    const id = insertProposal(db, {
      sourceUrl: 'https://hackmd.io/@ken/a', destinationUrl: 'https://www.kenresearch.com/r/x',
      anchorText: 'a', paragraph: 'p', relevance: 1,
    }, isoAgo(5));
    db.prepare(`UPDATE interlink_proposals SET status='applied', applied_at=? WHERE id=?`).run(isoAgo(2), id!);
    assert.equal(lastEditOfSource(db, 'https://hackmd.io/@ken/a'), isoAgo(2));
  });

  test('is null for an unknown source', () => {
    assert.equal(lastEditOfSource(db, 'https://hackmd.io/@ken/nope'), null);
  });
});

// ── 6. end-to-end generation and limit enforcement ───────────────────────────

const DEST_TITLE = 'India Hospital Market Outlook 2030';
const DEST_URL = 'https://www.kenresearch.com/industry-reports/india-hospital-market-outlook-2030';
const SRC_URL = 'https://hackmd.io/@ken/source-one';

const BODY =
  'The India hospital market has expanded quickly over the past five years, and the ' +
  'india hospital market outlook for 2030 depends on how fast tier-two cities add ' +
  'capacity across private hospital networks and diagnostic chains nationwide.\n\n' +
  'Second paragraph discussing the india hospital market outlook 2030 in further detail, ' +
  'covering bed density, insurance penetration and the pace of private investment overall.';

function seedBasic(): void {
  // Source page, published long enough ago to clear the cooldown.
  addPost({ platform: 'hackmd', published_url: SRC_URL, posted_at: isoAgo(500),
    report_url: 'https://www.kenresearch.com/industry-reports/some-other-report' });
  addIndexation(SRC_URL, 'indexed');
  // Destination report, promoted elsewhere, confirmed not indexed.
  addPost({ platform: 'medium', published_url: 'https://medium.com/@ken/dest', posted_at: isoAgo(500),
    report_url: DEST_URL, title: DEST_TITLE });
  addIndexation(DEST_URL, 'not_indexed');
}

const feed = (text: string | null) => (_s: SourceCandidate) => text;

describe('generateProposals', () => {
  test('is a no-op when the flag is off', async () => {
    seedBasic();
    const res = await generateProposals({ db, fetchSourceText: feed(BODY), now: NOW });
    assert.equal(res.created, 0);
    assert.equal(res.skipped.disabled, 1);
    const n = db.prepare('SELECT COUNT(*) AS n FROM interlink_proposals').get() as any;
    assert.equal(Number(n.n), 0);
  });

  test('is a no-op when only the feature flag is on but the master switch is off', async () => {
    seedBasic();
    const before = process.env.FEATURE_INTERLINKING_PROPOSALS;
    process.env.FEATURE_INTERLINKING_PROPOSALS = '1';
    delete process.env.FEATURE_INTELLIGENCE;
    try {
      const res = await generateProposals({ db, fetchSourceText: feed(BODY), now: NOW });
      assert.equal(res.created, 0);
      assert.equal(res.skipped.disabled, 1);
    } finally {
      if (before === undefined) delete process.env.FEATURE_INTERLINKING_PROPOSALS;
      else process.env.FEATURE_INTERLINKING_PROPOSALS = before;
    }
  });

  test('creates a proposal with status proposed and a usable anchor', async () => {
    seedBasic();
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.equal(res.created, 1);
    const p = res.proposals[0];
    assert.equal(p.sourceUrl, SRC_URL);
    // Tagged with the hackmd source's UTM — see tagDestinationUrl's own tests
    // for the tagging logic itself; this just checks generateProposals wires it in.
    assert.equal(p.destinationUrl, tagDestinationUrl(DEST_URL, 'hackmd'));
    assert.ok(p.relevance >= DEFAULT_INTERLINK_LIMITS.minRelevanceToPropose);
    assert.ok(!isBannedAnchor(p.anchorText));

    const row = db.prepare('SELECT * FROM interlink_proposals WHERE id = ?').get(p.id) as any;
    assert.equal(row.status, 'proposed');
    assert.equal(row.source_platform, 'hackmd');
    assert.ok(row.rationale.includes('relevance'));
    assert.ok(row.paragraph_hash);
  });

  test('re-running produces no duplicates', async () => {
    seedBasic();
    await withProposalFlags(() => generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    const second = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    const n = db.prepare('SELECT COUNT(*) AS n FROM interlink_proposals').get() as any;
    assert.equal(Number(n.n), 1);
    assert.equal(second.created, 0);
  });

  test('never proposes a link from a post to its own report', async () => {
    addPost({ platform: 'hackmd', published_url: SRC_URL, posted_at: isoAgo(500), report_url: DEST_URL, title: DEST_TITLE });
    addIndexation(DEST_URL, 'not_indexed');
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.equal(res.created, 0);
    assert.equal(res.skipped.self_link, 1);
  });

  test('skips a source whose text cannot be fetched', async () => {
    seedBasic();
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(null), now: NOW }));
    assert.equal(res.created, 0);
    assert.equal(res.skipped.no_source_text, 1);
  });

  test('skips when the page already links to the destination', async () => {
    seedBasic();
    const text = `${BODY}\n\nAlready linked here: [outlook](${DEST_URL}) in a closing note.`;
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(text), now: NOW }));
    assert.equal(res.created, 0);
    assert.equal(res.skipped.already_linked, 1);
  });

  test('skips when relevance is below minRelevanceToPropose', async () => {
    seedBasic();
    const unrelated =
      'Norwegian salmon aquaculture feed conversion ratios improved across the fjords again, ' +
      'with farmed biomass rising every single year of the past decade without exception at all.';
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(unrelated), now: NOW }));
    assert.equal(res.created, 0);
    assert.ok((res.skipped.low_relevance ?? 0) + (res.skipped.no_paragraph ?? 0) === 1);
  });

  test('a raised minRelevanceToPropose blocks a borderline proposal', async () => {
    // Partial topical match: shares "india hospital market", missing "outlook 2030".
    const partial =
      'The india hospital market expanded quickly over the past five years as tier-two ' +
      'cities added capacity across private networks and diagnostic chains nationwide, ' +
      'with insurance penetration rising steadily in every single state of the country.';

    seedBasic();
    const strict: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS, minRelevanceToPropose: 0.9 };
    const blocked = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(partial), now: NOW, limits: strict }));
    assert.equal(blocked.created, 0);
    assert.equal(blocked.skipped.low_relevance, 1);

    // The same page passes at the default threshold — so the limit, not the text, blocked it.
    const allowed = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(partial), now: NOW }));
    assert.equal(allowed.created, 1);
    assert.ok(allowed.proposals[0].relevance < 0.9);
  });

  test('only editable platforms are ever used as a source', async () => {
    addPost({ platform: 'medium', published_url: 'https://medium.com/@ken/src', posted_at: isoAgo(500),
      report_url: 'https://www.kenresearch.com/industry-reports/other' });
    addPost({ platform: 'twitter', published_url: 'https://x.com/ken/9', posted_at: isoAgo(500),
      report_url: DEST_URL, title: DEST_TITLE });
    addIndexation(DEST_URL, 'not_indexed');
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.equal(res.created, 0);
    assert.equal(res.considered, 0);
  });

  // ── limits ───────────────────────────────────────────────────────────────

  test('maxNewLinksPerSourcePage caps proposals on one page', async () => {
    addPost({ platform: 'hackmd', published_url: SRC_URL, posted_at: isoAgo(500),
      report_url: 'https://www.kenresearch.com/industry-reports/other' });
    let body = BODY;
    for (let i = 0; i < 6; i++) {
      const url = `https://www.kenresearch.com/industry-reports/india-hospital-market-report-${i}`;
      addPost({ platform: 'medium', published_url: `https://medium.com/@ken/d${i}`, posted_at: isoAgo(500),
        report_url: url, title: `India Hospital Market Report ${i}` });
      addIndexation(url, 'not_indexed');
      body += `\n\nParagraph ${i}: the india hospital market report ${i} reviews hospital capacity, ` +
        'bed density and private investment across the country during the period under review.';
    }
    const limits: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS, maxNewLinksPerSourcePage: 2, maxLinksAddedPerRun: 50 };
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(body), now: NOW, limits }));
    assert.equal(res.created, 2);
    assert.ok(res.skipped.source_cap >= 1);
  });

  test('maxNewLinksPerSourcePage counts proposals from EARLIER runs too', async () => {
    seedBasic();
    insertProposal(db, {
      sourceUrl: SRC_URL, sourcePlatform: 'hackmd', destinationUrl: 'https://www.kenresearch.com/r/pre',
      anchorText: 'pre-existing', paragraph: 'p', relevance: 1,
    }, isoAgo(100));
    const limits: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS, maxNewLinksPerSourcePage: 1 };
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW, limits }));
    assert.equal(res.created, 0);
    assert.equal(res.skipped.source_cap, 1);
  });

  test('maxLinksAddedPerRun caps the whole run', async () => {
    let body = BODY;
    for (let i = 0; i < 4; i++) {
      const src = `https://hackmd.io/@ken/src-${i}`;
      addPost({ platform: 'hackmd', published_url: src, posted_at: isoAgo(500),
        report_url: `https://www.kenresearch.com/industry-reports/src-report-${i}` });
    }
    addPost({ platform: 'medium', published_url: 'https://medium.com/@ken/dest', posted_at: isoAgo(500),
      report_url: DEST_URL, title: DEST_TITLE });
    addIndexation(DEST_URL, 'not_indexed');
    const limits: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS, maxLinksAddedPerRun: 2 };
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(body), now: NOW, limits }));
    assert.equal(res.created, 2);
  });

  test('the explicit limit argument can only tighten maxLinksAddedPerRun', async () => {
    for (let i = 0; i < 4; i++) {
      addPost({ platform: 'hackmd', published_url: `https://hackmd.io/@ken/src-${i}`, posted_at: isoAgo(500),
        report_url: `https://www.kenresearch.com/industry-reports/src-report-${i}` });
    }
    addPost({ platform: 'medium', published_url: 'https://medium.com/@ken/dest', posted_at: isoAgo(500),
      report_url: DEST_URL, title: DEST_TITLE });
    addIndexation(DEST_URL, 'not_indexed');

    const tight = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW, limit: 1 }));
    assert.equal(tight.created, 1);

    const limits: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS, maxLinksAddedPerRun: 1 };
    const loose = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW, limit: 999, limits }));
    assert.ok(loose.created <= 1, 'limit argument must not exceed maxLinksAddedPerRun');
  });

  test('REGRESSION: a junk limit or junk limits object never removes the cap', async () => {
    // Was: Math.min(NaN, n) -> NaN and every `created >= NaN` is false, so a
    // mistyped --limit, or a limits object that had been through JSON, silently
    // turned the per-run cap off entirely.
    seedBasic();
    for (const junk of [NaN, Infinity, -Infinity]) {
      const r = await withProposalFlags(() =>
        generateProposals({ db, fetchSourceText: feed(BODY), now: NOW, limit: junk as any }));
      assert.ok(Number.isFinite(r.created), `limit=${String(junk)} produced ${r.created}`);
      assert.ok(r.created <= DEFAULT_INTERLINK_LIMITS.maxLinksAddedPerRun,
        `limit=${String(junk)} exceeded the configured cap`);
    }
    const r2 = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW,
        limits: { maxLinksAddedPerRun: 'none' } as any }));
    assert.ok(r2.created <= DEFAULT_INTERLINK_LIMITS.maxLinksAddedPerRun);
    assert.ok(Number.isFinite(r2.limits.maxLinksAddedPerRun),
      'the limits reported back must be the sanitised ones actually applied');
  });

  test('maxLinksPerDestinationPerWeek is enforced from existing rows', async () => {
    seedBasic();
    for (let i = 0; i < 5; i++) {
      insertProposal(db, {
        sourceUrl: `https://hackmd.io/@ken/other-${i}`, destinationUrl: DEST_URL,
        anchorText: `anchor ${i}`, paragraph: 'p', relevance: 1,
      }, isoAgo(24));
    }
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.equal(res.created, 0);
    assert.equal(res.skipped.destination_week_cap, 1);
  });

  test('proposals older than a week do not count towards the weekly destination cap', async () => {
    seedBasic();
    for (let i = 0; i < 5; i++) {
      insertProposal(db, {
        sourceUrl: `https://hackmd.io/@ken/other-${i}`, destinationUrl: DEST_URL,
        anchorText: `anchor ${i}`, paragraph: 'p', relevance: 1,
      }, isoAgo(24 * 30));
    }
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.equal(res.created, 1);
  });

  test('cooldownHours skips a page edited too recently', async () => {
    addPost({ platform: 'hackmd', published_url: SRC_URL, posted_at: isoAgo(2),
      report_url: 'https://www.kenresearch.com/industry-reports/other' });
    addPost({ platform: 'medium', published_url: 'https://medium.com/@ken/dest', posted_at: isoAgo(500),
      report_url: DEST_URL, title: DEST_TITLE });
    addIndexation(DEST_URL, 'not_indexed');
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.equal(res.created, 0);
    assert.equal(res.skipped.cooldown, 1);
  });

  test('cooldownHours allows a page last edited long enough ago', async () => {
    seedBasic();
    const limits: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS, cooldownHours: 1 };
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW, limits }));
    assert.equal(res.created, 1);
  });

  test('an applied interlink restarts the cooldown', async () => {
    seedBasic();
    const id = insertProposal(db, {
      sourceUrl: SRC_URL, destinationUrl: 'https://www.kenresearch.com/r/pre',
      anchorText: 'pre', paragraph: 'p', relevance: 1,
    }, isoAgo(100));
    db.prepare(`UPDATE interlink_proposals SET status='applied', applied_at=? WHERE id=?`).run(isoAgo(1), id!);
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.equal(res.created, 0);
    assert.equal(res.skipped.cooldown, 1);
  });

  test('the fetcher may be async', async () => {
    seedBasic();
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: async () => BODY, now: NOW }));
    assert.equal(res.created, 1);
  });

  test('result carries the limits that were actually applied', async () => {
    seedBasic();
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.deepEqual(res.limits, DEFAULT_INTERLINK_LIMITS);
  });
});

describe('formatProposalRun', () => {
  test('states plainly that nothing is applied automatically', async () => {
    seedBasic();
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    const out = formatProposalRun(res);
    assert.ok(out.includes('NOTHING is applied automatically'));
    assert.ok(out.includes(DEST_URL));
  });

  test('handles an empty run', () => {
    const out = formatProposalRun({ created: 0, considered: 0, skipped: {}, proposals: [], limits: DEFAULT_INTERLINK_LIMITS });
    assert.ok(out.includes('0 created'));
  });
});

// ── 7. adversarial regressions ───────────────────────────────────────────────
//
// Each test here corresponds to a defect that was actually present and is now
// fixed. They are written as "the unsafe thing must not happen", not as "the
// current code does X", so they keep their meaning if the implementation moves.

describe('adversarial regressions', () => {
  test('an unrecognised indexation status is read as unknown, never as indexed', () => {
    // The dangerous direction: an unrecognised status falling through to the
    // "indexed" branch means a page we know nothing about is recorded as
    // already strong, and (at a good position) dropped from consideration
    // entirely. Absence of evidence must never read as evidence.
    const unknownGap = destinationGap('unknown', 5);
    for (const junk of ['soft_404', '', 'NOT_INDEXED', 'Indexed', null, undefined, 7]) {
      assert.equal(destinationGap(junk as any, 5), unknownGap,
        `destinationGap(${JSON.stringify(junk)}) should match the 'unknown' gap`);
    }
    // And the real statuses are untouched.
    assert.equal(destinationGap('not_indexed', 5), 1);
    assert.equal(destinationGap('indexed', 5), 0);
    assert.ok(destinationGap('unknown', 5) < destinationGap('not_indexed', 5),
      'an unknown must never outrank a confirmed gap');
  });

  test('normaliseIndexation coerces anything unrecognised to unknown', () => {
    assert.equal(normaliseIndexation('indexed'), 'indexed');
    assert.equal(normaliseIndexation('not_indexed'), 'not_indexed');
    assert.equal(normaliseIndexation('unknown'), 'unknown');
    for (const junk of [null, undefined, '', 'NOT_INDEXED', 'soft_404', 0, {}]) {
      assert.equal(normaliseIndexation(junk), 'unknown');
    }
  });

  test('a page is never proposed a link to itself', async () => {
    // Reachable whenever one row's published_url coincides with another row's
    // report_url. Comparing the destination only against the source's own
    // report_url misses it, and the result is a page linking to itself.
    const SELF = 'https://www.kenresearch.com/industry-reports/india-hospital-market-outlook-2030';
    addPost({ platform: 'hackmd', published_url: SELF, posted_at: isoAgo(500),
      report_url: 'https://www.kenresearch.com/industry-reports/some-other-report',
      title: DEST_TITLE });
    addPost({ platform: 'medium', published_url: 'https://medium.com/@ken/dest',
      posted_at: isoAgo(500), report_url: SELF, title: DEST_TITLE });
    addIndexation(SELF, 'not_indexed');

    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));

    for (const p of res.proposals) {
      assert.notEqual(linkKey(p.destinationUrl), linkKey(p.sourceUrl),
        `proposal #${p.id} links ${p.sourceUrl} to itself`);
    }
    assert.ok((res.skipped.self_link ?? 0) > 0, 'the self-link should have been counted as skipped');
  });

  test('every generated proposal can actually be applied by the applier', async () => {
    // A 'descriptive' anchor is derived from the destination title and does not
    // occur in the paragraph, so the applier can only ever refuse it. Such a
    // proposal would sit in the approval queue as a guaranteed no-op.
    seedBasic();
    const res = await withProposalFlags(() =>
      generateProposals({ db, fetchSourceText: feed(BODY), now: NOW }));
    assert.ok(res.created > 0, 'this fixture should produce at least one proposal');
    for (const p of res.proposals) {
      assert.equal(p.anchorStrategy, 'verbatim',
        `proposal #${p.id} has a ${p.anchorStrategy} anchor, which no applier can insert`);
      assert.ok(BODY.toLowerCase().includes(p.anchorText.toLowerCase()),
        `anchor "${p.anchorText}" does not occur in the source text`);
    }
  });

  test('a stored proposal always contains its own anchor', async () => {
    seedBasic();
    await withProposalFlags(() => generateProposals({
      db,
      // Relevant enough to clear minRelevanceToPropose through stem and bigram
      // overlap, but the destination title phrase itself never appears.
      fetchSourceText: feed(
        'Hospitals across India reported outlook figures for 2030 that place the market ' +
        'for hospital care and India wide outlook spending well above earlier estimates ' +
        'made for this market by analysts covering 2030 and the years immediately after.'),
      now: NOW,
    }));
    const stored = db.prepare(
      'SELECT anchor_text, paragraph_excerpt FROM interlink_proposals').all() as any[];
    for (const row of stored) {
      assert.ok(String(row.paragraph_excerpt).toLowerCase().includes(String(row.anchor_text).toLowerCase()),
        `stored proposal anchor "${row.anchor_text}" is not present in its own paragraph`);
    }
  });

  test('a non-finite --limit cannot remove the per-run cap', async () => {
    // Math.min(NaN, cap) is NaN, and `n >= NaN` is always false — a cap that
    // silently stops existing.
    for (let i = 0; i < 25; i++) {
      addPost({ platform: 'hackmd', published_url: `https://hackmd.io/@ken/bulk-${i}`,
        posted_at: isoAgo(500), report_url: `https://www.kenresearch.com/industry-reports/r-${i}`,
        title: `India Hospital Market Outlook 2030 number ${i}` });
      addIndexation(`https://www.kenresearch.com/industry-reports/r-${i}`, 'not_indexed');
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      db.prepare('DELETE FROM interlink_proposals').run();
      const res = await withProposalFlags(() => generateProposals({
        db, limit: bad as any, fetchSourceText: feed(BODY), now: NOW,
      }));
      assert.ok(res.created <= DEFAULT_INTERLINK_LIMITS.maxLinksAddedPerRun,
        `limit=${String(bad)} produced ${res.created} proposals, above the cap`);
    }
  });

  test('a caller-supplied limits object is sanitised, not trusted', async () => {
    for (let i = 0; i < 25; i++) {
      addPost({ platform: 'hackmd', published_url: `https://hackmd.io/@ken/bulk-${i}`,
        posted_at: isoAgo(500), report_url: `https://www.kenresearch.com/industry-reports/r-${i}`,
        title: `India Hospital Market Outlook 2030 number ${i}` });
      addIndexation(`https://www.kenresearch.com/industry-reports/r-${i}`, 'not_indexed');
    }
    const poisoned = {
      maxNewLinksPerSourcePage: Number.NaN,
      maxLinksAddedPerRun: Number.NaN,
      maxLinksPerDestinationPerWeek: Number.NaN,
      minRelevanceToPropose: Number.NaN,
      minParagraphWords: Number.NaN,
      cooldownHours: Number.NaN,
    } as unknown as InterlinkLimits;
    const res = await withProposalFlags(() => generateProposals({
      db, fetchSourceText: feed(BODY), now: NOW, limits: poisoned,
    }));
    assert.ok(res.created <= DEFAULT_INTERLINK_LIMITS.maxLinksAddedPerRun);
    for (const [k, v] of Object.entries(res.limits)) {
      assert.ok(Number.isFinite(v), `limit ${k} survived as ${v}`);
    }
  });
});

describe('tagDestinationUrl', () => {
  test('tags a bare kenresearch.com URL with the source platform UTM', () => {
    const out = tagDestinationUrl('https://www.kenresearch.com/industry-reports/r-1', 'HackMD');
    assert.equal(out, 'https://www.kenresearch.com/industry-reports/r-1?utm_source=hackmd&utm_medium=referral&utm_campaign=automation');
  });

  test('is idempotent: re-tagging an already-tagged URL does not duplicate params', () => {
    const once = tagDestinationUrl('https://www.kenresearch.com/industry-reports/r-1', 'Mataroa');
    const twice = tagDestinationUrl(once, 'Mataroa');
    assert.equal(once, twice);
  });

  test('strips a DIFFERENT existing utm_source rather than appending a second one', () => {
    const out = tagDestinationUrl(
      'https://www.kenresearch.com/industry-reports/r-1?utm_source=wrong&utm_medium=x',
      'hackmd',
    );
    const params = new URL(out).searchParams;
    assert.equal(params.get('utm_source'), 'hackmd');
    assert.equal(params.get('utm_medium'), 'referral');
    assert.equal(params.get('utm_campaign'), 'automation');
    assert.equal([...params.keys()].filter(k => k === 'utm_source').length, 1);
  });

  test('preserves a non-UTM query param and the fragment', () => {
    const out = tagDestinationUrl('https://www.kenresearch.com/industry-reports/r-1?ref=foo#section', 'hackmd');
    assert.equal(out, 'https://www.kenresearch.com/industry-reports/r-1?ref=foo&utm_source=hackmd&utm_medium=referral&utm_campaign=automation#section');
  });

  test('leaves the URL untouched for an unrecognised platform rather than guessing', () => {
    const url = 'https://www.kenresearch.com/industry-reports/r-1';
    assert.equal(tagDestinationUrl(url, 'totally-unknown-platform'), url);
  });
});
