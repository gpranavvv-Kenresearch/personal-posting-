/**
 * apply.ts — the interlink approval queue and applier.
 *
 * ============================================================================
 * THIS IS THE MOST DANGEROUS MODULE IN THE PROJECT.
 * It edits content that is ALREADY PUBLISHED on third-party sites.
 * ============================================================================
 *
 * Every design choice here exists to make an accidental live edit as close to
 * impossible as code can make it:
 *
 *   1. A proposal cannot go straight from 'proposed' to 'applied'. The state
 *      machine has no such edge, and assertTransition() throws. Human approval
 *      is structurally mandatory, not a convention.
 *   2. dryRun defaults to TRUE. Writing requires passing dryRun:false by hand.
 *   3. Three independent gates must all pass: FEATURE_INTERLINKING_APPLY,
 *      NOT shadow mode, and the platform must be proven editable
 *      ('unknown' editability is refused exactly like 'none').
 *   4. The live paragraph must still hash to the hash recorded at proposal
 *      time. If the page changed, we re-propose rather than edit blindly.
 *   5. A per-run cap (maxLinksAddedPerRun) bounds the blast radius.
 *   6. Every applied link is verified by re-fetching the page, and can be
 *      reverted. Rollback is a real capability, not a hope.
 *
 * Refusals are per-proposal and loud: a single bad proposal never aborts the
 * run, and never silently becomes a success.
 */

import { createHash } from 'crypto';
import { nowIso, type DB } from '../db.js';
import { enabled as realEnabled, mayMutateExternally as realMayMutate } from '../flags.js';
import { canApplyInterlinks } from '../platforms.js';
import {
  loadInterlinkLimits,
  sanitiseInterlinkLimits,
  type InterlinkLimits,
} from '../weights.js';
import { defaultAdapters, type AdapterResolver, type PlatformEditAdapter } from './adapters.js';

// ── Status model ─────────────────────────────────────────────────────────────

export type ProposalStatus =
  | 'proposed' | 'approved' | 'rejected' | 'applied' | 'failed' | 'reverted';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] =
  ['proposed', 'approved', 'rejected', 'applied', 'failed', 'reverted'] as const;

/**
 * The ONLY legal transitions. Note what is absent:
 *   - proposed -> applied   (approval can never be skipped)
 *   - rejected -> anything  (a rejection is final; re-propose instead)
 *   - reverted -> anything  (a revert is final; re-propose instead)
 *   - failed   -> applied   (a failure must be re-approved, not retried blind)
 */
export const LEGAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  proposed: ['approved', 'rejected'],
  approved: ['applied', 'failed'],
  applied: ['reverted'],
  rejected: [],
  failed: [],
  reverted: [],
};

export function isProposalStatus(s: unknown): s is ProposalStatus {
  return typeof s === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(s);
}

export function canTransition(from: unknown, to: unknown): boolean {
  if (!isProposalStatus(from) || !isProposalStatus(to)) return false;
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: unknown, to: unknown): void {
  if (canTransition(from, to)) return;
  throw new Error(
    `[interlink] Illegal status transition "${String(from)}" -> "${String(to)}". ` +
    `Legal from "${String(from)}": ` +
    `${isProposalStatus(from) ? (LEGAL_TRANSITIONS[from].join(', ') || '(none — terminal state)') : '(not a status)'}.`
  );
}

// ── Row shape ────────────────────────────────────────────────────────────────

export interface ProposalRow {
  id: number;
  source_url: string;
  source_platform: string | null;
  destination_url: string;
  anchor_text: string;
  paragraph_excerpt: string | null;
  paragraph_hash: string | null;
  relevance: number | null;
  rationale: string | null;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  applied_at: string | null;
  verified_at: string | null;
  verify_result: string | null;
  error: string | null;
}

export function getProposal(db: DB, id: number): ProposalRow | null {
  return (db.prepare('SELECT * FROM interlink_proposals WHERE id = ?').get(id) as unknown as ProposalRow) ?? null;
}

// ── Paragraph hashing ────────────────────────────────────────────────────────

/**
 * Hash of a paragraph's MEANINGFUL text. Whitespace is normalised so that a
 * reflowed line does not count as "the page changed", but any word-level edit
 * does. Shared by the proposer and the applier — if these ever disagree the
 * applier refuses, which is the safe direction.
 */
export function hashParagraph(paragraph: string): string {
  const normalised = String(paragraph ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 32);
}

/** Split a markdown document into paragraph blocks (blank-line separated). */
/**
 * Split into paragraphs on blank lines, but NEVER inside a fenced code block.
 *
 * A naive blank-line split tears a fence apart, and the fragment after the
 * blank line no longer carries its opening ``` marker. Every downstream
 * "is this code?" check then says no, and a link could be inserted into
 * published source code. Keeping a fence whole is the only correct fix.
 */
function splitOnBlankLinesRespectingFences(text: string): string[] {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const joined = buf.join('\n');
    if (joined.trim().length > 0) out.push(joined);
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (fence === null) {
        flush();
        fence = m[1][0];
        buf.push(line);
        continue;
      }
      if (m[1][0] === fence) {
        buf.push(line);
        fence = null;
        flush();
        continue;
      }
    }
    if (fence === null && line.trim() === '') { flush(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

export function paragraphsOf(content: string): string[] {
  return splitOnBlankLinesRespectingFences(content).map(p => p.replace(/\s+$/, ''));
}

/** Index of the paragraph whose hash matches, or -1. */
export function findParagraphByHash(paragraphs: string[], hash: string): number {
  return paragraphs.findIndex(p => hashParagraph(p) === hash);
}

// ── D. Link insertion (PURE) ─────────────────────────────────────────────────

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Character ranges that must never be touched: fenced code, inline code,
 * existing markdown links and images, reference links, raw <a> elements,
 * autolinks and bare URLs.
 */
export function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns: RegExp[] = [
    /```[\s\S]*?```/g,            // fenced code (backticks)
    /~~~[\s\S]*?~~~/g,            // fenced code (tildes)
    /`[^`\n]*`/g,                 // inline code span
    /!?\[[^\]]*\]\([^)]*\)/g,     // inline markdown link / image
    /!?\[[^\]]*\]\[[^\]]*\]/g,    // reference-style link / image
    /^\s*\[[^\]]+\]:\s*\S+.*$/gm, // link reference definition
    /<a\b[^>]*>[\s\S]*?<\/a>/gi,  // raw HTML anchor
    // Any HTML tag INCLUDING its attributes. The previous pattern was
    // /<[^>\s]+>/ which stops at the first space, so `<img alt="our market
    // report">` was NOT protected and a link got injected inside the attribute,
    // corrupting already-published markup. Attribute text is never prose.
    /<\/?[A-Za-z][^>]*>/g,        // HTML tag with attributes
    /<[^>\s]+>/g,                 // autolink (<https://…>, <a@b.com>)
    /https?:\/\/\S+/g,            // bare URL
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

function overlapsProtected(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([a, b]) => start < b && end > a);
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

/** All whole-token occurrences of `anchor` in `text`, case-insensitively. */
export function anchorOccurrences(text: string, anchor: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!anchor) return out;
  const re = new RegExp(escapeRegExp(anchor), 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const start = m.index;
    const end = start + m[0].length;
    const before = text[start - 1];
    const after = text[end];
    // Reject a match that is part of a larger word ("report" inside "reports").
    const leftOk = !isWordChar(before) || !isWordChar(anchor[0]);
    const rightOk = !isWordChar(after) || !isWordChar(anchor[anchor.length - 1]);
    if (leftOk && rightOk) out.push([start, end]);
    re.lastIndex = end;
  }
  return out;
}

/**
 * Insert a markdown link around the FIRST safe occurrence of `anchor`.
 *
 * Returns the edited paragraph, or NULL when the edit would be unsafe. Null is
 * a refusal, never an error to swallow: the applier turns it into a loud,
 * per-proposal refusal.
 *
 * Refuses when:
 *   - anchor or url is empty
 *   - the anchor does not occur as a whole token
 *   - ANY occurrence sits inside an existing link, code span, code fence, HTML
 *     tag or bare URL (conservative on purpose — we do not pick a "safe" later
 *     occurrence when an earlier one is inside a link; a human re-reads it)
 *   - the destination URL is already present in the paragraph
 *
 * The original casing of the matched text is preserved as the anchor text.
 */
export function insertLink(paragraph: string, anchor: string, url: string): string | null {
  const text = String(paragraph ?? '');
  const a = String(anchor ?? '').trim();
  const u = String(url ?? '').trim();
  if (!text || !a || !u) return null;
  if (/\s/.test(u)) return null;
  if (text.includes(u)) return null; // already links there

  const occurrences = anchorOccurrences(text, a);
  if (occurrences.length === 0) return null;

  const protect = protectedRanges(text);
  for (const [s, e] of occurrences) {
    if (overlapsProtected(protect, s, e)) return null;
  }

  const [start, end] = occurrences[0];
  const matched = text.slice(start, end);
  return `${text.slice(0, start)}[${matched}](${u})${text.slice(end)}`;
}

/**
 * Inverse of insertLink: turn `[anchor](url)` back into plain `anchor`.
 * Returns null when no such link is present (so a revert can refuse rather
 * than pretend).
 */
export function removeLink(paragraph: string, anchor: string, url: string): string | null {
  const text = String(paragraph ?? '');
  const a = String(anchor ?? '').trim();
  const u = String(url ?? '').trim();
  if (!text || !u) return null;
  const re = a
    ? new RegExp(`\\[(${escapeRegExp(a)})\\]\\(${escapeRegExp(u)}\\)`, 'i')
    : new RegExp(`\\[([^\\]]*)\\]\\(${escapeRegExp(u)}\\)`, 'i');
  if (!re.test(text)) return null;
  return text.replace(re, '$1');
}

/** True when the markdown contains a link pointing at `url`. */
export function containsLinkTo(content: string, url: string): boolean {
  const u = String(url ?? '').trim();
  if (!u) return false;
  return new RegExp(`\\]\\(\\s*${escapeRegExp(u)}\\s*\\)`).test(String(content ?? ''))
      || new RegExp(`href=["']${escapeRegExp(u)}["']`).test(String(content ?? ''));
}

// ── A. Approval queue ────────────────────────────────────────────────────────

function setStatus(
  db: DB,
  id: number,
  from: ProposalStatus,
  to: ProposalStatus,
  extra: Partial<Record<'decided_at' | 'decided_by' | 'applied_at' | 'verified_at' | 'verify_result' | 'error' | 'rationale', string | null>> = {},
): void {
  assertTransition(from, to);
  const cols = Object.keys(extra);
  const sets = ['status = ?', ...cols.map(c => `${c} = ?`)].join(', ');
  const vals = [to, ...cols.map(c => (extra as any)[c]), id, from];
  const res = db.prepare(
    `UPDATE interlink_proposals SET ${sets} WHERE id = ? AND status = ?`
  ).run(...(vals as any[]));
  if (Number(res.changes) !== 1) {
    // Someone else moved it between our read and our write.
    throw new Error(`[interlink] Proposal ${id} is no longer in status "${from}" — refusing to overwrite.`);
  }
}

export function approveProposal(db: DB, id: number, approvedBy: string): ProposalRow {
  const who = String(approvedBy ?? '').trim();
  if (!who) throw new Error('[interlink] approveProposal requires approvedBy — an approval must name a human.');
  const row = getProposal(db, id);
  if (!row) throw new Error(`[interlink] Proposal ${id} not found.`);
  setStatus(db, id, row.status, 'approved', { decided_at: nowIso(), decided_by: who, error: null });
  return getProposal(db, id)!;
}

export function rejectProposal(db: DB, id: number, by: string, reason?: string): ProposalRow {
  const who = String(by ?? '').trim();
  if (!who) throw new Error('[interlink] rejectProposal requires a decider.');
  const row = getProposal(db, id);
  if (!row) throw new Error(`[interlink] Proposal ${id} not found.`);
  setStatus(db, id, row.status, 'rejected', {
    decided_at: nowIso(),
    decided_by: who,
    error: reason ? String(reason).slice(0, 500) : null,
  });
  return getProposal(db, id)!;
}

/** Proposals awaiting a human decision, oldest first. */
export function listPending(db: DB, limit = 50): ProposalRow[] {
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  return db.prepare(
    `SELECT * FROM interlink_proposals WHERE status = 'proposed' ORDER BY id ASC LIMIT ?`
  ).all(n) as unknown as ProposalRow[];
}

/** Proposals approved and waiting to be applied, oldest first. */
export function listApproved(db: DB, limit = 50): ProposalRow[] {
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  return db.prepare(
    `SELECT * FROM interlink_proposals WHERE status = 'approved' ORDER BY id ASC LIMIT ?`
  ).all(n) as unknown as ProposalRow[];
}

// ── B. The applier ───────────────────────────────────────────────────────────

export type RefusalReason =
  | 'not-approved'
  | 'flag-disabled'
  | 'shadow-mode'
  | 'platform-not-editable'
  | 'no-adapter'
  | 'unresolvable-post-id'
  | 'missing-paragraph-hash'
  | 'paragraph-changed'
  | 'unsafe-insertion'
  | 'run-limit';

export interface ApplyOutcome {
  id: number;
  action: 'applied' | 'would-apply' | 'refused' | 'failed';
  reason?: RefusalReason;
  detail?: string;
}

export interface ApplySummary {
  dryRun: boolean;
  considered: number;
  applied: number;
  wouldApply: number;
  refused: number;
  failed: number;
  outcomes: ApplyOutcome[];
}

/** Injectable flag gate, so tests never depend on process.env. */
export interface Gate {
  enabled(feature: 'INTERLINKING_APPLY'): boolean;
  mayMutateExternally(feature: 'INTERLINKING_APPLY'): boolean;
}

export const realGate: Gate = {
  enabled: (f) => realEnabled(f),
  mayMutateExternally: (f) => realMayMutate(f),
};

export interface ApplyOptions {
  db: DB;
  /** MUST be set to false explicitly to write anything. Default true. */
  dryRun?: boolean;
  /** Restrict to these proposal ids. Default: all approved. */
  ids?: number[];
  limits?: InterlinkLimits;
  adapters?: AdapterResolver;
  gate?: Gate;
  /** Override platform editability check (tests only). */
  editable?: (platform: string) => boolean;
}

export async function applyApproved(opts: ApplyOptions): Promise<ApplySummary> {
  const db = opts.db;
  const dryRun = opts.dryRun !== false;           // default TRUE
  // Sanitise even a caller-supplied limits object. TypeScript does not survive
  // a JSON round trip, and a cap that reads as NaN is a cap that never fires.
  const limits = sanitiseInterlinkLimits(opts.limits ?? loadInterlinkLimits());
  const resolve = opts.adapters ?? defaultAdapters;
  const gate = opts.gate ?? realGate;
  const editable = opts.editable ?? canApplyInterlinks;

  const maxPerRun = limits.maxLinksAddedPerRun;

  const rows: ProposalRow[] = opts.ids?.length
    ? opts.ids.map(id => getProposal(db, id)).filter((r): r is ProposalRow => !!r)
    : listApproved(db, 1000);

  const outcomes: ApplyOutcome[] = [];
  let changes = 0; // applied + would-apply, both count against the run cap

  for (const row of rows) {
    const refuse = (reason: RefusalReason, detail?: string) => {
      outcomes.push({ id: row.id, action: 'refused', reason, detail });
    };

    if (row.status !== 'approved') { refuse('not-approved', `status is "${row.status}"`); continue; }
    if (!gate.enabled('INTERLINKING_APPLY')) { refuse('flag-disabled', 'FEATURE_INTERLINKING_APPLY is off'); continue; }
    if (!gate.mayMutateExternally('INTERLINKING_APPLY')) { refuse('shadow-mode', 'shadow mode blocks all external writes'); continue; }

    const platform = String(row.source_platform ?? '').trim();
    if (!platform || !editable(platform)) {
      refuse('platform-not-editable', `platform "${platform || '(none)'}" is not proven editable`);
      continue;
    }

    const adapter = resolve(platform);
    if (!adapter || !adapter.canEdit) { refuse('no-adapter', `no usable edit adapter for "${platform}"`); continue; }

    if (!row.paragraph_hash) { refuse('missing-paragraph-hash', 'proposal has no paragraph_hash'); continue; }

    if (changes >= maxPerRun) { refuse('run-limit', `maxLinksAddedPerRun=${maxPerRun} reached`); continue; }

    const postId = adapter.idFromUrl(row.source_url);
    if (!postId) { refuse('unresolvable-post-id', 'could not derive a post id from source_url'); continue; }

    let content: string;
    try {
      content = await adapter.fetchContent(postId);
    } catch (err: any) {
      outcomes.push({ id: row.id, action: 'failed', detail: `fetch failed: ${err?.message ?? err}` });
      markFailed(db, row, `fetch failed: ${err?.message ?? err}`);
      continue;
    }

    const paragraphs = paragraphsOf(content);
    const idx = findParagraphByHash(paragraphs, row.paragraph_hash);
    if (idx < 0) {
      refuse('paragraph-changed', 'live paragraph no longer matches paragraph_hash — re-propose instead');
      continue;
    }

    const edited = insertLink(paragraphs[idx], row.anchor_text, row.destination_url);
    if (edited === null) { refuse('unsafe-insertion', 'anchor is absent, repeated inside a link/code, or already linked'); continue; }

    const newContent = replaceParagraph(content, paragraphs[idx], edited);
    // replaceParagraph returns the document UNCHANGED when it cannot find the
    // block. Writing that back would push an identical document to the live
    // page and then record the proposal as 'applied' — a link that does not
    // exist, marked done. Refuse instead; verification is a later, separate
    // step and must not be the only thing standing between us and a lie.
    if (newContent === content) {
      refuse('unsafe-insertion', 'edited paragraph could not be spliced back into the document — nothing to write');
      continue;
    }
    changes++;

    if (dryRun) {
      outcomes.push({ id: row.id, action: 'would-apply', detail: preview(edited) });
      continue;
    }

    try {
      await adapter.updateContent(postId, newContent);
      setStatus(db, row.id, 'approved', 'applied', { applied_at: nowIso(), error: null });
      outcomes.push({ id: row.id, action: 'applied', detail: preview(edited) });
    } catch (err: any) {
      const msg = `update failed: ${err?.message ?? err}`;
      outcomes.push({ id: row.id, action: 'failed', detail: msg });
      markFailed(db, row, msg);
    }
  }

  return {
    dryRun,
    considered: rows.length,
    applied: outcomes.filter(o => o.action === 'applied').length,
    wouldApply: outcomes.filter(o => o.action === 'would-apply').length,
    refused: outcomes.filter(o => o.action === 'refused').length,
    failed: outcomes.filter(o => o.action === 'failed').length,
    outcomes,
  };
}

function markFailed(db: DB, row: ProposalRow, message: string): void {
  if (row.status !== 'approved') return;
  try {
    setStatus(db, row.id, 'approved', 'failed', { error: String(message).slice(0, 500) });
  } catch { /* another process moved it; the outcome list still records the failure */ }
}

function preview(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 160 ? `${one.slice(0, 157)}...` : one;
}

/** Replace one paragraph block inside a document, first occurrence only. */
export function replaceParagraph(content: string, oldParagraph: string, newParagraph: string): string {
  const at = content.indexOf(oldParagraph);
  if (at < 0) return content;
  return content.slice(0, at) + newParagraph + content.slice(at + oldParagraph.length);
}

// ── E. Post-apply verification ───────────────────────────────────────────────

export interface VerifyResult {
  id: number;
  ok: boolean;
  result: 'present' | 'missing' | 'error' | 'skipped';
  detail?: string;
}

export interface VerifyOptions {
  db: DB;
  id: number;
  adapters?: AdapterResolver;
}

/**
 * Re-fetch the live page and confirm the link really is there. A proposal that
 * cannot be verified becomes 'failed' — never a silent success.
 */
export async function verifyApplied(opts: VerifyOptions): Promise<VerifyResult> {
  const { db, id } = opts;
  const resolve = opts.adapters ?? defaultAdapters;
  const row = getProposal(db, id);
  if (!row) throw new Error(`[interlink] Proposal ${id} not found.`);
  if (row.status !== 'applied') {
    return { id, ok: false, result: 'skipped', detail: `status is "${row.status}", not "applied"` };
  }

  const adapter = resolve(row.source_platform);
  const postId = adapter?.idFromUrl(row.source_url) ?? null;
  if (!adapter || !postId) {
    return recordVerify(db, row, 'error', 'no adapter or unresolvable post id');
  }

  let content: string;
  try {
    content = await adapter.fetchContent(postId);
  } catch (err: any) {
    return recordVerify(db, row, 'error', `fetch failed: ${err?.message ?? err}`);
  }

  return containsLinkTo(content, row.destination_url)
    ? recordVerify(db, row, 'present', 'destination link found on the live page')
    : recordVerify(db, row, 'missing', 'destination link NOT found on the live page');
}

function recordVerify(
  db: DB,
  row: ProposalRow,
  result: 'present' | 'missing' | 'error',
  detail: string,
): VerifyResult {
  const ok = result === 'present';
  db.prepare('UPDATE interlink_proposals SET verified_at = ?, verify_result = ? WHERE id = ?')
    .run(nowIso(), `${result}: ${detail}`.slice(0, 500), row.id);
  if (!ok) {
    // applied -> failed is not a legal edge, so this is a direct, deliberate
    // correction of a status we now know to be wrong.
    db.prepare(`UPDATE interlink_proposals SET status = 'failed', error = ? WHERE id = ? AND status = 'applied'`)
      .run(`verification ${result}: ${detail}`.slice(0, 500), row.id);
  }
  return { id: row.id, ok, result, detail };
}

// ── F. Revert ────────────────────────────────────────────────────────────────

export interface RevertOptions {
  db: DB;
  id: number;
  /** Default TRUE, exactly like the applier. */
  dryRun?: boolean;
  adapters?: AdapterResolver;
  gate?: Gate;
}

export interface RevertResult {
  id: number;
  action: 'reverted' | 'would-revert' | 'refused' | 'failed';
  reason?: string;
}

/** Remove a previously inserted link and move the proposal to 'reverted'. */
export async function revertApplied(opts: RevertOptions): Promise<RevertResult> {
  const { db, id } = opts;
  const dryRun = opts.dryRun !== false;
  const resolve = opts.adapters ?? defaultAdapters;
  const gate = opts.gate ?? realGate;

  const row = getProposal(db, id);
  if (!row) throw new Error(`[interlink] Proposal ${id} not found.`);
  if (row.status !== 'applied') return { id, action: 'refused', reason: `status is "${row.status}", not "applied"` };
  if (!gate.enabled('INTERLINKING_APPLY')) return { id, action: 'refused', reason: 'flag-disabled' };
  if (!gate.mayMutateExternally('INTERLINKING_APPLY')) return { id, action: 'refused', reason: 'shadow-mode' };

  const adapter = resolve(row.source_platform);
  const postId = adapter?.idFromUrl(row.source_url) ?? null;
  if (!adapter || !adapter.canEdit || !postId) return { id, action: 'refused', reason: 'no-adapter' };

  let content: string;
  try {
    content = await adapter.fetchContent(postId);
  } catch (err: any) {
    return { id, action: 'failed', reason: `fetch failed: ${err?.message ?? err}` };
  }

  const stripped = removeLink(content, row.anchor_text, row.destination_url);
  if (stripped === null) return { id, action: 'refused', reason: 'link-not-present' };

  if (dryRun) return { id, action: 'would-revert' };

  try {
    await adapter.updateContent(postId, stripped);
  } catch (err: any) {
    return { id, action: 'failed', reason: `update failed: ${err?.message ?? err}` };
  }

  setStatus(db, id, 'applied', 'reverted', {
    decided_at: nowIso(),
    verify_result: 'reverted: link removed from the live page',
  });
  return { id, action: 'reverted' };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function queueSummary(db: DB): Record<ProposalStatus, number> {
  const out = Object.fromEntries(PROPOSAL_STATUSES.map(s => [s, 0])) as Record<ProposalStatus, number>;
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM interlink_proposals GROUP BY status').all() as any[]) {
    const s: unknown = r?.status;
    if (isProposalStatus(s)) out[s] = Number(r?.n ?? 0);
  }
  return out;
}

export function formatApplySummary(s: ApplySummary): string {
  const head = s.dryRun
    ? `[interlink] DRY RUN — nothing was written. ${s.considered} considered.`
    : `[interlink] LIVE RUN. ${s.considered} considered.`;
  const lines = [
    head,
    `  applied: ${s.applied}  would-apply: ${s.wouldApply}  refused: ${s.refused}  failed: ${s.failed}`,
  ];
  for (const o of s.outcomes) {
    lines.push(`  #${o.id} ${o.action}${o.reason ? ` (${o.reason})` : ''}${o.detail ? ` — ${o.detail}` : ''}`);
  }
  return lines.join('\n');
}

export type { PlatformEditAdapter, AdapterResolver };
