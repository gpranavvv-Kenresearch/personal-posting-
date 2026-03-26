import { callOpenRouter } from '../config/openRouterClient.js';
import { callTavily } from '../config/tavilyClient.js';
import { chromium } from 'playwright';
import 'dotenv/config';
import { extractReportData } from './reportDataAgent.js';

const OPENROUTER_MODEL = 'google/gemini-2.0-flash-001';

// ── UTM helper ─────────────────────────────────────────────────────────────
// Strips any existing UTM params then appends the correct ones for the platform.

const UTM_PARAMS: Record<'x' | 'facebook' | 'linkedin', string> = {
  x:        'utm_source=X&utm_medium=social_organic&utm_campaign=Automation',
  facebook: 'utm_source=Facebook&utm_medium=social_organic&utm_campaign=Automation',
  linkedin: 'utm_source=Linkedin&utm_medium=social_organic&utm_campaign=Automation',
};

export function buildUtmUrl(targetUrl: string, platform: 'x' | 'facebook' | 'linkedin'): string {
  // Remove any existing utm_* params
  let base = targetUrl;
  try {
    const u = new URL(targetUrl);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(k => u.searchParams.delete(k));
    base = u.toString().replace(/\?$/, '');  // strip trailing '?' if params now empty
  } catch {
    base = targetUrl.split('?')[0];  // fallback: strip everything after ?
  }
  return `${base}?${UTM_PARAMS[platform]}`;
}

// ── Tavily: fetch latest web stats for a report topic ─────────────────────
// Used to inject real current data into the tweet generation prompt.

async function fetchWebStats(title: string, targetUrl: string): Promise<string> {
  try {
    const query = title
      ? `${title} market size statistics 2024 2025`
      : `${targetUrl.split('/').filter(Boolean).pop()?.replace(/-/g, ' ')} market statistics`;

    const res = await callTavily({
      query,
      search_depth: 'basic',
      include_answer: true,
      max_results: 3,
    });

    const snippets: string[] = [];

    // Prefer the direct answer summary if available
    if (res.answer && res.answer.trim().length > 20) {
      snippets.push(res.answer.trim());
    }

    // Pull top sentences containing numbers/percentages from results
    for (const r of res.results) {
      const sentences = r.content.split(/[.!?]/).filter(s =>
        /\d/.test(s) && s.trim().length > 20 && s.trim().length < 200
      );
      if (sentences.length > 0) snippets.push(sentences[0].trim());
      if (snippets.length >= 3) break;
    }

    if (snippets.length === 0) return '';

    console.log(`   🌐 Tavily stats found: ${snippets.length} data point(s)`);
    return snippets.join(' ');
  } catch (err: any) {
    console.warn(`   ⚠️  Tavily stats fetch failed: ${err.message}`);
    return '';
  }
}

// ── Tavily: scrape report content as fallback if Playwright fails ─────────

async function fetchReportViaTavily(reportUrl: string): Promise<{ title: string; text: string }> {
  console.log(`   🌐 Tavily fallback scrape: ${reportUrl}`);
  const res = await callTavily({
    query: reportUrl,
    search_depth: 'advanced',
    include_raw_content: false,
    max_results: 1,
    include_domains: ['kenresearch.com'],
  });

  const top = res.results[0];
  if (!top) return { title: '', text: '' };

  return {
    title: top.title ?? '',
    text:  top.content ?? '',
  };
}

// ── Generate tweet from Google Sheet row (matches n8n AI Agent prompt) ─────

export async function generateTweetFromSheetRow(params: {
  targetUrl: string;
  marketValue?: string;
  title?: string;
  cagr?: string;
  keyStats?: string[];
}): Promise<string> {
  const { targetUrl, title = '' } = params;
  const xUrl = buildUtmUrl(targetUrl, 'x');
  let marketValue = '';
  let cagr = '';
  let keyStats: string[] = [];

  console.log(`   Generating tweet for: ${targetUrl}`);

  // Always fetch stats from Tavily/reportDataAgent — never read from sheet
  try {
    const reportData = await extractReportData(targetUrl);
    if (reportData.marketValue) marketValue = reportData.marketValue;
    if (reportData.cagr)        cagr        = reportData.cagr;
    if (reportData.keyStats.length) keyStats = reportData.keyStats;
  } catch (err: any) {
    console.warn(`   ⚠️  reportDataAgent failed: ${err.message}`);
  }

  // Fetch latest web stats via Tavily to ground the AI in real current data
  const webStats = await fetchWebStats(title, targetUrl);
  if (webStats) {
    console.log(`   📊 Web stats injected into prompt`);
  }

  // Build report data context for the prompt
  const reportContext: string[] = [];
  if (marketValue) reportContext.push(`Market value: ${marketValue}`);
  if (cagr)        reportContext.push(`CAGR: ${cagr}`);
  if (keyStats.length) reportContext.push(`Key stats: ${keyStats.slice(0, 3).join(' | ')}`);
  const reportContextStr = reportContext.join('\n');

  const response = await callOpenRouter({
    model: OPENROUTER_MODEL,
    max_tokens: 400,
    system: `You are a market research copywriter for X (Twitter). Write tweets that feel like sharp insider intel.

EXAMPLE of the exact style to match:
"🌽 Vietnam's corn fiber market is worth $1.1B and growing fast. New policy mandates 30% biodegradable content in packaging by 2025—full transition by 2030. Sustainable materials are no longer optional. https://kenresearch.com/example-report?utm_source=X&utm_medium=social_organic&utm_campaign=Automation #SustainableTextiles #GreenInnovation"

Note: The URL above is long but X counts it as only 23 characters. The tweet above is valid and under 280 chars.

WHAT MAKES THAT TWEET WORK:
- Opens with 1 relevant emoji
- Names the market + gives a real dollar figure right away
- Drops a specific data point (policy, %, deadline, or trend)
- Ends with a short punchy declarative statement (no question marks)
- Single flowing paragraph — no line breaks in the main text
- 2 hashtags at the very end

YOUR FORMAT (follow exactly):
[emoji] [Market context + value if available]. [Specific data point — policy/%, driver, deadline]. [1-sentence punchy closer.] ${xUrl} #[Tag1] #[Tag2]

IMPORTANT: The URL for this tweet is: ${xUrl} — copy it exactly as written. Do not shorten, alter, or paraphrase it.

STEP 1 — Identify the topic from the URL:
- Take the last path segment, replace hyphens with spaces
- Strip filler words: global world asia asean sea southeast eastern western northern southern europe usa uk india china japan korea gulf mena latam apac africa pacific atlantic nordic gcc cis anz market industry report analysis size forecast
- What remains is the core topic (e.g. "corn fiber", "electric vehicles", "solar panels")

STEP 2 — Write the tweet content (the part before the URL):
- Start: [emoji] [Region/country if relevant]'s [topic] market [brief factual statement].
- Middle: 1 specific insight — a key driver, adoption trend, or industry shift. Keep it under 80 chars.
- Closer: 1 punchy declarative sentence. Max 8 words. No question marks.
- NEVER use these words: reshaping, accelerating, evolving, transforming, booming, skyrocketing, surging, soaring, rapidly growing, growing fast, fast-growing
- NEVER invent numbers, percentages, or stats — not even plausible-sounding ones. If no market_value is given, write qualitative statements only (e.g. "demand is rising", "operators are shifting strategies").

MARKET VALUE: ${marketValue}
- If a real number is provided, include it in the opening line.
- If empty, skip it — do not invent figures.

STRICT CHARACTER BUDGET:
X limit = 280 chars. URLs always count as 23 chars regardless of length.

THE ONE RULE: The text you write before the URL must be ≤ 200 characters (including the emoji and the trailing space before the URL).

After the URL, hashtags take ~35 chars. So your full tweet = 200 (text) + 23 (URL) + 35 (hashtags) = 258 chars. Safe.

Sentence length guide to stay under 200 chars:
  Sentence 1 (market + value): max 80 chars
  Sentence 2 (data point/driver): max 70 chars
  Sentence 3 (punchy closer): max 45 chars
  Total: 195 chars ✓

Count your text before the URL. If over 200, trim sentence 2 first, then sentence 1.

OUTPUT RULES:
- Output ONLY the final tweet. No labels, no explanation, no JSON, no markdown.
- Single paragraph — no line breaks anywhere in the tweet.
- Exactly 1 emoji at the start, 2 hashtags at the end, URL just before hashtags.
- Do not repeat the same hook structure across different tweets.`,
    messages: [{
      role: 'user',
      content: `Generate the X post.\nURL to use in tweet: ${xUrl}${reportContextStr ? `\n\nReport data (use these real figures — do NOT invent additional numbers):\n${reportContextStr}` : ''}${webStats ? `\n\nRecent web data:\n${webStats}` : ''}`,
    }],
  });

  let tweet = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

  // Compute X character count: URLs always count as 23 chars
  const xCount = (raw: string) => {
    const urlRegex = /https?:\/\/\S+/g;
    const urls = raw.match(urlRegex) || [];
    let count = raw.length;
    for (const url of urls) count += 23 - url.length;
    return count;
  };

  // If over 280, trim the content before the URL by removing whole sentences
  if (xCount(tweet) > 280) {
    console.warn(`   ⚠️  Over limit (${xCount(tweet)} X-chars) — trimming...`);
    const urlMatch = tweet.match(/https?:\/\/\S+/);
    if (urlMatch) {
      const urlIndex = tweet.indexOf(urlMatch[0]);
      let before = tweet.slice(0, urlIndex).trim();
      const after = tweet.slice(urlIndex).trim(); // URL + hashtags

      // Remove sentences from the end of 'before' until within budget
      while (xCount(before + ' ' + after) > 280 && before.includes('.')) {
        // Drop last sentence
        const lastDot = before.lastIndexOf('.', before.length - 2);
        before = lastDot > 0 ? before.slice(0, lastDot + 1).trim() : before.slice(0, -1).trim();
      }
      tweet = before + ' ' + after;
    }
  }

  const count = xCount(tweet);
  console.log(`   ✅ Tweet generated (${tweet.length} raw chars, ${count} X-chars)`);
  if (count > 280) console.warn(`   ⚠️  Still ${count} X-chars after trimming — check manually`);

  return tweet;
}

// ── Generate tweet from a specific report URL (scrapes page for stats) ─────

export async function generateTweetFromReport(
  reportUrl: string
): Promise<{ tweet: string; sourceArticle: string }> {
  console.log(`   Scraping report: ${reportUrl}`);

  let reportTitle = '';
  let extractedText = '';

  // Try Playwright first — faster and richer. Fall back to Tavily if it fails/times out.
  let playwrightOk = false;
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => {
      const title =
        document.querySelector('h1')?.innerText?.trim() ||
        document.title?.trim() || '';

      const skipTags = new Set(['SCRIPT', 'STYLE', 'NAV', 'FOOTER', 'HEADER']);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const chunks: string[] = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || skipTags.has(parent.tagName)) continue;
        const text = node.textContent?.trim();
        if (text && text.length > 30) chunks.push(text);
      }
      return { title, text: chunks.slice(0, 80).join(' ') };
    });

    await browser.close();
    reportTitle = data.title;
    extractedText = data.text;
    console.log(`   Report title: ${reportTitle}`);
    playwrightOk = true;
  } catch (err) {
    console.log('   Playwright scraping failed — trying Tavily fallback...');
  }

  // Tavily fallback: fetch page content via web search if Playwright failed
  if (!playwrightOk) {
    try {
      const tavilyData = await fetchReportViaTavily(reportUrl);
      if (tavilyData.title || tavilyData.text) {
        reportTitle = tavilyData.title || 'Ken Research Market Report';
        extractedText = tavilyData.text;
        console.log(`   ✅ Tavily fallback succeeded — title: ${reportTitle}`);
      } else {
        reportTitle = 'Ken Research Market Report';
      }
    } catch (tavilyErr: any) {
      console.log(`   ⚠️  Tavily fallback also failed: ${tavilyErr.message}`);
      reportTitle = 'Ken Research Market Report';
    }
  }

  const tweet = await generateTweetFromSheetRow({
    targetUrl: reportUrl,
    title: reportTitle,
    marketValue: '',
  });

  return { tweet, sourceArticle: reportTitle };
}

// ── Default: scrape latest blog post ──────────────────────────────────────

export async function generateTweet(): Promise<{ tweet: string; sourceArticle: string }> {
  console.log('   Fetching Ken Research blog...');

  let articleTitle = '';
  let articleUrl = 'https://www.kenresearch.com/blog/';

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://www.kenresearch.com/blog/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const articles = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(a => a.href.includes('/blog/') && a.innerText.trim().length > 20)
        .slice(0, 5)
        .map(a => ({ title: a.innerText.trim(), url: a.href }));
    });

    await browser.close();

    if (articles.length > 0) {
      articleTitle = articles[0].title;
      articleUrl = articles[0].url;
      console.log(`   Found: ${articleTitle}`);
    } else {
      articleTitle = 'Market Research Trends 2025';
    }
  } catch {
    console.log('   Scraping failed, using fallback...');
    articleTitle = 'Market Research Trends 2025';
  }

  const tweet = await generateTweetFromSheetRow({ targetUrl: articleUrl, title: articleTitle });
  return { tweet, sourceArticle: articleTitle };
}

export async function generateBlogFromKen(
  reportUrl: string,
  reportTitle: string
): Promise<{ blog: string; sourceUrl: string }> {
  console.log('   Fetching Ken Research report page...');

  let html = '';
  try {
    const res = await fetch(reportUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    html = await res.text();
  } catch (err) {
    console.error('   Failed to fetch:', err);
  }

  const response = await callOpenRouter({
    model: OPENROUTER_MODEL,
    max_tokens: 1400,
    messages: [{
      role: 'user',
      content: `You are a senior market research analyst writing for Ken Research.
Report title: "${reportTitle}"
Requirements: 700-900 words, strong intro, 3-5 sections with subheadings, concrete insights, professional tone.
Return ONLY valid JSON: {"blog": "...", "sourceUrl": "${reportUrl}"}
HTML: ${html.slice(0, 6000)}`,
    }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  const clean = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error('Claude did not return valid JSON for blog generation.');
  }
}

// ── Generate LinkedIn post from a report URL ───────────────────────────────

export async function generateLinkedInPost(
  targetUrl: string,
  title?: string,
  marketValue?: string,
  cagr?: string,
  keyStats?: string[],
): Promise<string> {
  console.log(`   Generating LinkedIn post for: ${targetUrl}`);
  const liUrl = buildUtmUrl(targetUrl, 'linkedin');

  let mv = '';
  let cr = '';
  let ks: string[] = [];

  // Always fetch stats from Tavily/reportDataAgent — never read from sheet
  try {
    const reportData = await extractReportData(targetUrl);
    if (reportData.marketValue) mv = reportData.marketValue;
    if (reportData.cagr)        cr = reportData.cagr;
    if (reportData.keyStats.length) ks = reportData.keyStats;
  } catch (err: any) {
    console.warn(`   ⚠️  reportDataAgent failed: ${err.message}`);
  }

  const reportLines: string[] = [];
  if (mv) reportLines.push(`Market value: ${mv}`);
  if (cr) reportLines.push(`CAGR: ${cr}`);
  if (ks.length) reportLines.push(`Key stats: ${ks.slice(0, 3).join(' | ')}`);
  const reportContext = reportLines.join('\n');

  const response = await callOpenRouter({
    model: OPENROUTER_MODEL,
    max_tokens: 900,
    system: `You are a senior market research analyst writing thought-leadership posts for LinkedIn on behalf of Ken Research.

OUTPUT FORMAT — follow this structure exactly, using real blank lines between sections:

[One sharp, declarative hook sentence stating the core market insight. No emoji. No fluff. Must make a professional stop scrolling.]

[Short paragraph of 2-3 sentences: set the context. What industry/market is this? What is driving it? What does it mean for businesses or investors?]

Key Takeaways:
• [Concrete insight, trend, or implication — lead with data or fact, explain why it matters. Under 20 words.]
• [Second bullet]
• [Third bullet]
• [Optional fourth bullet]
• [Optional fifth bullet]

[One closing sentence — forward-looking statement or professional call to action — followed by the exact URL from the user message on the same or next line.]

[5-8 relevant hashtags on the final line, mix of broad and niche]

TONE: Authoritative, analytical, peer-to-peer. Write like a VP of Strategy sharing insight with their network, not like a marketing email.

RULES:
- Total length: 200-350 words
- NEVER invent statistics. If no market value is given, write qualitative insights only.
- Forbidden words: reshaping, accelerating, transforming, booming, game-changer, disrupting, revolutionizing, skyrocketing
- The URL must be copied exactly as given in the user message — do not alter it
- No markdown formatting (no **, no ##) — plain text only
- No bracket labels like [blank line], [HOOK], [KEY TAKEAWAYS] in your output — just the actual content`,
    messages: [
      {
        role: 'user',
        content: `Write a LinkedIn post.\nURL to include in post: ${liUrl}\nReport title: ${title || ''}${reportContext ? `\n${reportContext}` : ''}`,
      },
    ],
  });

  let post = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

  // Post-process: strip formatting artifacts that sometimes leak from prompts
  post = post
    .replace(/\[blank line\]/gi, '')
    .replace(/\[[^\]]{1,40}\]/g, '')          // any remaining short bracket labels
    .replace(/\n{3,}/g, '\n\n')               // 3+ blank lines → max 2
    .trim();

  console.log(`   ✅ LinkedIn post generated (${post.length} chars)`);
  return post;
}

// ── Generate Facebook post from a report URL ──────────────────────────────

export async function generateFacebookPost(
  targetUrl: string,
  title?: string,
  marketValue?: string,
  nickname?: string,
  cagr?: string,
  keyStats?: string[],
): Promise<string> {
  console.log(`   Generating Facebook post for: ${targetUrl}`);

  let mv = '';
  let cr = '';
  let ks: string[] = [];

  // Always fetch stats from Tavily/reportDataAgent — never read from sheet
  try {
    const reportData = await extractReportData(targetUrl);
    if (reportData.marketValue) mv = reportData.marketValue;
    if (reportData.cagr)        cr = reportData.cagr;
    if (reportData.keyStats.length) ks = reportData.keyStats;
  } catch (err: any) {
    console.warn(`   ⚠️  reportDataAgent failed: ${err.message}`);
  }

  const reportLines: string[] = [];
  if (mv) reportLines.push(`Market value: ${mv}`);
  if (cr) reportLines.push(`CAGR: ${cr}`);
  if (ks.length) reportLines.push(`Key stats: ${ks.slice(0, 3).join(' | ')}`);
  const reportContext = reportLines.join('\n');

  // Build UTM URL for the closing CTA
  const utmUrl = buildUtmUrl(targetUrl, 'facebook');

  const response = await callOpenRouter({
    model: OPENROUTER_MODEL,
    max_tokens: 700,
    system: `You are a writer creating Facebook posts for Ken Research's page. Ken Research publishes market research reports.

OUTPUT FORMAT — follow this structure exactly, using real blank lines between sections:

[Opening line — one relatable question OR surprising everyday observation connected to the market topic. Use 1-2 emojis naturally. Under 20 words. Must make a general audience curious, not just industry insiders.]

[Body — 2 to 3 short paragraphs, each 2-3 sentences. Tell a mini-story or explain the trend in plain English. Avoid jargon. Write like explaining this to a curious friend, not a boardroom.]

For deeper insights into market size, competitive benchmarking, segment analysis, and forecasts, explore the full research report here: {{UTM_URL}}

[8-12 relevant hashtags on one line. Mix broad industry tags with specific topic tags.]

TONE: Warm, curious, accessible. Not corporate. Not salesy. Think Facebook page for a smart magazine, not a press release.

RULES:
- Total length: 150-250 words
- Use 3-5 emojis total, placed naturally in the body (not all at the start)
- NEVER invent statistics. If no market value given, write qualitative content only.
- Forbidden words: reshaping, transforming, game-changer, disrupting, revolutionizing
- FORBIDDEN CHARACTERS: em dash, en dash. Use a comma or period instead.
- Plain text only — no markdown, no bold, no bracket labels like [blank line] or [Opening]
- Replace {{UTM_URL}} with the exact URL provided in the user message`,
    messages: [
      {
        role: 'user',
        content: `Write a Facebook post.\nURL: ${targetUrl}\nUTM URL for closing CTA: ${utmUrl}\nReport title: ${title || ''}${reportContext ? `\n${reportContext}` : ''}`,
      },
    ],
  });

  let post = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

  // Post-process: strip formatting artifacts that sometimes leak from prompts
  post = post
    .replace(/\[blank line\]/gi, '')          // literal "[blank line]" → remove
    .replace(/\[opening[^\]]*\]/gi, '')        // "[Opening line]" labels → remove
    .replace(/\[body[^\]]*\]/gi, '')           // "[Body]" labels → remove
    .replace(/\[hashtag[^\]]*\]/gi, '')        // "[Hashtag]" labels → remove
    .replace(/\[[^\]]{1,40}\]/g, '')           // any remaining short bracket labels → remove
    .replace(/[—–]/g, ',')                    // em/en dashes → comma
    .replace(/\n{3,}/g, '\n\n')               // 3+ blank lines → max 2
    .trim();

  console.log(`   ✅ Facebook post generated (${post.length} chars)`);
  return post;
}