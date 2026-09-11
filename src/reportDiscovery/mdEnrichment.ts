/**
 * mdEnrichment.ts — cheapest possible enrichment for a newly-discovered
 * report: fetch its `.md` twin (every /industry-reports/{slug} page has one
 * at the same URL + ".md", served as plain markdown) and pull the title +
 * KPIs-at-a-Glance line with two regexes. No Playwright, no HTML parsing —
 * this exists purely so 250 reports/day doesn't mean launching 250 headless
 * browsers/day just to log a title. For real content-generation-time
 * enrichment, the existing agents/reportDataAgent.ts (Playwright + Tavily)
 * remains the source of truth.
 */

const MARKET_VALUE_RE = /(\$[\d,.]+\s*(?:billion|million|trillion|B|M)\b|USD\s*[\d,.]+\s*(?:billion|million)\b)/i;
const CAGR_RE = /([\d]+\.?[\d]*\s*%\s*(?:CAGR|compound annual|growth rate))/i;

export interface MdEnrichment {
  title: string;
  marketValue: string;
  cagr: string;
}

export async function fetchReportMdSummary(reportUrl: string): Promise<MdEnrichment | null> {
  const mdUrl = `${reportUrl}.md`;
  try {
    const res = await fetch(mdUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KenResearchReportWatcher/1.0)' } });
    if (!res.ok) return null;
    const text = await res.text();

    const titleMatch = text.match(/^#\s+(.+)$/m);
    const marketValueMatch = text.match(MARKET_VALUE_RE);
    const cagrMatch = text.match(CAGR_RE);

    return {
      title: titleMatch?.[1]?.trim() ?? '',
      marketValue: marketValueMatch?.[1]?.trim() ?? '',
      cagr: cagrMatch?.[1]?.trim() ?? '',
    };
  } catch {
    return null; // best-effort — missing enrichment shouldn't block discovery
  }
}
