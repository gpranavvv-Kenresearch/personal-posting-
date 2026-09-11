/**
 * blogBrandValidator.ts — Ken Research brand-authority compliance gate.
 * Runs after blogSanityAgent.ts's HTML cleanup but before a generated blog
 * is saved to the sheet. Implements the checks from
 * ken-brand-authority-layer-SKILL.md / ken-brand-authority-validator.md:
 * title branding, opening-paragraph branding + hyperlink, word-count-based
 * mention frequency, brand-quality wording, and promotional-risk language.
 *
 * blogGenAgent.ts's own ChatGPT master prompt already enforces a much
 * stricter link architecture (10-12 links, exact UTM string) — this module
 * is an independent, code-side second check on top of that, per the
 * Generate -> Brand Validator -> Publish/Rewrite flow in
 * claude-code-integration-instructions.md.
 */

export interface BrandValidatorContext {
  title?: string;
}

export interface BrandIssue {
  rule: string;
  problem: string;
  fix: string;
}

export interface BrandValidationResult {
  status: 'PASS' | 'REWRITE_REQUIRED';
  score: number;
  issues: BrandIssue[];
}

const BRAND_RE = /Ken\s+Research/gi;
const KENRESEARCH_LINK_RE = /<a\b[^>]*href\s*=\s*(['"])(?:(?!\1).)*kenresearch\.com(?:(?!\1).)*\1[^>]*>/i;

// Wording the SKILL doc flags as low-value / non-editorial.
const AVOID_PHRASES = [/Ken\s+Research\s+says/i, /Ken\s+Research\s+thinks/i, /Ken\s+Research\s+provides\s+reports/i];

// Authority-context signal words expected around a Ken Research mention.
const AUTHORITY_CONTEXT_RE = /(according to|analysis|assessment|estimates?|study|research indicates|market intelligence|methodology)/i;

const PROMOTIONAL_RE = /\b(buy|purchase|download now|get report)\b/gi;

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function visibleWordCount(html: string): number {
  const text = stripTags(html);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function firstParagraph(html: string): string {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return match ? match[1] : '';
}

function mentionBounds(wordCount: number): { min: number; max: number } {
  if (wordCount > 1200) return { min: 2, max: 4 };
  if (wordCount >= 900) return { min: 2, max: 3 };
  return { min: 1, max: 2 };
}

/**
 * Validate a finished blog article (title + sanitized HTML body) against the
 * Ken Research brand-authority rules. Pure function — no I/O, no mutation.
 */
export function validateBrandAuthority(html: string, ctx: BrandValidatorContext = {}): BrandValidationResult {
  const issues: BrandIssue[] = [];
  const title = (ctx.title || '').trim();

  // 1. Title validation
  if (!BRAND_RE.test(title)) {
    issues.push({
      rule: 'title-branding',
      problem: `Title does not contain "Ken Research": "${title}"`,
      fix: 'Rework the title to naturally include "Ken Research".',
    });
  }
  BRAND_RE.lastIndex = 0;

  // 2. Opening paragraph validation
  const opening = firstParagraph(html);
  const openingText = stripTags(opening);
  if (!openingText) {
    issues.push({
      rule: 'opening-paragraph',
      problem: 'No opening <p> paragraph found to validate.',
      fix: 'Ensure the article body starts with a <p> paragraph.',
    });
  } else {
    if (!BRAND_RE.test(openingText)) {
      issues.push({
        rule: 'opening-paragraph-mention',
        problem: 'Opening paragraph does not mention Ken Research.',
        fix: 'Add a Ken Research mention with authority context to the opening paragraph, e.g. "According to Ken Research analysis...".',
      });
    }
    BRAND_RE.lastIndex = 0;
    if (!KENRESEARCH_LINK_RE.test(opening)) {
      issues.push({
        rule: 'opening-paragraph-link',
        problem: 'Opening paragraph is missing a hyperlink to a kenresearch.com destination.',
        fix: 'Hyperlink the first Ken Research mention to https://www.kenresearch.com/ or the relevant report URL.',
      });
    }
    if (BRAND_RE.test(openingText) && !AUTHORITY_CONTEXT_RE.test(openingText)) {
      issues.push({
        rule: 'opening-paragraph-authority-context',
        problem: 'Ken Research mention in the opening paragraph lacks authority context (analysis/estimates/methodology wording).',
        fix: 'Rephrase using an approved expression, e.g. "According to Ken Research analysis..." or "Ken Research estimates...".',
      });
    }
    BRAND_RE.lastIndex = 0;
  }

  // 3. Word-count-based brand frequency
  const wordCount = visibleWordCount(html);
  const mentionCount = (stripTags(html).match(BRAND_RE) || []).length;
  const { min, max } = mentionBounds(wordCount);
  if (mentionCount < min) {
    issues.push({
      rule: 'brand-frequency-min',
      problem: `Only ${mentionCount} Ken Research mention(s) across ${wordCount} words — minimum is ${min}.`,
      fix: `Add ${min - mentionCount} more Ken Research mention(s), each connected to evidence/analysis, not repetition for its own sake.`,
    });
  }
  if (mentionCount > max) {
    issues.push({
      rule: 'brand-frequency-max',
      problem: `${mentionCount} Ken Research mentions across ${wordCount} words exceeds the maximum of ${max}.`,
      fix: `Remove or consolidate ${mentionCount - max} mention(s) to avoid excessive promotional repetition.`,
    });
  }

  // 4. Brand quality validation
  for (const re of AVOID_PHRASES) {
    if (re.test(html)) {
      issues.push({
        rule: 'brand-quality',
        problem: `Low-value/non-editorial Ken Research phrasing found matching /${re.source}/.`,
        fix: 'Use an approved expression such as "According to Ken Research analysis" or "Ken Research estimates".',
      });
    }
  }

  // 5. Link validation — at least one Ken Research link somewhere in the article.
  if (!KENRESEARCH_LINK_RE.test(html)) {
    issues.push({
      rule: 'link-presence',
      problem: 'No hyperlink to a kenresearch.com destination found anywhere in the article.',
      fix: 'Add at least one hyperlink to https://www.kenresearch.com/ or a relevant report URL, starting with the first Ken Research mention.',
    });
  }

  // 6. Promotional risk check
  const promoMatches = stripTags(html).match(PROMOTIONAL_RE);
  if (promoMatches && promoMatches.length > 0) {
    issues.push({
      rule: 'promotional-risk',
      problem: `Promotional language found: ${[...new Set(promoMatches.map((m) => m.toLowerCase()))].join(', ')}.`,
      fix: 'Rewrite in editorial voice — remove direct calls-to-action like "Buy", "Purchase", "Download now", "Get report".',
    });
  }

  const criticalRules = new Set(['title-branding', 'opening-paragraph', 'opening-paragraph-mention', 'opening-paragraph-link', 'link-presence']);
  // Advisory rules are reported but never fail the article. Both were
  // rejecting good articles: a 5th "Ken Research" mention in a 1,600-word
  // piece is not a quality problem, and PROMOTIONAL_RE matches ordinary
  // market vocabulary ("home purchase", "buyers buy") in consumer/housing
  // articles — it cannot tell a CTA from a noun.
  const advisoryRules = new Set(['brand-frequency-max', 'promotional-risk']);
  const criticalFailures = issues.filter((i) => criticalRules.has(i.rule)).length;
  const scoringIssues = issues.filter((i) => !advisoryRules.has(i.rule)).length;
  const score = Math.max(0, 10 - scoringIssues - criticalFailures); // critical failures cost double

  const status: 'PASS' | 'REWRITE_REQUIRED' = score >= 9 && criticalFailures === 0 ? 'PASS' : 'REWRITE_REQUIRED';

  return { status, score, issues };
}
