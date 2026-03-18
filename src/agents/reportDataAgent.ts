/**
 * reportDataAgent.ts — Ken Research Report Data Extractor
 *
 * Scrapes a Ken Research report URL to extract:
 *   - title
 *   - marketValue  (e.g. "$4.2 Billion")
 *   - cagr          (e.g. "12.5% CAGR")
 *   - forecastYear  (e.g. "2029")
 *   - keyStats      (up to 5 sentences with % or $ data)
 *
 * Step 1 — Playwright (primary):  headless Chrome, 15 s timeout
 * Step 2 — Tavily fallback:       if Playwright fails or finds nothing
 * Step 3 — Tavily enrichment:     fills any remaining empty fields
 */

import { chromium } from 'playwright';
import { callTavily } from '../config/tavilyClient.js';

export interface ReportData {
  title: string;
  marketValue: string;   // "$4.2 Billion" | ""
  cagr: string;          // "12.5% CAGR"  | ""
  forecastYear: string;  // "2029"         | ""
  keyStats: string[];    // up to 5 fact-sentences
  source: 'playwright' | 'tavily' | 'none';
}

// ── Regex helpers ──────────────────────────────────────────────────────────

const MARKET_VALUE_RE = /(\$[\d,.]+\s*(?:billion|million|trillion|B|M)\b|USD\s*[\d,.]+\s*(?:billion|million)\b)/i;
const CAGR_RE         = /([\d]+\.?[\d]*\s*%\s*(?:CAGR|compound annual|growth rate))/i;
const FORECAST_YEAR_RE = /\b(20(?:2[5-9]|3\d))\b/;

function extractFromText(text: string): Pick<ReportData, 'marketValue' | 'cagr' | 'forecastYear' | 'keyStats'> {
  const marketValueMatch = text.match(MARKET_VALUE_RE);
  const cagrMatch        = text.match(CAGR_RE);

  // Forecast year — prefer one that appears near "forecast", "by", "reach", "2029 level" etc.
  let forecastYear = '';
  const yearContextRe = /(?:forecast|by|reach|project|expect|grow to|valued at|by year)\s+(?:20(?:2[5-9]|3\d))|(?:20(?:2[5-9]|3\d))\s*(?:forecast|level|period|end|target)/gi;
  const ctxMatch = text.match(yearContextRe);
  if (ctxMatch) {
    const yrMatch = ctxMatch[0].match(FORECAST_YEAR_RE);
    if (yrMatch) forecastYear = yrMatch[1];
  }
  // fallback — first bare year found
  if (!forecastYear) {
    const bare = text.match(FORECAST_YEAR_RE);
    if (bare) forecastYear = bare[1];
  }

  // Key stats: sentences containing $ or % or USD, max 5
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20 && s.length < 300 && /[\$%]|USD/.test(s));
  const keyStats = [...new Set(sentences)].slice(0, 5);

  return {
    marketValue:  marketValueMatch ? marketValueMatch[1].trim() : '',
    cagr:         cagrMatch        ? cagrMatch[1].trim()        : '',
    forecastYear,
    keyStats,
  };
}

function hasUsefulData(d: Pick<ReportData, 'marketValue' | 'cagr'>): boolean {
  return !!(d.marketValue || d.cagr);
}

// ── Step 1: Playwright scrape ──────────────────────────────────────────────

async function scrapeWithPlaywright(reportUrl: string): Promise<{ title: string; text: string } | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    const data = await page.evaluate(() => {
      const title =
        document.querySelector('h1')?.innerText?.trim() ||
        document.title?.trim() ||
        '';

      const SKIP = new Set(['SCRIPT', 'STYLE', 'NAV', 'FOOTER', 'HEADER', 'NOSCRIPT']);
      const TARGET_TAGS = new Set(['P', 'LI', 'TD', 'H2', 'H3', 'H4', 'SPAN', 'DIV']);

      const chunks: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || SKIP.has(parent.tagName)) continue;
        if (!TARGET_TAGS.has(parent.tagName)) continue;
        const text = node.textContent?.trim();
        if (text && text.length > 25) chunks.push(text);
        if (chunks.length >= 150) break;
      }
      return { title, text: chunks.join(' ') };
    });

    await browser.close();
    console.log(`   🔬 Playwright scraped: ${data.text.length} chars`);
    return data;
  } catch (err: any) {
    console.warn(`   ⚠️  Playwright scrape failed: ${err.message}`);
    try { await browser?.close(); } catch { /* ignore */ }
    return null;
  }
}

// ── Step 2: Tavily fallback scrape ─────────────────────────────────────────

async function scrapeWithTavily(reportUrl: string): Promise<{ title: string; text: string }> {
  console.log(`   🌐 Tavily fallback scrape: ${reportUrl}`);
  const res = await callTavily({
    query: reportUrl,
    search_depth: 'advanced',
    include_raw_content: false,
    max_results: 2,
    include_domains: ['kenresearch.com'],
  });

  const parts = res.results.map(r => r.content ?? '').join(' ');
  const title = res.results[0]?.title ?? '';
  return { title, text: parts };
}

// ── Step 3: Tavily enrichment ──────────────────────────────────────────────

async function enrichWithTavily(
  title: string,
  current: Pick<ReportData, 'marketValue' | 'cagr'>,
): Promise<Pick<ReportData, 'marketValue' | 'cagr' | 'forecastYear' | 'keyStats'>> {
  const enriched: Pick<ReportData, 'marketValue' | 'cagr' | 'forecastYear' | 'keyStats'> = {
    marketValue:  current.marketValue,
    cagr:         current.cagr,
    forecastYear: '',
    keyStats:     [],
  };

  if (!title) return enriched;

  // Query 1 — market size
  if (!enriched.marketValue) {
    try {
      const res = await callTavily({
        query: `${title} market size 2024 2025`,
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
      });
      const combined = [res.answer ?? '', ...res.results.map(r => r.content ?? '')].join(' ');
      const extracted = extractFromText(combined);
      if (extracted.marketValue) {
        enriched.marketValue = extracted.marketValue;
        console.log(`   🔑 Enriched market value: ${enriched.marketValue}`);
      }
      if (!enriched.keyStats.length) enriched.keyStats = extracted.keyStats;
      if (!enriched.forecastYear)    enriched.forecastYear = extracted.forecastYear;
    } catch (err: any) {
      console.warn(`   ⚠️  Tavily market size enrichment failed: ${err.message}`);
    }
  }

  // Query 2 — CAGR
  if (!enriched.cagr) {
    try {
      const res = await callTavily({
        query: `${title} CAGR growth rate forecast`,
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
      });
      const combined = [res.answer ?? '', ...res.results.map(r => r.content ?? '')].join(' ');
      const extracted = extractFromText(combined);
      if (extracted.cagr) {
        enriched.cagr = extracted.cagr;
        console.log(`   🔑 Enriched CAGR: ${enriched.cagr}`);
      }
      if (!enriched.forecastYear && extracted.forecastYear) enriched.forecastYear = extracted.forecastYear;
      if (!enriched.keyStats.length && extracted.keyStats.length) enriched.keyStats = extracted.keyStats;
    } catch (err: any) {
      console.warn(`   ⚠️  Tavily CAGR enrichment failed: ${err.message}`);
    }
  }

  return enriched;
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function extractReportData(reportUrl: string): Promise<ReportData> {
  console.log(`\n📊 Report Data Extraction: ${reportUrl}`);

  const empty: ReportData = {
    title: '', marketValue: '', cagr: '', forecastYear: '', keyStats: [], source: 'none',
  };

  // Step 1 — Playwright
  let title = '';
  let rawText = '';
  let source: ReportData['source'] = 'none';

  const pw = await scrapeWithPlaywright(reportUrl);
  if (pw && pw.text.length > 100) {
    title   = pw.title;
    rawText = pw.text;
    source  = 'playwright';
  }

  // Step 2 — Tavily fallback
  if (!rawText || rawText.length < 100) {
    try {
      const tv = await scrapeWithTavily(reportUrl);
      if (tv.text.length > 50) {
        if (!title) title = tv.title;
        rawText = tv.text;
        source  = 'tavily';
      }
    } catch (err: any) {
      console.warn(`   ⚠️  Tavily fallback failed: ${err.message}`);
    }
  }

  if (!rawText) {
    console.warn(`   ⚠️  No content extracted — returning empty ReportData`);
    return empty;
  }

  // Extract from scraped text
  let extracted = extractFromText(rawText);
  console.log(`   📈 Extracted — value: "${extracted.marketValue}" | cagr: "${extracted.cagr}" | year: "${extracted.forecastYear}" | stats: ${extracted.keyStats.length}`);

  // Step 3 — Tavily enrichment for any still-empty fields (market value OR cagr)
  if (!extracted.marketValue || !extracted.cagr) {
    const missing = [!extracted.marketValue && 'marketValue', !extracted.cagr && 'CAGR'].filter(Boolean).join(', ');
    console.log(`   🔍 Enriching via Tavily (missing: ${missing})...`);
    extracted = await enrichWithTavily(title, extracted);
  }

  const result: ReportData = {
    title,
    marketValue:  extracted.marketValue,
    cagr:         extracted.cagr,
    forecastYear: extracted.forecastYear,
    keyStats:     extracted.keyStats,
    source,
  };

  console.log(`   ✅ Report data ready (source: ${source}) — value: "${result.marketValue}" | cagr: "${result.cagr}"`);
  return result;
}
