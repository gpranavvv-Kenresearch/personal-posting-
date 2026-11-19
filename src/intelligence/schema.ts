/**
 * schema.ts — versioned database migrations for the intelligence store.
 *
 * Rules (blueprint modification #5):
 *   - Migrations are append-only. Never edit a shipped migration; add a new
 *     one. The applied set is recorded in schema_migrations.
 *   - Every migration has an `up`. `down` is optional but strongly preferred,
 *     because data rollback is a distinct capability from code rollback.
 *   - Migrations run inside a transaction and are idempotent where possible.
 *
 * All timestamps are ISO-8601 UTC strings. All dates are YYYY-MM-DD.
 * Money is stored in minor units (integer) to avoid float drift.
 */

export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'published_posts',
    up: `
      -- One row per thing we actually published, anywhere.
      -- This is the spine: performance, indexation and interlinking all hang
      -- off it. report_url is the kenresearch.com page being promoted;
      -- published_url is where our post lives (medium.com/..., hackmd.io/...).
      CREATE TABLE IF NOT EXISTS published_posts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        report_url      TEXT NOT NULL,
        platform        TEXT NOT NULL,
        published_url   TEXT,
        account         TEXT,
        posted_at       TEXT NOT NULL,
        sheet_tab       TEXT,
        sheet_row       INTEGER,
        title           TEXT,
        utm_source      TEXT,
        created_at      TEXT NOT NULL,
        UNIQUE(platform, published_url)
      );
      CREATE INDEX IF NOT EXISTS idx_posts_report ON published_posts(report_url);
      CREATE INDEX IF NOT EXISTS idx_posts_platform ON published_posts(platform);
      CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON published_posts(posted_at);
    `,
    down: `DROP TABLE IF EXISTS published_posts;`,
  },

  {
    version: 2,
    name: 'url_performance',
    up: `
      -- Daily performance per URL per source. One row per (url, source, date,
      -- metric_scope). Re-running a collection for the same day overwrites
      -- rather than duplicating, via the UNIQUE constraint.
      CREATE TABLE IF NOT EXISTS url_performance (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        url             TEXT NOT NULL,
        source          TEXT NOT NULL,          -- 'gsc' | 'ga4'
        metric_date     TEXT NOT NULL,          -- YYYY-MM-DD
        metric_scope    TEXT NOT NULL DEFAULT 'url',  -- 'url' | 'query' | 'country'
        dimension_value TEXT,                   -- the query / country when scoped
        clicks          INTEGER DEFAULT 0,
        impressions     INTEGER DEFAULT 0,
        position        REAL,
        ctr             REAL,
        sessions        INTEGER DEFAULT 0,
        users           INTEGER DEFAULT 0,
        engaged_sessions INTEGER DEFAULT 0,
        conversions     INTEGER DEFAULT 0,
        collected_at    TEXT NOT NULL,
        UNIQUE(url, source, metric_date, metric_scope, dimension_value)
      );
      CREATE INDEX IF NOT EXISTS idx_perf_url ON url_performance(url);
      CREATE INDEX IF NOT EXISTS idx_perf_date ON url_performance(metric_date);
      CREATE INDEX IF NOT EXISTS idx_perf_source ON url_performance(source);
    `,
    down: `DROP TABLE IF EXISTS url_performance;`,
  },

  {
    version: 3,
    name: 'indexation_checks',
    up: `
      -- Indexation EVIDENCE, not confirmation (blueprint modification #1).
      -- status is deliberately tri-state and 'unknown' is a first-class value:
      -- a site: query returning nothing may mean not indexed, or may mean the
      -- provider throttled us.
      CREATE TABLE IF NOT EXISTS indexation_checks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        url           TEXT NOT NULL,
        platform      TEXT,
        checked_at    TEXT NOT NULL,
        status        TEXT NOT NULL CHECK(status IN ('indexed','not_indexed','unknown')),
        evidence      TEXT,
        provider      TEXT,
        confidence    REAL DEFAULT 0.5,
        raw_hit_count INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_idx_url ON indexation_checks(url);
      CREATE INDEX IF NOT EXISTS idx_idx_checked ON indexation_checks(checked_at);
    `,
    down: `DROP TABLE IF EXISTS indexation_checks;`,
  },

  {
    version: 4,
    name: 'leads',
    up: `
      -- CRM leads, attributed to a landing URL / utm_source where possible.
      -- Deliberately independent of GSC and GA4 (modification #8): this table
      -- is populated by its own collector and is useful on its own.
      CREATE TABLE IF NOT EXISTS leads (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id     TEXT NOT NULL,
        source_system   TEXT NOT NULL DEFAULT 'pipedrive',
        created_at      TEXT NOT NULL,
        landing_url     TEXT,
        report_url      TEXT,
        utm_source      TEXT,
        utm_campaign    TEXT,
        stage           TEXT,
        status          TEXT,
        value_minor     INTEGER,
        currency        TEXT,
        collected_at    TEXT NOT NULL,
        UNIQUE(source_system, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_leads_report ON leads(report_url);
      CREATE INDEX IF NOT EXISTS idx_leads_utm ON leads(utm_source);
      CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
    `,
    down: `DROP TABLE IF EXISTS leads;`,
  },

  {
    version: 5,
    name: 'opportunity_scores',
    up: `
      -- A score for a report URL at a point in time. components holds the
      -- per-signal breakdown as JSON so a score can always be explained, and
      -- weights_version records which weight set produced it — essential for
      -- calibration (modification #2: weights are experimental).
      CREATE TABLE IF NOT EXISTS opportunity_scores (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        report_url      TEXT NOT NULL,
        scored_at       TEXT NOT NULL,
        score           REAL NOT NULL,
        rank_hint       INTEGER,
        components      TEXT NOT NULL,
        weights_version TEXT NOT NULL,
        shadow          INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_scores_report ON opportunity_scores(report_url);
      CREATE INDEX IF NOT EXISTS idx_scores_at ON opportunity_scores(scored_at);
    `,
    down: `DROP TABLE IF EXISTS opportunity_scores;`,
  },

  {
    version: 6,
    name: 'platform_stats',
    up: `
      -- Rolled-up performance per platform over a window. This is what answers
      -- "which of the 34 platforms are actually worth posting to".
      CREATE TABLE IF NOT EXISTS platform_stats (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        platform          TEXT NOT NULL,
        window_start      TEXT NOT NULL,
        window_end        TEXT NOT NULL,
        posts             INTEGER DEFAULT 0,
        posts_indexed     INTEGER DEFAULT 0,
        posts_unknown     INTEGER DEFAULT 0,
        sessions          INTEGER DEFAULT 0,
        clicks            INTEGER DEFAULT 0,
        impressions       INTEGER DEFAULT 0,
        leads             INTEGER DEFAULT 0,
        success_rate      REAL,
        sessions_per_post REAL,
        leads_per_post    REAL,
        computed_at       TEXT NOT NULL,
        UNIQUE(platform, window_start, window_end)
      );
      CREATE INDEX IF NOT EXISTS idx_pstats_platform ON platform_stats(platform);
    `,
    down: `DROP TABLE IF EXISTS platform_stats;`,
  },

  {
    version: 7,
    name: 'content_stats',
    up: `
      -- Which content characteristics correlate with outcomes.
      CREATE TABLE IF NOT EXISTS content_stats (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        published_post_id INTEGER,
        url             TEXT NOT NULL,
        platform        TEXT,
        word_count      INTEGER,
        heading_count   INTEGER,
        link_count      INTEGER,
        image_count     INTEGER,
        title_length    INTEGER,
        has_number_in_title INTEGER,
        readability     REAL,
        sessions_30d    INTEGER DEFAULT 0,
        clicks_30d      INTEGER DEFAULT 0,
        leads_30d       INTEGER DEFAULT 0,
        computed_at     TEXT NOT NULL,
        FOREIGN KEY(published_post_id) REFERENCES published_posts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_cstats_url ON content_stats(url);
    `,
    down: `DROP TABLE IF EXISTS content_stats;`,
  },

  {
    version: 8,
    name: 'interlink_proposals',
    up: `
      -- Proposed internal links. NOTHING here is applied without an explicit
      -- human approval row: status must pass through 'approved' before
      -- 'applied', and the applier refuses any other transition.
      CREATE TABLE IF NOT EXISTS interlink_proposals (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source_url        TEXT NOT NULL,
        source_platform   TEXT,
        destination_url   TEXT NOT NULL,
        anchor_text       TEXT NOT NULL,
        paragraph_excerpt TEXT,
        paragraph_hash    TEXT,
        relevance         REAL,
        rationale         TEXT,
        status            TEXT NOT NULL DEFAULT 'proposed'
                          CHECK(status IN ('proposed','approved','rejected','applied','failed','reverted')),
        created_at        TEXT NOT NULL,
        decided_at        TEXT,
        decided_by        TEXT,
        applied_at        TEXT,
        verified_at       TEXT,
        verify_result     TEXT,
        error             TEXT,
        UNIQUE(source_url, destination_url, anchor_text)
      );
      CREATE INDEX IF NOT EXISTS idx_ilp_status ON interlink_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_ilp_source ON interlink_proposals(source_url);
    `,
    down: `DROP TABLE IF EXISTS interlink_proposals;`,
  },

  {
    version: 9,
    name: 'url_mapping',
    up: `
      -- Maps a kenresearch.com report URL to the posts promoting it, and
      -- records how confident that mapping is. Needed because the sheet does
      -- not always record the published URL cleanly.
      CREATE TABLE IF NOT EXISTS url_mapping (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        report_url    TEXT NOT NULL,
        published_url TEXT NOT NULL,
        platform      TEXT,
        method        TEXT NOT NULL,     -- 'sheet' | 'utm' | 'slug' | 'manual'
        confidence    REAL NOT NULL DEFAULT 0.5,
        created_at    TEXT NOT NULL,
        UNIQUE(report_url, published_url)
      );
      CREATE INDEX IF NOT EXISTS idx_map_report ON url_mapping(report_url);
      CREATE INDEX IF NOT EXISTS idx_map_published ON url_mapping(published_url);
    `,
    down: `DROP TABLE IF EXISTS url_mapping;`,
  },

  {
    version: 10,
    name: 'calibration_runs',
    up: `
      -- Records each attempt to calibrate scoring weights against real
      -- outcomes, so a weight change is always traceable to evidence.
      CREATE TABLE IF NOT EXISTS calibration_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at          TEXT NOT NULL,
        window_start    TEXT NOT NULL,
        window_end      TEXT NOT NULL,
        sample_size     INTEGER NOT NULL,
        weights_before  TEXT NOT NULL,
        weights_after   TEXT NOT NULL,
        correlation     TEXT,
        applied         INTEGER NOT NULL DEFAULT 0,
        notes           TEXT
      );
    `,
    down: `DROP TABLE IF EXISTS calibration_runs;`,
  },

  {
    version: 11,
    name: 'collection_runs',
    up: `
      -- Bookkeeping for every collector, so a run can resume from where it
      -- stopped and a gap in the data is visible rather than silent.
      CREATE TABLE IF NOT EXISTS collection_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        collector     TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        finished_at   TEXT,
        window_start  TEXT,
        window_end    TEXT,
        rows_written  INTEGER DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'running'
                      CHECK(status IN ('running','ok','partial','failed')),
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_collector ON collection_runs(collector, started_at);
    `,
    down: `DROP TABLE IF EXISTS collection_runs;`,
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
