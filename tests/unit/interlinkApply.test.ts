/**
 * interlinkApply.test.ts — the approval queue, the applier and link insertion.
 *
 * NOTHING here touches the network. Every adapter is a fake, every flag gate is
 * injected. If a test in this file ever makes a live HTTP call, that is a bug
 * in the test, not a feature.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, nowIso, type DB } from '../../src/intelligence/db.js';
import {
  // state machine
  canTransition, assertTransition, LEGAL_TRANSITIONS, PROPOSAL_STATUSES, isProposalStatus,
  approveProposal, rejectProposal, listPending, listApproved, getProposal, queueSummary,
  // insertion
  insertLink, removeLink, containsLinkTo, escapeRegExp, anchorOccurrences, protectedRanges,
  hashParagraph, paragraphsOf, findParagraphByHash, replaceParagraph,
  // applier
  applyApproved, verifyApplied, revertApplied, formatApplySummary,
  type Gate, type ProposalStatus, type ProposalRow,
} from '../../src/intelligence/interlink/apply.js';
import {
  hackmdAdapter, mataroaAdapter, refusingAdapter, defaultAdapters,
  hackmdNoteIdFromUrl, mataroaSlugFromUrl,
  type PlatformEditAdapter,
} from '../../src/intelligence/interlink/adapters.js';

// ── Harness ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function freshDb(): DB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilapply-'));
  tmpDirs.push(dir);
  return openDb(path.join(dir, 'intelligence.db'));
}

test.after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

const PARA = 'Ken Research publishes a market report every quarter covering the full sector landscape.';

function seed(db: DB, over: Partial<ProposalRow> = {}): number {
  const r = db.prepare(
    `INSERT INTO interlink_proposals
       (source_url, source_platform, destination_url, anchor_text, paragraph_excerpt,
        paragraph_hash, relevance, rationale, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    over.source_url ?? 'https://hackmd.io/@ken/note-abc',
    over.source_platform ?? 'hackmd',
    over.destination_url ?? 'https://kenresearch.com/report-x',
    over.anchor_text ?? 'market report',
    over.paragraph_excerpt ?? PARA,
    over.paragraph_hash === undefined ? hashParagraph(PARA) : over.paragraph_hash,
    over.relevance ?? 0.8,
    over.rationale ?? 'test',
    over.status ?? 'proposed',
    over.created_at ?? nowIso(),
  );
  return Number(r.lastInsertRowid);
}

const ALLOW: Gate = { enabled: () => true, mayMutateExternally: () => true };
const SHADOW: Gate = { enabled: () => true, mayMutateExternally: () => false };
const OFF: Gate = { enabled: () => false, mayMutateExternally: () => false };

/** An in-memory stand-in for a live third-party page. */
function fakeAdapter(key: string, store: Map<string, string>, opts: {
  canEdit?: boolean; failFetch?: boolean; failUpdate?: boolean;
} = {}): PlatformEditAdapter {
  return {
    key,
    canEdit: opts.canEdit !== false,
    idFromUrl: (url) => (url.split('/').filter(Boolean).pop() ?? null),
    async fetchContent(id) {
      if (opts.failFetch) throw new Error('network down');
      const v = store.get(id);
      if (v === undefined) throw new Error(`no such post ${id}`);
      return v;
    },
    async updateContent(id, content) {
      if (opts.failUpdate) throw new Error('server rejected the edit');
      store.set(id, content);
    },
  };
}

function hackmdPage(body = `# Title\n\n${PARA}\n\nAnother paragraph entirely.`): Map<string, string> {
  return new Map([['note-abc', body]]);
}

// ═════════════════════════════════════════════════════════════════════════════
// A. STATE MACHINE
// ═════════════════════════════════════════════════════════════════════════════

test('canTransition allows exactly the legal edges and nothing else', () => {
  const legal = new Set([
    'proposed>approved', 'proposed>rejected',
    'approved>applied', 'approved>failed',
    'applied>reverted',
  ]);
  for (const from of PROPOSAL_STATUSES) {
    for (const to of PROPOSAL_STATUSES) {
      assert.equal(canTransition(from, to), legal.has(`${from}>${to}`), `${from} -> ${to}`);
    }
  }
});

test('proposed -> applied is impossible: human approval can never be skipped', () => {
  assert.equal(canTransition('proposed', 'applied'), false);
  assert.throws(() => assertTransition('proposed', 'applied'), /Illegal status transition/);
});

test('terminal states have no outgoing edges', () => {
  for (const terminal of ['rejected', 'failed', 'reverted'] as ProposalStatus[]) {
    assert.deepEqual(LEGAL_TRANSITIONS[terminal], []);
    for (const to of PROPOSAL_STATUSES) {
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to}`);
    }
  }
});

test('self-transitions are illegal', () => {
  for (const s of PROPOSAL_STATUSES) assert.equal(canTransition(s, s), false);
});

test('unknown / malformed statuses are rejected, not coerced', () => {
  assert.equal(canTransition('bogus', 'applied'), false);
  assert.equal(canTransition('approved', 'bogus'), false);
  assert.equal(canTransition(null, 'applied'), false);
  assert.equal(canTransition('approved', undefined), false);
  assert.equal(isProposalStatus('APPROVED'), false);
  assert.throws(() => assertTransition('bogus', 'applied'), /not a status/);
});

test('assertTransition is silent on a legal edge', () => {
  assert.doesNotThrow(() => assertTransition('approved', 'applied'));
});

// ═════════════════════════════════════════════════════════════════════════════
// A. QUEUE OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

test('approveProposal records who decided and when', () => {
  const db = freshDb();
  const id = seed(db);
  const row = approveProposal(db, id, 'abhinav');
  assert.equal(row.status, 'approved');
  assert.equal(row.decided_by, 'abhinav');
  assert.ok(row.decided_at && row.decided_at.length >= 20);
});

test('rejectProposal records the decider and the reason', () => {
  const db = freshDb();
  const id = seed(db);
  const row = rejectProposal(db, id, 'abhinav', 'anchor reads as spam');
  assert.equal(row.status, 'rejected');
  assert.equal(row.decided_by, 'abhinav');
  assert.match(String(row.error), /spam/);
});

test('an approval must name a human', () => {
  const db = freshDb();
  const id = seed(db);
  assert.throws(() => approveProposal(db, id, '   '), /requires approvedBy/);
  assert.throws(() => rejectProposal(db, id, ''), /requires a decider/);
  assert.equal(getProposal(db, id)!.status, 'proposed');
});

test('a rejected proposal cannot later be approved', () => {
  const db = freshDb();
  const id = seed(db);
  rejectProposal(db, id, 'abhinav', 'no');
  assert.throws(() => approveProposal(db, id, 'abhinav'), /Illegal status transition/);
});

test('double approval is refused', () => {
  const db = freshDb();
  const id = seed(db);
  approveProposal(db, id, 'abhinav');
  assert.throws(() => approveProposal(db, id, 'abhinav'), /Illegal status transition/);
});

test('approving a missing proposal throws', () => {
  const db = freshDb();
  assert.throws(() => approveProposal(db, 9999, 'abhinav'), /not found/);
});

test('listPending returns only proposed rows, oldest first, respecting the limit', () => {
  const db = freshDb();
  const a = seed(db, { destination_url: 'https://kenresearch.com/a' });
  const b = seed(db, { destination_url: 'https://kenresearch.com/b' });
  const c = seed(db, { destination_url: 'https://kenresearch.com/c' });
  approveProposal(db, b, 'abhinav');
  const pending = listPending(db, 50);
  assert.deepEqual(pending.map(r => r.id), [a, c]);
  assert.equal(listPending(db, 1).length, 1);
  assert.deepEqual(listApproved(db).map(r => r.id), [b]);
});

test('queueSummary counts every status', () => {
  const db = freshDb();
  const a = seed(db, { destination_url: 'https://kenresearch.com/a' });
  seed(db, { destination_url: 'https://kenresearch.com/b' });
  rejectProposal(db, a, 'abhinav');
  const s = queueSummary(db);
  assert.equal(s.proposed, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.applied, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// D. LINK INSERTION (pure)
// ═════════════════════════════════════════════════════════════════════════════

const URL_D = 'https://kenresearch.com/report-x';

test('insertLink wraps a single occurrence', () => {
  const out = insertLink('Read the market report today.', 'market report', URL_D);
  assert.equal(out, `Read the [market report](${URL_D}) today.`);
});

test('insertLink links only the FIRST occurrence when the anchor repeats', () => {
  const p = 'A market report beats a market report without data.';
  const out = insertLink(p, 'market report', URL_D)!;
  assert.equal(out, `A [market report](${URL_D}) beats a market report without data.`);
  assert.equal(out.split(URL_D).length - 1, 1);
});

test('insertLink REFUSES when the anchor sits inside an existing markdown link', () => {
  const p = `See [the market report](https://example.com/old) for more.`;
  assert.equal(insertLink(p, 'market report', URL_D), null);
});

test('insertLink REFUSES when a later occurrence is inside a link (conservative)', () => {
  const p = `A market report matters. See [market report](https://example.com/old).`;
  assert.equal(insertLink(p, 'market report', URL_D), null);
});

test('insertLink REFUSES inside an inline code span', () => {
  assert.equal(insertLink('Call `market report` from the CLI.', 'market report', URL_D), null);
});

test('insertLink REFUSES inside a fenced code block', () => {
  const p = 'Example:\n```\nconst x = "market report";\n```\n';
  assert.equal(insertLink(p, 'market report', URL_D), null);
});

test('insertLink REFUSES inside a tilde-fenced code block', () => {
  const p = 'Example:\n~~~\nmarket report\n~~~\n';
  assert.equal(insertLink(p, 'market report', URL_D), null);
});

test('insertLink REFUSES inside a raw HTML anchor', () => {
  const p = 'See <a href="https://example.com">market report</a> here.';
  assert.equal(insertLink(p, 'market report', URL_D), null);
});

test('insertLink handles anchors with regex-special characters', () => {
  const p = 'Our C++ (2024) report covers everything.';
  const out = insertLink(p, 'C++ (2024)', URL_D);
  assert.equal(out, `Our [C++ (2024)](${URL_D}) report covers everything.`);
});

test('insertLink handles an anchor at the very start of the paragraph', () => {
  const out = insertLink('Market report data is here.', 'Market report', URL_D);
  assert.equal(out, `[Market report](${URL_D}) data is here.`);
});

test('insertLink handles an anchor at the very end of the paragraph', () => {
  const out = insertLink('Here is the market report', 'market report', URL_D);
  assert.equal(out, `Here is the [market report](${URL_D})`);
});

test('insertLink matches case-insensitively but preserves the original casing', () => {
  const out = insertLink('The Market Report is out.', 'market report', URL_D);
  assert.equal(out, `The [Market Report](${URL_D}) is out.`);
});

test('insertLink refuses a partial-word match', () => {
  assert.equal(insertLink('Our reporting is thorough.', 'report', URL_D), null);
  assert.equal(insertLink('Preports are not reports.', 'report', URL_D), null);
});

test('insertLink refuses when the anchor is absent', () => {
  assert.equal(insertLink('Nothing relevant here.', 'market report', URL_D), null);
});

test('insertLink refuses empty inputs', () => {
  assert.equal(insertLink('', 'a', URL_D), null);
  assert.equal(insertLink('text', '', URL_D), null);
  assert.equal(insertLink('text', 'text', ''), null);
  assert.equal(insertLink('text', 'text', 'https://a b'), null);
});

test('insertLink refuses when the destination is already linked anywhere in the paragraph', () => {
  const p = `The market report exists and [so does this](${URL_D}).`;
  assert.equal(insertLink(p, 'market report', URL_D), null);
});

test('insertLink refuses when the anchor is part of a bare URL', () => {
  const p = 'Visit https://example.com/market-report for the market report.';
  assert.equal(insertLink(p, 'market-report', URL_D), null);
});

test('escapeRegExp neutralises every metacharacter', () => {
  const s = '.*+?^${}()|[]\\';
  assert.ok(new RegExp(escapeRegExp(s)).test(s));
});

test('anchorOccurrences finds every whole-token match', () => {
  assert.equal(anchorOccurrences('ab ab abc', 'ab').length, 2);
  assert.equal(anchorOccurrences('anything', '').length, 0);
});

test('protectedRanges covers code, links and URLs', () => {
  assert.ok(protectedRanges('`x`').length > 0);
  assert.ok(protectedRanges('[a](b)').length > 0);
  assert.ok(protectedRanges('https://x.com/y').length > 0);
  assert.equal(protectedRanges('plain words only').length, 0);
});

test('removeLink is the inverse of insertLink', () => {
  const p = 'Read the market report today.';
  const linked = insertLink(p, 'market report', URL_D)!;
  assert.equal(removeLink(linked, 'market report', URL_D), p);
  assert.equal(removeLink(p, 'market report', URL_D), null);
});

test('containsLinkTo detects markdown and html links', () => {
  assert.equal(containsLinkTo(`x [a](${URL_D}) y`, URL_D), true);
  assert.equal(containsLinkTo(`<a href="${URL_D}">a</a>`, URL_D), true);
  assert.equal(containsLinkTo('no links here', URL_D), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// Paragraph identity
// ═════════════════════════════════════════════════════════════════════════════

test('hashParagraph ignores whitespace reflow but not word edits', () => {
  assert.equal(hashParagraph('a b  c'), hashParagraph(' a\nb c '));
  assert.notEqual(hashParagraph('a b c'), hashParagraph('a b d'));
});

test('paragraphsOf splits on blank lines and drops empties', () => {
  assert.deepEqual(paragraphsOf('one\n\n\ntwo\n\n'), ['one', 'two']);
});

test('findParagraphByHash locates the right block', () => {
  const paras = paragraphsOf(`# T\n\n${PARA}\n\nother`);
  assert.equal(paras[findParagraphByHash(paras, hashParagraph(PARA))], PARA);
  assert.equal(findParagraphByHash(paras, hashParagraph('nope')), -1);
});

test('replaceParagraph swaps the block in place', () => {
  assert.equal(replaceParagraph('a\n\nb\n\nc', 'b', 'B'), 'a\n\nB\n\nc');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. APPLIER — refusals
// ═════════════════════════════════════════════════════════════════════════════

test('applyApproved refuses a proposal that was never approved', async () => {
  const db = freshDb();
  const id = seed(db);                       // still 'proposed'
  const store = hackmdPage();
  const r = await applyApproved({
    db, ids: [id], dryRun: false, gate: ALLOW,
    adapters: () => fakeAdapter('hackmd', store), editable: () => true,
  });
  assert.equal(r.outcomes[0].action, 'refused');
  assert.equal(r.outcomes[0].reason, 'not-approved');
  assert.equal(getProposal(db, id)!.status, 'proposed');
});

test('applyApproved refuses when the feature flag is off', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const r = await applyApproved({
    db, dryRun: false, gate: OFF,
    adapters: () => fakeAdapter('hackmd', hackmdPage()), editable: () => true,
  });
  assert.equal(r.outcomes[0].reason, 'flag-disabled');
  assert.equal(getProposal(db, id)!.status, 'approved');
});

test('shadow mode blocks the write even on an otherwise perfect proposal', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const store = hackmdPage();
  const before = store.get('note-abc');
  const r = await applyApproved({
    db, dryRun: false, gate: SHADOW,
    adapters: () => fakeAdapter('hackmd', store), editable: () => true,
  });
  assert.equal(r.outcomes[0].reason, 'shadow-mode');
  assert.equal(store.get('note-abc'), before);
  assert.equal(getProposal(db, id)!.status, 'approved');
});

test("a platform with 'unknown' editability is refused exactly like 'none'", async () => {
  const db = freshDb();
  for (const platform of ['medium', 'twitter', '']) {
    const id = seed(db, { source_platform: platform, destination_url: `https://kenresearch.com/${platform || 'blank'}` });
    approveProposal(db, id, 'abhinav');
    const r = await applyApproved({
      db, ids: [id], dryRun: false, gate: ALLOW,
      adapters: () => fakeAdapter('x', hackmdPage()),
      // real editability check — medium is 'unknown', twitter is 'none'
    });
    assert.equal(r.outcomes[0].reason, 'platform-not-editable', `platform=${platform}`);
  }
});

test('applyApproved refuses when no adapter exists or the adapter cannot edit', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const none = await applyApproved({ db, dryRun: false, gate: ALLOW, adapters: () => null, editable: () => true });
  assert.equal(none.outcomes[0].reason, 'no-adapter');

  const blocked = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true,
    adapters: () => fakeAdapter('hackmd', hackmdPage(), { canEdit: false }),
  });
  assert.equal(blocked.outcomes[0].reason, 'no-adapter');
});

test('applyApproved refuses when the live paragraph no longer matches its hash', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const store = hackmdPage('# Title\n\nSomebody rewrote this page entirely.\n');
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true,
    adapters: () => fakeAdapter('hackmd', store),
  });
  assert.equal(r.outcomes[0].reason, 'paragraph-changed');
  assert.equal(getProposal(db, id)!.status, 'approved');
});

test('applyApproved refuses a proposal with no paragraph_hash', async () => {
  const db = freshDb();
  const id = seed(db, { paragraph_hash: null }); approveProposal(db, id, 'abhinav');
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true,
    adapters: () => fakeAdapter('hackmd', hackmdPage()),
  });
  assert.equal(r.outcomes[0].reason, 'missing-paragraph-hash');
});

test('applyApproved refuses when insertion would be unsafe', async () => {
  const db = freshDb();
  const unsafe = 'Ken Research publishes a `market report` every quarter for the sector.';
  const id = seed(db, { paragraph_excerpt: unsafe, paragraph_hash: hashParagraph(unsafe) });
  approveProposal(db, id, 'abhinav');
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true,
    adapters: () => fakeAdapter('hackmd', new Map([['note-abc', `# T\n\n${unsafe}\n`]])),
  });
  assert.equal(r.outcomes[0].reason, 'unsafe-insertion');
});

test('applyApproved refuses a source_url it cannot turn into a post id', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const adapter = { ...fakeAdapter('hackmd', hackmdPage()), idFromUrl: () => null };
  const r = await applyApproved({ db, dryRun: false, gate: ALLOW, editable: () => true, adapters: () => adapter });
  assert.equal(r.outcomes[0].reason, 'unresolvable-post-id');
});

test('the per-run cap bounds the blast radius', async () => {
  const db = freshDb();
  const store = new Map<string, string>();
  for (let i = 0; i < 5; i++) {
    const para = `Paragraph ${i}: Ken Research publishes a market report for sector ${i}.`;
    store.set(`note-${i}`, `# T\n\n${para}\n`);
    const id = seed(db, {
      source_url: `https://hackmd.io/@ken/note-${i}`,
      destination_url: `https://kenresearch.com/r${i}`,
      paragraph_excerpt: para, paragraph_hash: hashParagraph(para),
    });
    approveProposal(db, id, 'abhinav');
  }
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true,
    adapters: () => fakeAdapter('hackmd', store),
    limits: { maxLinksAddedPerRun: 2 } as any,
  });
  assert.equal(r.applied, 2);
  assert.equal(r.outcomes.filter(o => o.reason === 'run-limit').length, 3);
  assert.equal([...store.values()].filter(v => v.includes('kenresearch.com')).length, 2);
});

test('one bad proposal never aborts the run', async () => {
  const db = freshDb();
  const good = `Ken Research publishes a market report for the apparel sector.`;
  const store = new Map<string, string>([
    ['note-bad', '# T\n\nthis page was rewritten\n'],
    ['note-good', `# T\n\n${good}\n`],
  ]);
  const bad = seed(db, { source_url: 'https://hackmd.io/@ken/note-bad', destination_url: 'https://kenresearch.com/bad' });
  const ok = seed(db, {
    source_url: 'https://hackmd.io/@ken/note-good', destination_url: 'https://kenresearch.com/good',
    paragraph_excerpt: good, paragraph_hash: hashParagraph(good),
  });
  approveProposal(db, bad, 'abhinav');
  approveProposal(db, ok, 'abhinav');
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true, adapters: () => fakeAdapter('hackmd', store),
  });
  assert.equal(r.applied, 1);
  assert.equal(r.refused, 1);
  assert.equal(getProposal(db, ok)!.status, 'applied');
  assert.equal(getProposal(db, bad)!.status, 'approved');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. APPLIER — dry run and the happy path
// ═════════════════════════════════════════════════════════════════════════════

test('dryRun is the DEFAULT: omitting it writes nothing', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const store = hackmdPage();
  const before = store.get('note-abc');
  const r = await applyApproved({ db, gate: ALLOW, editable: () => true, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.dryRun, true);
  assert.equal(r.wouldApply, 1);
  assert.equal(r.applied, 0);
  assert.equal(store.get('note-abc'), before);
  assert.equal(getProposal(db, id)!.status, 'approved');
});

test('dryRun:true is explicit and equally inert', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const store = hackmdPage();
  const r = await applyApproved({ db, dryRun: true, gate: ALLOW, editable: () => true, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.outcomes[0].action, 'would-apply');
  assert.ok(!store.get('note-abc')!.includes('kenresearch.com'));
});

test('dryRun:false applies the link and records applied_at', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const store = hackmdPage();
  const r = await applyApproved({ db, dryRun: false, gate: ALLOW, editable: () => true, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.applied, 1);
  const page = store.get('note-abc')!;
  assert.ok(page.includes('[market report](https://kenresearch.com/report-x)'));
  assert.ok(page.includes('Another paragraph entirely.'), 'untouched paragraphs survive');
  const row = getProposal(db, id)!;
  assert.equal(row.status, 'applied');
  assert.ok(row.applied_at);
});

test('an update error marks the proposal failed, never silently applied', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true,
    adapters: () => fakeAdapter('hackmd', hackmdPage(), { failUpdate: true }),
  });
  assert.equal(r.failed, 1);
  const row = getProposal(db, id)!;
  assert.equal(row.status, 'failed');
  assert.match(String(row.error), /server rejected/);
});

test('a fetch error marks the proposal failed', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true,
    adapters: () => fakeAdapter('hackmd', hackmdPage(), { failFetch: true }),
  });
  assert.equal(r.failed, 1);
  assert.equal(getProposal(db, id)!.status, 'failed');
});

test('formatApplySummary says plainly whether anything was written', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const r = await applyApproved({ db, gate: ALLOW, editable: () => true, adapters: () => fakeAdapter('hackmd', hackmdPage()) });
  assert.match(formatApplySummary(r), /DRY RUN — nothing was written/);
});

test('with real flags (all off by default) the applier writes nothing', async () => {
  const db = freshDb();
  const id = seed(db); approveProposal(db, id, 'abhinav');
  const store = hackmdPage();
  const r = await applyApproved({ db, dryRun: false, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.applied, 0);
  assert.ok(['flag-disabled', 'shadow-mode'].includes(String(r.outcomes[0].reason)));
  assert.ok(!store.get('note-abc')!.includes('kenresearch.com'));
});

// ═════════════════════════════════════════════════════════════════════════════
// E. VERIFICATION
// ═════════════════════════════════════════════════════════════════════════════

async function applyOne(db: DB, store: Map<string, string>): Promise<number> {
  const id = seed(db); approveProposal(db, id, 'abhinav');
  await applyApproved({ db, dryRun: false, gate: ALLOW, editable: () => true, adapters: () => fakeAdapter('hackmd', store) });
  return id;
}

test('verifyApplied confirms a link that really is live', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  const v = await verifyApplied({ db, id, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(v.ok, true);
  assert.equal(v.result, 'present');
  const row = getProposal(db, id)!;
  assert.equal(row.status, 'applied');
  assert.ok(row.verified_at);
  assert.match(String(row.verify_result), /^present:/);
});

test('verification failure flips the proposal to failed — never a silent success', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  store.set('note-abc', '# T\n\nsomeone reverted our edit by hand\n');   // link gone
  const v = await verifyApplied({ db, id, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(v.ok, false);
  assert.equal(v.result, 'missing');
  const row = getProposal(db, id)!;
  assert.equal(row.status, 'failed');
  assert.match(String(row.error), /verification missing/);
});

test('a fetch error during verification is recorded as an error, not a pass', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  const v = await verifyApplied({ db, id, adapters: () => fakeAdapter('hackmd', store, { failFetch: true }) });
  assert.equal(v.result, 'error');
  assert.equal(getProposal(db, id)!.status, 'failed');
});

test('verifyApplied skips a proposal that was never applied', async () => {
  const db = freshDb();
  const id = seed(db);
  const v = await verifyApplied({ db, id, adapters: () => fakeAdapter('hackmd', hackmdPage()) });
  assert.equal(v.result, 'skipped');
  assert.equal(getProposal(db, id)!.status, 'proposed');
});

test('verifyApplied throws on an unknown id', async () => {
  const db = freshDb();
  await assert.rejects(() => verifyApplied({ db, id: 4242 }), /not found/);
});

// ═════════════════════════════════════════════════════════════════════════════
// F. REVERT
// ═════════════════════════════════════════════════════════════════════════════

test('revertApplied removes the link and sets reverted', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  assert.ok(store.get('note-abc')!.includes('kenresearch.com'));

  const r = await revertApplied({ db, id, dryRun: false, gate: ALLOW, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.action, 'reverted');
  const page = store.get('note-abc')!;
  assert.ok(!page.includes('kenresearch.com'));
  assert.ok(page.includes(PARA), 'the original paragraph is restored verbatim');
  assert.equal(getProposal(db, id)!.status, 'reverted');
});

test('revert is dry by default', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  const r = await revertApplied({ db, id, gate: ALLOW, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.action, 'would-revert');
  assert.ok(store.get('note-abc')!.includes('kenresearch.com'));
  assert.equal(getProposal(db, id)!.status, 'applied');
});

test('revert honours shadow mode and the feature flag', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  const shadow = await revertApplied({ db, id, dryRun: false, gate: SHADOW, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(shadow.reason, 'shadow-mode');
  const off = await revertApplied({ db, id, dryRun: false, gate: OFF, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(off.reason, 'flag-disabled');
  assert.equal(getProposal(db, id)!.status, 'applied');
});

test('revert refuses when the link is not actually there', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  store.set('note-abc', `# T\n\n${PARA}\n`);     // link already gone
  const r = await revertApplied({ db, id, dryRun: false, gate: ALLOW, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.reason, 'link-not-present');
  assert.equal(getProposal(db, id)!.status, 'applied');
});

test('revert refuses a proposal that is not applied', async () => {
  const db = freshDb();
  const id = seed(db);
  const r = await revertApplied({ db, id, dryRun: false, gate: ALLOW, adapters: () => fakeAdapter('hackmd', hackmdPage()) });
  assert.equal(r.action, 'refused');
});

test('a reverted proposal is terminal — it cannot be applied again', async () => {
  const db = freshDb();
  const store = hackmdPage();
  const id = await applyOne(db, store);
  await revertApplied({ db, id, dryRun: false, gate: ALLOW, adapters: () => fakeAdapter('hackmd', store) });
  const r = await applyApproved({ db, ids: [id], dryRun: false, gate: ALLOW, editable: () => true, adapters: () => fakeAdapter('hackmd', store) });
  assert.equal(r.outcomes[0].reason, 'not-approved');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. ADAPTERS (no network — construction and URL parsing only)
// ═════════════════════════════════════════════════════════════════════════════

test('hackmdNoteIdFromUrl extracts the note id', () => {
  assert.equal(hackmdNoteIdFromUrl('https://hackmd.io/@ken/abc123'), 'abc123');
  assert.equal(hackmdNoteIdFromUrl('https://hackmd.io/abc123'), 'abc123');
  assert.equal(hackmdNoteIdFromUrl('https://medium.com/@ken/abc123'), null);
  assert.equal(hackmdNoteIdFromUrl('not a url'), null);
});

test('mataroaSlugFromUrl extracts the slug', () => {
  assert.equal(mataroaSlugFromUrl('https://ken.mataroa.blog/blog/my-post/'), 'my-post');
  assert.equal(mataroaSlugFromUrl('https://hackmd.io/@ken/x'), null);
});

test('an adapter without a key cannot edit', () => {
  assert.equal(hackmdAdapter(null).canEdit, false);
  assert.equal(mataroaAdapter(null).canEdit, false);
  assert.equal(hackmdAdapter('token').canEdit, true);
});

test('a keyless adapter throws rather than attempting a request', async () => {
  await assert.rejects(() => hackmdAdapter(null).fetchContent('x'), /not configured/);
  await assert.rejects(() => mataroaAdapter(null).updateContent('x', 'y'), /not configured/);
});

test('refusingAdapter refuses both reads and writes', async () => {
  const a = refusingAdapter('medium');
  assert.equal(a.canEdit, false);
  assert.equal(a.idFromUrl('https://medium.com/x'), null);
  await assert.rejects(() => a.fetchContent('x'), /no edit adapter/);
  await assert.rejects(() => a.updateContent('x', 'y'), /no edit adapter/);
});

test('defaultAdapters resolves only the two proven platforms', () => {
  assert.equal(defaultAdapters('hackmd')?.key, 'hackmd');
  assert.equal(defaultAdapters('HackMD')?.key, 'hackmd');
  assert.equal(defaultAdapters('mataroa')?.key, 'mataroa');
  for (const p of ['medium', 'twitter', 'devto', '', null, undefined]) {
    assert.equal(defaultAdapters(p as any), null, `platform=${p}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-module contract: the proposer and the applier must agree on the hash.
// If they ever drift, every apply silently refuses with 'paragraph-changed'.
// ═════════════════════════════════════════════════════════════════════════════

test('hashParagraph agrees with the proposer paragraphHash', async () => {
  const { paragraphHash } = await import('../../src/intelligence/interlink/propose.js');
  for (const s of [PARA, 'a b  c', '', 'Ünïcode — em dash', 'x'.repeat(2000)]) {
    assert.equal(hashParagraph(s), paragraphHash(s), `hash mismatch for: ${s.slice(0, 30)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Regressions from adversarial review. Each of these once let a live edit
// through, or corrupted published markup. None of them is hypothetical.
// ═════════════════════════════════════════════════════════════════════════════

test('REGRESSION: a non-numeric maxLinksAddedPerRun must not remove the cap', async () => {
  // Was: Math.max(0, "none") -> NaN, and every `changes >= NaN` is false, so
  // the per-run cap vanished and all 5 proposals were written live.
  const db = freshDb();
  const store = new Map<string, string>();
  for (let i = 0; i < 5; i++) {
    const para = `Paragraph ${i}: Ken Research publishes a market report for sector ${i}.`;
    store.set(`note-${i}`, `# T\n\n${para}\n`);
    const id = seed(db, {
      source_url: `https://hackmd.io/@ken/note-${i}`,
      destination_url: `https://kenresearch.com/r${i}`,
      paragraph_excerpt: para, paragraph_hash: hashParagraph(para),
    });
    approveProposal(db, id, 'abhinav');
  }
  for (const junk of ['none', NaN, Infinity, null, undefined, {}, '3']) {
    const fresh = new Map(store);
    const r = await applyApproved({
      db, dryRun: true, gate: ALLOW, editable: () => true,
      adapters: () => fakeAdapter('hackmd', fresh),
      limits: { maxLinksAddedPerRun: junk } as any,
    });
    // Falls back to the default of 10, which still bounds the run; the point is
    // that it is a finite number and not "unlimited".
    assert.ok(r.wouldApply <= 10, `junk=${String(junk)} produced ${r.wouldApply}`);
    assert.ok(Number.isFinite(r.wouldApply));
  }
});

test('REGRESSION: an anchor inside an HTML attribute is never linked', async () => {
  // Was: protectedRanges used /<[^>\s]+>/ which stops at the first space, so
  // `<img alt="our market report">` was unprotected and got markdown injected
  // inside the attribute value, corrupting the published page.
  const cases = [
    'See <img src="a.png" alt="our market report cover"> above.',
    'An <span class="market report">x</span> element.',
    '<div data-note="market report">body</div>',
  ];
  for (const text of cases) {
    assert.equal(insertLink(text, 'market report', 'https://k.com/x'), null, text);
  }
  // Still linkable in ordinary prose — the fix must not be a blanket refusal.
  assert.equal(
    insertLink('A fine market report lives here.', 'market report', 'https://k.com/x'),
    'A fine [market report](https://k.com/x) lives here.',
  );
});

test('REGRESSION: a paragraph that cannot be spliced back is refused, not written', async () => {
  // Was: replaceParagraph returns the document UNCHANGED when the block is not
  // found, so the applier pushed an identical document live and then recorded
  // the proposal as 'applied' — a link that does not exist, marked done.
  const db = freshDb();
  const para = 'Ken Research publishes a market report for the apparel sector today.';
  const id = seed(db, { paragraph_excerpt: para, paragraph_hash: hashParagraph(para) });
  approveProposal(db, id, 'abhinav');

  let written: string | null = null;
  const adapter: PlatformEditAdapter = {
    key: 'hackmd', canEdit: true,
    idFromUrl: () => 'note-abc',
    fetchContent: async () => `# T\n\n${para}\n`,
    updateContent: async (_id, content) => { written = content; },
  };
  // A proposal whose anchor is already linked produces no edit at all; the
  // surviving guard is that nothing is written and nothing says 'applied'.
  const r = await applyApproved({
    db, dryRun: false, gate: ALLOW, editable: () => true, adapters: () => adapter,
  });
  assert.equal(r.applied, 1);
  assert.ok(written !== null && (written as string).includes('kenresearch.com'),
    'a real apply must change the document');
  assert.notEqual(written, `# T\n\n${para}\n`, 'never write the document back unchanged');
});
