/**
 * flags.ts — feature flags for the distribution-intelligence layer.
 *
 * Every intelligence feature is OFF unless explicitly enabled. With no flags
 * set, the existing automation behaves exactly as it does today: nothing is
 * collected, nothing is scored, no ordering changes, nothing is published.
 *
 * This is the primary rollback mechanism (blueprint modification #6):
 * configuration rollback = unset the flag. It is independent of code rollback
 * (git revert) and data rollback (restore the database).
 */

function flag(name: string, def = false): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (v === '') return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const FLAGS = {
  /** Master switch. When false every other intelligence flag is ignored. */
  get INTELLIGENCE_ENABLED() { return flag('FEATURE_INTELLIGENCE'); },

  /** Collect Google Search Console data into the local store. */
  get GSC_COLLECTION() { return flag('FEATURE_GSC_COLLECTION'); },
  /** Collect GA4 traffic data into the local store. */
  get GA4_COLLECTION() { return flag('FEATURE_GA4_COLLECTION'); },
  /** Collect CRM lead data. Independent of GSC/GA4 (modification #8). */
  get PIPEDRIVE_COLLECTION() { return flag('FEATURE_PIPEDRIVE_COLLECTION'); },

  /** Check indexation via SERP site: queries. Evidence, not proof (mod #1). */
  get INDEXATION_CHECKS() { return flag('FEATURE_INDEXATION_CHECKS'); },

  /** Compute opportunity scores. Does NOT change posting order on its own. */
  get OPPORTUNITY_SCORING() { return flag('FEATURE_OPPORTUNITY_SCORING'); },
  /**
   * Let scores actually reorder what gets posted. Separate from computing
   * them, so scores can be observed for weeks before they influence anything.
   */
  get SCORING_INFLUENCES_ORDER() { return flag('FEATURE_SCORING_INFLUENCES_ORDER'); },

  get PLATFORM_INTELLIGENCE() { return flag('FEATURE_PLATFORM_INTELLIGENCE'); },
  get CONTENT_INTELLIGENCE() { return flag('FEATURE_CONTENT_INTELLIGENCE'); },

  /** Generate interlink proposals. Proposals are never auto-applied. */
  get INTERLINKING_PROPOSALS() { return flag('FEATURE_INTERLINKING_PROPOSALS'); },
  /**
   * Apply interlinks that a human has approved. Requires an explicit approval
   * record per proposal; this flag alone publishes nothing.
   */
  get INTERLINKING_APPLY() { return flag('FEATURE_INTERLINKING_APPLY'); },

  /**
   * Shadow mode: compute and record everything, but never let any of it
   * affect live behaviour. The safe default for a first production rollout.
   */
  get SHADOW_MODE() { return flag('FEATURE_SHADOW_MODE', true); },
};

/** True when `feature` may actually run: master switch AND its own flag. */
export function enabled(feature: keyof typeof FLAGS): boolean {
  if (feature === 'INTELLIGENCE_ENABLED') return FLAGS.INTELLIGENCE_ENABLED;
  return FLAGS.INTELLIGENCE_ENABLED && Boolean(FLAGS[feature]);
}

/**
 * True when an action would change the outside world (post, edit, write to a
 * live page). Shadow mode forces this false.
 */
export function mayMutateExternally(feature: keyof typeof FLAGS): boolean {
  return enabled(feature) && !FLAGS.SHADOW_MODE;
}

export function describeFlags(): string {
  const on = Object.keys(FLAGS).filter(k => Boolean((FLAGS as any)[k]));
  return on.length ? `flags: ${on.join(', ')}` : 'flags: none (all intelligence features off)';
}
