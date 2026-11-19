/**
 * runCycle.ts — the single entry point the scheduler calls.
 *
 * This is the ONLY function the existing automation needs to know about. It is
 * deliberately shaped so that wiring it in is close to risk-free:
 *
 *   - If FEATURE_INTELLIGENCE is unset (the default), it returns immediately
 *     having done nothing at all. No database is created, no network call is
 *     made, no file is written.
 *   - It never throws. A failure inside any stage is caught, recorded and
 *     reported. An intelligence problem must never take down posting.
 *   - It never posts, never edits published content, and never changes the
 *     schedule. The only stage that can touch the outside world is interlink
 *     application, which additionally requires per-proposal human approval and
 *     is disabled in shadow mode.
 *
 * In other words: the worst case for the live system is that this function
 * wastes a little time and logs a warning.
 */

import type { DB } from './db.js';
import { openDb, nowIso } from './db.js';
import { FLAGS, enabled, describeFlags } from './flags.js';

export interface StageResult {
  stage: string;
  ran: boolean;
  skippedReason?: string;
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface CycleResult {
  startedAt: string;
  finishedAt: string;
  enabled: boolean;
  stages: StageResult[];
  summary: string;
}

type StageFn = (db: DB) => Promise<string>;

interface Stage {
  name: string;
  flag: Parameters<typeof enabled>[0];
  run: StageFn;
}

/**
 * Run one stage, converting any failure into a recorded result.
 * Timing uses a monotonic-ish difference of Date.now(); if a stage throws we
 * still record how long it took to fail.
 */
async function runStage(db: DB, stage: Stage): Promise<StageResult> {
  const started = Date.now();

  if (!enabled(stage.flag)) {
    return {
      stage: stage.name,
      ran: false,
      skippedReason: `${String(stage.flag)} is off`,
      durationMs: 0,
    };
  }

  try {
    const detail = await stage.run(db);
    return { stage: stage.name, ran: true, durationMs: Date.now() - started, detail };
  } catch (err: any) {
    return {
      stage: stage.name,
      ran: false,
      durationMs: Date.now() - started,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Stages are defined with dynamic imports so that a disabled feature never
 * even loads its module — which means a broken or half-finished intelligence
 * module cannot break the scheduler's startup.
 */
function buildStages(opts: CycleOptions): Stage[] {
  return [
    {
      name: 'ingest-sheet',
      flag: 'INTELLIGENCE_ENABLED',
      run: async db => {
        const m: any = await import('./urlMapping.js');
        const fn = m.ingestFromSheet ?? m.default?.ingestFromSheet;
        if (typeof fn !== 'function') return 'ingestFromSheet unavailable — skipped';
        const r = await fn({ db, limit: opts.ingestLimit ?? 500 });
        return summarise(r, 'rows ingested');
      },
    },
    {
      name: 'collect-gsc',
      flag: 'GSC_COLLECTION',
      run: async db => {
        const m: any = await import('./collectors/gsc.js');
        const fn = m.collectGsc ?? m.default?.collectGsc;
        if (typeof fn !== 'function') return 'collectGsc unavailable — skipped';
        return summarise(await fn({ db }), 'rows');
      },
    },
    {
      name: 'collect-ga4',
      flag: 'GA4_COLLECTION',
      run: async db => {
        const m: any = await import('./collectors/ga4.js');
        const fn = m.collectGa4 ?? m.default?.collectGa4;
        if (typeof fn !== 'function') return 'collectGa4 unavailable — skipped';
        return summarise(await fn({ db }), 'rows');
      },
    },
    {
      name: 'collect-leads',
      flag: 'PIPEDRIVE_COLLECTION',
      run: async db => {
        const m: any = await import('./collectors/pipedrive.js');
        const fn = m.collectPipedrive ?? m.default?.collectPipedrive;
        if (typeof fn !== 'function') return 'collectPipedrive unavailable — skipped';
        return summarise(await fn({ db }), 'leads');
      },
    },
    {
      name: 'indexation',
      flag: 'INDEXATION_CHECKS',
      run: async db => {
        const m: any = await import('./indexation.js');
        const fn = m.checkIndexation ?? m.default?.checkIndexation;
        if (typeof fn !== 'function') return 'checkIndexation unavailable — skipped';
        return summarise(await fn({ db, limit: opts.indexationLimit ?? 50 }), 'checked');
      },
    },
    {
      name: 'scoring',
      flag: 'OPPORTUNITY_SCORING',
      run: async db => {
        const { scoreReports } = await import('./scoring.js');
        const urls = (db.prepare(
          `SELECT DISTINCT report_url FROM published_posts
            WHERE report_url IS NOT NULL AND report_url <> '' LIMIT ?`
        ).all(opts.scoreLimit ?? 200) as any[]).map(r => r.report_url as string);
        if (!urls.length) return 'no report URLs known yet';
        const results = scoreReports(db, urls);
        const shadow = FLAGS.SHADOW_MODE || !FLAGS.SCORING_INFLUENCES_ORDER;
        return `${results.length} scored${shadow ? ' (shadow — ordering unaffected)' : ''}`;
      },
    },
    {
      name: 'platform-intelligence',
      flag: 'PLATFORM_INTELLIGENCE',
      run: async db => {
        const { analysePlatforms } = await import('./platformIntelligence.js');
        const verdicts = analysePlatforms({ db, windowDays: opts.windowDays ?? 90 });
        const drop = verdicts.filter(v => v.recommendation === 'consider-dropping').length;
        const thin = verdicts.filter(v => v.recommendation === 'insufficient-data').length;
        return `${verdicts.length} platforms: ${drop} flagged, ${thin} lacking data`;
      },
    },
    {
      name: 'content-intelligence',
      flag: 'CONTENT_INTELLIGENCE',
      run: async db => {
        const { analyseContent } = await import('./contentIntelligence.js');
        const out = analyseContent(db);
        const usable = out.filter(c => c.r !== null).length;
        return `${out.length} pairings, ${usable} with enough data`;
      },
    },
    {
      name: 'interlink-propose',
      flag: 'INTERLINKING_PROPOSALS',
      run: async db => {
        const m: any = await import('./interlink/propose.js').catch(() => null);
        const fn = m?.generateProposals ?? m?.default?.generateProposals;
        if (typeof fn !== 'function') return 'proposal generation unavailable — skipped';
        return summarise(await fn({ db, limit: opts.proposalLimit ?? 20 }), 'proposals');
      },
    },
    {
      name: 'interlink-apply',
      flag: 'INTERLINKING_APPLY',
      run: async db => {
        // Even with the flag on, shadow mode must block every external write.
        if (FLAGS.SHADOW_MODE) return 'shadow mode — no external changes made';
        const m: any = await import('./interlink/apply.js').catch(() => null);
        const fn = m?.applyApproved ?? m?.default?.applyApproved;
        if (typeof fn !== 'function') return 'applier unavailable — skipped';
        // dryRun defaults true in the applier; the scheduler never forces it false.
        return summarise(await fn({ db, dryRun: opts.applyDryRun !== false }), 'applied');
      },
    },
  ];
}

function summarise(result: any, noun: string): string {
  if (result === null || result === undefined) return `no ${noun}`;
  if (typeof result === 'number') return `${result} ${noun}`;
  if (typeof result === 'string') return result;
  for (const k of ['written', 'rowsWritten', 'count', 'processed', 'created', 'applied']) {
    if (typeof result[k] === 'number') return `${result[k]} ${noun}`;
  }
  if (Array.isArray(result)) return `${result.length} ${noun}`;
  return `${noun}: done`;
}

export interface CycleOptions {
  db?: DB;
  windowDays?: number;
  ingestLimit?: number;
  indexationLimit?: number;
  scoreLimit?: number;
  proposalLimit?: number;
  /** Applier dry run. Defaults true. The scheduler never sets this false. */
  applyDryRun?: boolean;
}

/**
 * Run the full intelligence cycle. Safe to call from cron.
 *
 * Returns a report rather than throwing. The caller may log it and move on.
 */
export async function runIntelligenceCycle(opts: CycleOptions = {}): Promise<CycleResult> {
  const startedAt = nowIso();

  if (!FLAGS.INTELLIGENCE_ENABLED) {
    const finishedAt = nowIso();
    return {
      startedAt, finishedAt, enabled: false, stages: [],
      summary: 'Intelligence disabled (FEATURE_INTELLIGENCE is off) — nothing was done.',
    };
  }

  let db: DB;
  try {
    db = opts.db ?? openDb();
  } catch (err: any) {
    const finishedAt = nowIso();
    return {
      startedAt, finishedAt, enabled: true, stages: [],
      summary: `Could not open the intelligence database: ${err?.message ?? err}. No other work attempted.`,
    };
  }

  const stages: StageResult[] = [];
  for (const stage of buildStages(opts)) {
    stages.push(await runStage(db, stage));
  }

  const ran = stages.filter(s => s.ran).length;
  const failed = stages.filter(s => s.error).length;
  const skipped = stages.filter(s => !s.ran && !s.error).length;

  return {
    startedAt,
    finishedAt: nowIso(),
    enabled: true,
    stages,
    summary:
      `Intelligence cycle: ${ran} ran, ${skipped} skipped, ${failed} failed. ` +
      `${describeFlags()}${FLAGS.SHADOW_MODE ? ' [SHADOW MODE — nothing external was changed]' : ''}`,
  };
}

/** Multi-line report for the runtime log. */
export function formatCycleResult(r: CycleResult): string {
  const lines = [`[intelligence] ${r.summary}`];
  for (const s of r.stages) {
    if (s.error) lines.push(`   ✖ ${s.stage}: ${s.error}`);
    else if (!s.ran) lines.push(`   – ${s.stage}: skipped (${s.skippedReason})`);
    else lines.push(`   ✔ ${s.stage}: ${s.detail ?? 'done'} (${s.durationMs}ms)`);
  }
  return lines.join('\n');
}
