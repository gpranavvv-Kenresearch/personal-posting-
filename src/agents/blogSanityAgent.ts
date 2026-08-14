/**
 * blogSanityAgent.ts — post-generation cleanup pass for blog HTML.
 * Runs after ChatGPT generation (and cover-image injection) but BEFORE the
 * result is written into the sheet. Each rule is a small, independent
 * html -> html transform, applied in order — add new rules to RULES to
 * extend this later without touching the call sites.
 */

export interface BlogSanityContext {
  /** Used to build the fallback img alt text ("<title> market research"). */
  title?: string;
}

export interface BlogSanityResult {
  html: string;
  changes: string[];
}

// ---------------------------------------------------------------------------
// Rule 1 — normalize every <img> tag to the exact canonical shape:
//   <img src='URL' alt='ALT market research'/>
// (single-quoted attributes, self-closing, alt always ends with
// "market research"). Handles double-quoted/unquoted attrs, missing alt,
// extra attributes (width/height/class/etc.), and already-correct tags.
// ---------------------------------------------------------------------------
function normalizeImgTags(html: string, ctx: BlogSanityContext): { html: string; changed: boolean } {
  let changed = false;
  const fallbackAltBase = (ctx.title || '').trim();

  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/i);
    const altMatch = tag.match(/\balt\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/i);

    const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim();
    if (!src) return tag; // nothing to normalize against — leave untouched

    let altBase = (altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '').trim();
    if (!altBase) altBase = fallbackAltBase;
    // Strip a pre-existing "market research" suffix so we don't double it up.
    altBase = altBase.replace(/\s*market research\s*$/i, '').trim();
    const alt = altBase ? `${altBase} market research` : 'market research';

    const rebuilt = `<img src='${src}' alt='${alt}'/>`;
    if (rebuilt !== tag) changed = true;
    return rebuilt;
  });

  return { html: out, changed };
}

// ---------------------------------------------------------------------------
// Rule 2 — remove the "By Ken Research" byline paragraph, wherever it lands.
// ---------------------------------------------------------------------------
function removeByline(html: string): { html: string; changed: boolean } {
  let changed = false;
  let out = html.replace(/<p>\s*<em>\s*By\s+Ken\s+Research\s*<\/em>\s*<\/p>\s*/gi, () => {
    changed = true;
    return '';
  });
  // Fallback: a bare <em>By Ken Research</em> not wrapped in its own <p>.
  out = out.replace(/<em>\s*By\s+Ken\s+Research\s*<\/em>/gi, () => {
    changed = true;
    return '';
  });
  return { html: out, changed };
}

// ---------------------------------------------------------------------------
// Rule 3 — bold every numeric figure in the visible text (currency amounts,
// percentages, plain numbers, years), skipping text already inside <strong>
// and never touching HTML tags/attributes.
// ---------------------------------------------------------------------------
// The comma-grouped branch is tried first (e.g. "1,450"); the plain-digit
// fallback covers everything else, including bare 4+ digit years like
// "2025" that a \d{1,3}(,\d{3})* -only pattern would silently skip (no
// comma group present, and more than 3 digits in a row).
const NUMBER_RE = /(?<![\w'"=])(?:[$₹€£]\s?)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)%?(?:\s(?:billion|million|trillion|bn|mn))?(?!\w)/gi;

function boldAllNumbers(html: string): { html: string; changed: boolean } {
  let changed = false;
  const parts = html.split(/(<[^>]+>)/); // alternates: text, tag, text, tag, ...
  let strongDepth = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isTag = i % 2 === 1;

    if (isTag) {
      if (/^<strong[\s>]/i.test(part)) strongDepth++;
      else if (/^<\/strong>/i.test(part)) strongDepth = Math.max(0, strongDepth - 1);
      continue;
    }

    if (strongDepth > 0 || !part) continue;

    const boldedText = part.replace(NUMBER_RE, (match) => {
      changed = true;
      return `<strong>${match}</strong>`;
    });
    parts[i] = boldedText;
  }

  return { html: parts.join(''), changed };
}

// ---------------------------------------------------------------------------
// Rule 4 — strip the standard Disclaimer paragraph entirely. We add our own
// disclaimer/compliance footer downstream if a platform requires one; the
// model should not be appending its own.
// ---------------------------------------------------------------------------
function removeDisclaimer(html: string): { html: string; changed: boolean } {
  let changed = false;
  // The inner (?!<\/p>) guards stop the match from crossing into the NEXT
  // paragraph — without them, a non-greedy match starting at an earlier <p>
  // will happily swallow every paragraph up through the disclaimer's </p>.
  const out = html.replace(/<p>(?:(?!<\/p>)[\s\S])*?Disclaimer:(?:(?!<\/p>)[\s\S])*?<\/p>\s*/gi, () => {
    changed = true;
    return '';
  });
  return { html: out, changed };
}

type Rule = { name: string; run: (html: string, ctx: BlogSanityContext) => { html: string; changed: boolean } };

const RULES: Rule[] = [
  { name: 'normalize img tags', run: normalizeImgTags },
  { name: 'remove "By Ken Research" byline', run: removeByline },
  { name: 'bold every number', run: boldAllNumbers },
  { name: 'remove Disclaimer paragraph', run: removeDisclaimer },
  // Add future rules here — each one gets its own named entry in `changes`.
];

/** Runs every rule in order and returns the cleaned HTML plus a log of what actually changed. */
export function runBlogSanityChecks(html: string, ctx: BlogSanityContext = {}): BlogSanityResult {
  let current = html;
  const changes: string[] = [];

  for (const rule of RULES) {
    const result = rule.run(current, ctx);
    current = result.html;
    if (result.changed) changes.push(rule.name);
  }

  return { html: current, changes };
}
