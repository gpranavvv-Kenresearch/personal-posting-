/**
 * sheetIds.ts — single source of truth for every Google Spreadsheet ID.
 *
 * MILESTONE 0 (safety harness). Purpose: make it impossible to point a
 * development run at the production spreadsheets by accident.
 *
 * Design contract:
 *   - With NO environment configured, every exported id is byte-identical to
 *     the literal that was previously hardcoded. Production behaviour is
 *     therefore unchanged by this file's introduction.
 *   - KEN_ENV is strictly validated. Only 'development' and 'production' are
 *     accepted; anything else throws. A typo such as KEN_ENV=dev must never
 *     silently degrade into a production run.
 *   - In development mode there is NO fallback to production. If a dev id is
 *     missing, blank, or still equal to a production id, startup fails loudly.
 *
 * To run against a development spreadsheet:
 *   KEN_ENV=development
 *   MAIN_SHEET_ID=<your dev spreadsheet id>
 *   DISTRIBUTED_URL_SHEET_ID=<your dev spreadsheet id>
 */

/** The live production spreadsheets. Defaults, so an unset env == today. */
const PROD_MAIN_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const PROD_DISTRIBUTED_URL_SHEET_ID = '1ZbEcDaK-zb6U1SK1P23UIjezN5NGdy3R15r9W-glVlU';

/** Every production id, for the "is this a production id?" check. */
const ALL_PRODUCTION_IDS: readonly string[] = [
  PROD_MAIN_SHEET_ID,
  PROD_DISTRIBUTED_URL_SHEET_ID,
];

export type KenEnv = 'development' | 'production';

/**
 * Strict KEN_ENV parsing. Unset => 'production' (preserves today's
 * behaviour). Any value other than the two valid ones throws rather than
 * being coerced, so a misspelling can never be read as "production".
 */
export function parseKenEnv(raw: string | undefined): KenEnv {
  if (raw === undefined || raw.trim() === '') return 'production';
  const v = raw.trim();
  if (v === 'development' || v === 'production') return v;
  throw new Error(
    `[sheetIds] Invalid KEN_ENV value ${JSON.stringify(raw)}. ` +
    `Only "development" or "production" are accepted (case-sensitive). ` +
    `Refusing to start rather than guessing which environment you meant.`
  );
}

export const KEN_ENV: KenEnv = parseKenEnv(process.env.KEN_ENV);
export const IS_DEVELOPMENT = KEN_ENV === 'development';

export function isProductionId(id: string): boolean {
  return ALL_PRODUCTION_IDS.includes(id);
}

/**
 * Resolve one spreadsheet id.
 *
 * production: env override if present, else the production default.
 * development: env override is MANDATORY and must not be a production id.
 */
export function resolveSheetId(
  envName: string,
  productionDefault: string,
  env: NodeJS.ProcessEnv = process.env,
  kenEnv: KenEnv = KEN_ENV,
): string {
  const override = env[envName]?.trim();

  if (kenEnv === 'development') {
    const devTab = (env.KEN_DEV_SHEET_TAB ?? '').trim();

    if (!override) {
      throw new Error(
        `[sheetIds] KEN_ENV=development but ${envName} is not set. ` +
        `Development mode never falls back to the production spreadsheet. ` +
        `Set ${envName} to your development spreadsheet id.`
      );
    }

    if (isProductionId(override)) {
      // Tab-scoped development: the test tab lives INSIDE the production
      // spreadsheet, so the spreadsheet id is legitimately a production id.
      // This is only permitted when a dev tab is named, because the tab guard
      // (config/tabGuard.ts) then confines every read and write to that one
      // tab and blocks every other tab by name.
      if (!devTab) {
        throw new Error(
          `[sheetIds] KEN_ENV=development but ${envName} resolves to a PRODUCTION ` +
          `spreadsheet id, and KEN_DEV_SHEET_TAB is not set. Refusing to start.
` +
          `  Either point ${envName} at a separate development spreadsheet,
` +
          `  or set KEN_DEV_SHEET_TAB to the test tab inside it (e.g. Test_Abhinav), ` +
          `which confines all access to that single tab.`
        );
      }
      return override;
    }

    return override;
  }

  return override || productionDefault;
}

export const MAIN_SHEET_ID = resolveSheetId('MAIN_SHEET_ID', PROD_MAIN_SHEET_ID);
export const DISTRIBUTED_URL_SHEET_ID = resolveSheetId(
  'DISTRIBUTED_URL_SHEET_ID',
  PROD_DISTRIBUTED_URL_SHEET_ID,
);

/** Mask an id for logs — never print a full spreadsheet id to a shared log. */
export function maskId(id: string): string {
  if (id.length <= 12) return '***';
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function describeSheetConfig(): string {
  return `env=${KEN_ENV} main=${maskId(MAIN_SHEET_ID)} distributedUrl=${maskId(DISTRIBUTED_URL_SHEET_ID)}`;
}

/**
 * The single tab a development run is confined to, when testing against a tab
 * inside the production spreadsheet. Empty in production.
 */
export const DEV_SHEET_TAB: string =
  KEN_ENV === 'development' ? (process.env.KEN_DEV_SHEET_TAB ?? '').trim() : '';

/** True when every read/write must be rewritten onto DEV_SHEET_TAB. */
export const TAB_LOCK_ACTIVE = KEN_ENV === 'development' && DEV_SHEET_TAB !== '';

/**
 * Tabs a development run is allowed to create and use. Any tab whose name
 * starts with this prefix is ours; every pre-existing live tab (Social Media,
 * Blogs, New Logic, ...) does not match and stays untouchable.
 *
 * Defaults to "Test_" so that DEV_SHEET_TAB=Test_Abhinav works out of the box.
 */
export const DEV_TAB_PREFIX: string =
  (process.env.KEN_DEV_TAB_PREFIX ?? 'Test_').trim();

/** True if `tab` is a development tab this run may read, write and create. */
export function isDevTab(
  tab: string,
  devTab: string = DEV_SHEET_TAB,
  prefix: string = DEV_TAB_PREFIX,
): boolean {
  if (!tab) return false;
  if (devTab !== '' && tab === devTab) return true;
  return prefix !== '' && tab.startsWith(prefix);
}
