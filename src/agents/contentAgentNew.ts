/**
 * contentAgentNew.ts — Content Generation Agent
 * Generates platform-specific posts using OpenRouter.
 *
 * Functions:
 *   generateTweet()   — used by X batch
 *   generateFbPost()  — used by FB batch
 *   generateLiPost()  — used by LI batch
 *   runContentAgent() — legacy: generates all 4 at once (for weekly recheck)
 */

import fs from 'fs';
import path from 'path';
import type { SheetRow } from '../sheets/sheets.js';
import { UTM_PARAMS, injectUTM } from '../utils/utm.js';
import { callTavily } from '../config/tavilyClient.js';

// ── Tweet history (per URL) ────────────────────────────────────────────────────
// Stores up to 5 past tweets per URL so the LLM can avoid repeating angles.

const TWEET_HISTORY_FILE = path.resolve('.sessions/tweet-history.json');
const MAX_HISTORY = 5;

function loadTweetHistory(): Record<string, string[]> {
  try { return JSON.parse(fs.readFileSync(TWEET_HISTORY_FILE, 'utf-8')); }
  catch { return {}; }
}

function getPastTweets(url: string): string[] {
  const all = loadTweetHistory();
  return all[url] ?? [];
}

function saveTweetToHistory(url: string, tweet: string): void {
  try {
    const all = loadTweetHistory();
    const list = all[url] ?? [];
    list.push(tweet);
    // Keep only the last MAX_HISTORY entries
    all[url] = list.slice(-MAX_HISTORY);
    fs.mkdirSync(path.dirname(TWEET_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(TWEET_HISTORY_FILE, JSON.stringify(all, null, 2));
  } catch { /* non-critical */ }
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const OPENROUTER_MODEL = 'openai/gpt-oss-120b:free';
const NVIDIA_MODEL = 'meta/llama-3.1-70b-instruct';

interface ApiKey {
  key: string;
  baseUrl: string;
  model: string;
  label: string;
}

export interface ContentResult {
  tweet: string;
  fbPost: string;
  liPost: string;
  blog: string;
  seoScore: number;
  sanityIssues: string[];
}

export interface ContentParams {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
  marketValue?: string;
  row?: SheetRow;
}

// ── Unified API key pool ───────────────────────────────────────────────────────
// OpenRouter keys (1-12) + NVIDIA keys — all in one flat pool, no fallback concept.

function buildKeyPool(): ApiKey[] {
  const pool: ApiKey[] = [];

  for (let i = 1; i <= 15; i++) {
    const k = process.env[`OPENROUTER_API_KEY_${i}`]?.trim();
    if (k) pool.push({ key: k, baseUrl: OPENROUTER_BASE_URL, model: OPENROUTER_MODEL, label: `OpenRouter-${i}` });
  }

  for (let i = 1; i <= 4; i++) {
    const envKey = i === 1 ? 'NVIDIA_API_KEY' : `NVIDIA_API_KEY_${i}`;
    const k = process.env[envKey]?.trim();
    if (k) pool.push({ key: k, baseUrl: NVIDIA_BASE_URL, model: NVIDIA_MODEL, label: `NVIDIA-${i}` });
  }

  return pool;
}

// ── Core LLM caller ────────────────────────────────────────────────────────────
// Rotates through all keys (OpenRouter + NVIDIA) as one pool — no fallback.

async function callLLM(prompt: string, maxTokens = 512): Promise<string> {
  const pool = buildKeyPool();
  if (pool.length === 0) throw new Error('No API keys found. Set OPENROUTER_API_KEY_1…_12 or NVIDIA_API_KEY in .env');

  for (let i = 0; i < pool.length; i++) {
    const { key, baseUrl, model, label } = pool[i];
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.7,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (res.status === 402 || res.status === 429) {
        console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): ${res.status === 402 ? 'no credits' : 'rate limited'} — rotating`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): status ${res.status} → ${text.slice(0, 80)} — rotating`);
        continue;
      }

      const json = await res.json() as { choices: Array<{ message: { content: string } }> };
      const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
      const text = raw.replace(/\s*—\s*/g, ' ').replace(/–/g, '-').trim();
      if (text) return text;
    } catch (err: any) {
      console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): ${err.message} — rotating`);
      continue;
    }
  }

  throw new Error('All API keys exhausted (OpenRouter + NVIDIA). Add credits or new keys.');
}

// ── Market data fetcher ────────────────────────────────────────────────────────
// Searches Tavily for market size, CAGR, and top competitors. Returns a compact
// context string injected into LLM prompts. Returns empty string on failure.

async function fetchMarketData(title: string): Promise<string> {
  try {
    const query = `${title} market size CAGR value 2024 2025 2030 competition`;
    const res = await callTavily({ query, search_depth: 'basic', include_answer: true, max_results: 3 });
    const snippets: string[] = [];
    if (res.answer) snippets.push(res.answer);
    for (const r of res.results.slice(0, 2)) {
      if (r.content) snippets.push(r.content.slice(0, 300));
    }
    return snippets.join(' | ').slice(0, 800);
  } catch {
    return '';
  }
}

// ── Platform-specific generators ───────────────────────────────────────────────

/**
 * Generate a tweet for a Ken Research report using the exact brand format.
 * The UTM URL is injected directly into the prompt — the LLM outputs it verbatim.
 * Text content (excl. URL) must be ≤ 180 chars; X counts every URL as 23 chars.
 */
export async function generateTweet(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
  marketValue?: string;
  overLimitBy?: number; // if set, tighten the char limit by this amount
}): Promise<string> {
  const utmUrl = `${params.url}${UTM_PARAMS.X}`;

  const mv = (params.marketValue ?? '').trim();
  const marketValueLine = mv && mv !== '0' && mv !== 'null'
    ? mv
    : '(not available — skip any market size number)';

  const marketData = await fetchMarketData(params.title);
  const marketDataSection = marketData
    ? `REAL MARKET DATA (from web search — use specific numbers if present):\n${marketData}`
    : 'No web data available — use general market language.';

  const pastTweets = getPastTweets(params.url);
  const pastTweetsSection = pastTweets.length > 0
    ? `──────────────────────
PREVIOUSLY POSTED TWEETS FOR THIS URL (${pastTweets.length} total) — DO NOT reuse:
- Same opening word or phrase
- Same CTA phrase
- Same power phrase
- Same sentence structure or angle

Past tweets:
${pastTweets.map((t, i) => `[${i + 1}] ${t}`).join('\n')}
──────────────────────`
    : '';

  const prompt = `You are a market insights social media writer for X (Twitter).

STEP 1 – Extract the market name from this URL:
${params.url}

Rules:
- Take only the last path segment
- Replace hyphens with spaces
- Keep ALL words including geo (country, region) – do NOT remove any words
- Example: "bahrain-aerogel-market" → "Bahrain aerogel market"
- Example: "australia-renewable-hydrogen-transport-market" → "Australia renewable hydrogen transport market"

STEP 2 – Write the X post in this EXACT style:

Study these real examples carefully – match the tone, structure, and phrasing:

Example A: "Aerogel market in Bahrain is gearing up for a game-changing outlook with surging demand and innovation accelerating growth. Explore the momentum building now: https://example.com #Aerogel #BahrainMarket"

Example B: "Global woodpulp market valued at $52B is set for a 4.2% CAGR through 2030 as sustainable packaging demand and Asia-Pacific capacity expansion reshape the competitive landscape. See what's driving the shift: https://example.com #WoodPulp #Sustainability"

Example C: "Big shifts ahead in the oil gas epc services market as industry momentum builds with exciting changes on the horizon. Full outlook: https://example.com #OilGas #EPCServices"

──────────────────────
FORMAT RULES:
- ONE flowing block – no blank lines anywhere in the tweet body
- 1 or 2 sentences max – no em dashes; use "with", "as", "while", "and" for flow
- If real market data has CAGR, market size, or competitor names – weave ONE specific number naturally into the tweet
- End with a short CTA phrase + colon, then the URL on the same line
- Then a space, then two hashtags
- Rotate CTA phrases: "Explore the momentum building now:", "Explore the surge shaping the future:", "Full outlook:", "Dive into the full picture:", "See what's driving the shift:"
- Hashtag 1 = core market keyword (no geo), Hashtag 2 = industry sector or geo

──────────────────────
POWER PHRASES – use and rotate:
- "game-changing outlook"
- "big shifts ahead"
- "industry momentum builds"
- "surging demand"
- "exciting changes on the horizon"
- "gearing up for"
- "innovation accelerating growth"

──────────────────────
MARKET VALUE (from sheet):
${marketValueLine}

${marketDataSection}

Priority: weave in CAGR or market size from web data if available. If no numbers found, use general language.

──────────────────────
CHARACTER RULE:
The full tweet text (excluding the URL) must be ${230 - (params.overLimitBy ?? 0)} characters or fewer.
The URL does not count toward this limit.${params.overLimitBy ? `\nPrevious attempt was ${params.overLimitBy} characters over — write a shorter, more concise version.` : ''}

──────────────────────
OUTPUT RULES:
- First character must be a letter
- No quotes around the output
- No JSON, no labels, no explanation
- No emojis
- No bullet points
- Output ONLY the tweet text, nothing else
- The URL in your output must be exactly: ${utmUrl}
- Never use: "projected to reach", "anticipated to grow", "value expected to reach", "driving innovation", "growing demand for"
- Every tweet must feel unique – vary the opening structure each time

${pastTweetsSection}`;

  const raw = await callLLM(prompt, 400);
  const tweet = raw.trim();

  // Safety check: ensure the full UTM URL is present (LLM must not truncate it)
  let finalTweet = tweet;
  if (!finalTweet.includes(utmUrl)) {
    const fixed = finalTweet.replace(/https?:\/\/[^\s]+kenresearch[^\s]*/gi, utmUrl);
    finalTweet = fixed.includes(utmUrl) ? fixed : `${finalTweet}\n${utmUrl}`;
  }

  // Save to history so future calls for the same URL avoid this angle
  saveTweetToHistory(params.url, finalTweet);

  return finalTweet;
}

/**
 * Generate a 3-5 tweet thread for a Ken Research report.
 * Returns an array of tweet strings. Last tweet contains the UTM URL.
 */
export async function generateXThread(params: {
  url: string;
  title: string;
  marketValue?: string;
}): Promise<string[]> {
  const utmUrl = `${params.url}${UTM_PARAMS.X}`;
  const marketData = await fetchMarketData(params.title);
  const mv = (params.marketValue ?? '').trim();

  const prompt = `You are a market insights writer creating an X (Twitter) thread for a Ken Research report.

Report: ${params.title}
URL: ${params.url}
Market value: ${mv || 'not available'}
${marketData ? `Web data: ${marketData}` : ''}

Write a thread of exactly 4 tweets. Return ONLY a valid JSON array of 4 strings. No explanation, no markdown, no code blocks.

CHARACTER LIMIT: Each tweet body MUST be 220 characters or fewer. The URL in tweet 4 goes on a NEW LINE and does NOT count toward the 220 limit. Stay well under 220 — aim for 160-210 chars per tweet body.

Thread structure:
- Tweet 1 (Hook): ≤220 chars. Open with the headline figure (market size + CAGR), then 1 short sentence of context. NO URL. End with "🧵".
- Tweet 2 (Insight): ≤220 chars. Pack in 2-3 specific numbers — segment share %, regional growth rate, or end-use figure. Name the top geography. NO URL.
- Tweet 3 (Detail): ≤220 chars. Name 1 specific company or geography. Add concrete figures — capacity, revenue share, adoption rate. Include a forward-looking year. NO URL.
- Tweet 4 (CTA): Body ≤220 chars (excluding URL). One punchy sentence with a number, then "Full report:" then a NEWLINE then ${utmUrl} then a NEWLINE then two hashtags.

Rules:
- Every tweet MUST contain at least 2 numbers (dollar figure, %, CAGR, year, or specific count)
- Tweet body ≤220 chars — count carefully, do not exceed
- Tweet 4: put the URL on its own line (use \\n in the JSON string) so it does not count toward the 220 body limit
- No em dashes — use "with", "as", "and" for flow
- No emojis except 🧵 at end of tweet 1
- No "projected to reach", "anticipated to grow", "driving innovation"
- Tweet 4 URL must be exactly: ${utmUrl}

Output format: ["tweet1", "tweet2", "tweet3", "tweet4 body\\n${utmUrl}\\n#hash1 #hash2"]`;

  const raw = await callLLM(prompt, 1000);

  // Parse JSON array from response
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('generateXThread: LLM did not return a JSON array');

  const tweets: string[] = JSON.parse(match[0]);
  if (!Array.isArray(tweets) || tweets.length < 2) {
    throw new Error('generateXThread: invalid thread array from LLM');
  }

  // Ensure last tweet has the UTM URL
  const last = tweets[tweets.length - 1];
  if (!last.includes(utmUrl)) {
    tweets[tweets.length - 1] = last.replace(/https?:\/\/\S+/g, utmUrl);
    if (!tweets[tweets.length - 1].includes(utmUrl)) {
      tweets[tweets.length - 1] = `${last} ${utmUrl}`;
    }
  }

  return tweets;
}

/**
 * Generate a Facebook post for a Ken Research report.
 * Used by FB batch.
 */
const FB_STYLES = [
  {
    hook: 'Opening Hook – one strong insight-driven sentence leading with a specific market size or CAGR figure (e.g. "The [market] crossed $X billion in [year], growing at X% CAGR").',
    body: `2. Context and Scale – 1-2 sentences on market value, growth rate, and geographic dynamics using real numbers.
3. Key Highlights – exactly 4 bullet points, each starting with a number or percentage from web data. Format: "• [number/stat] — [one-line insight]"
4. Future-Oriented Closing – 2 sentences: first on consolidation or investment trends; second on demand drivers or geographic expansion through a specific year.`,
  },
  {
    hook: 'Opening Hook – a warning-tone sentence signalling a market shift faster than most players realise (e.g. "The [market] is shifting faster than most suppliers realise — and the numbers confirm it.").',
    body: `2. What the data shows – 2 sentences with specific market size, CAGR, and the dominant region from web data.
3. Three forces reshaping the market – exactly 3 bullet points covering: a segment share shift with a %, a top competitor move (name the company), and a regulatory or geographic demand driver. Format: "• [stat or company] — [one sharp insight]"
4. What this means now – 2 sentences on near-term procurement or investment action required, referencing a specific year or threshold figure.`,
  },
  {
    hook: 'Opening Hook – lead with the single most striking number from web data as a standalone sentence (e.g. "$X billion. That is what the [market] is worth today, and it is still accelerating.").',
    body: `2. Why this number matters – 2 sentences framing the growth rate, geography, and what is driving the figure.
3. Key signals – exactly 4 bullet points: a segment breakout stat, a named competitor action, an ESG or regulatory pressure, and a geography-specific demand spike. Format: "• [stat or company] — [one-line insight]"
4. The bottom line – 2 sentences on what procurement teams or investors should prioritise before the next capacity cycle.`,
  },
  {
    hook: 'Opening Hook – a contrarian angle that challenges a common assumption (e.g. "Most coverage focuses on [X segment]. The real growth in [market] is happening somewhere else entirely.").',
    body: `2. The overlooked reality – 2 sentences with specific market size, CAGR, and the under-reported region or segment driving outperformance.
3. Four data points that change the picture – exactly 4 bullet points covering: the overlooked segment's share shift with a %, a competitor expanding into it (name the company), a policy or ESG tailwind, and a demand driver in a specific end-use or geography. Format: "• [stat or company] — [one sharp insight]"
4. Strategic takeaway – 2 sentences on repositioning procurement or portfolio allocation before the opportunity closes.`,
  },
  {
    hook: 'Opening Hook – a forward-looking prediction sentence anchored to a specific year and figure (e.g. "By [year], the [market] will look completely different — here is what the data says is coming.").',
    body: `2. Current baseline – 2 sentences on today\'s market size, CAGR, and dominant region to anchor the forecast.
3. The four forces behind the shift – exactly 4 bullet points: a segment acceleration stat, a named company leading the change, a regulatory or ESG catalyst, and a geographic demand wave. Format: "• [stat or company] — [one sharp insight]"
4. Action window – 2 sentences on the specific procurement contracts or investment positions to secure before the inflection point arrives.`,
  },
];

const LI_STYLES = [
  {
    hook: 'Hook – one sharp, provocative line challenging a B2B blind spot. Start with "If you assume" or "If your team still treats". Reference a specific market figure in the same sentence.',
    sections: `2. Market reality – 2 sentences with exact figures (market size in USD, CAGR %, dominant region) from web data. Frame as intelligence a decision-maker needs.
3. What B2B leaders must watch – exactly 4 bullet points using "•": a segment shift with a %, a named competitor move, a regulatory or ESG pressure, a demand driver in a specific geography. Format: "• [stat or company name] — [one sharp insight]"
4. Strategic implication – 1-2 sentences on procurement, investment, or competitive positioning. Make it directly actionable.`,
  },
  {
    hook: 'Hook – open with the single most striking number from web data as a standalone sentence, then a second sentence naming who is already acting on it (e.g. "The [market] hit $X billion in [year]. Leading procurement teams are already locking in supply contracts."). No "If you assume" phrasing.',
    sections: `2. Why this number is a signal, not a statistic – 2 sentences linking the figure to a structural shift: segment consolidation, geography expansion, or regulatory pressure. Use specific numbers.
3. Four moves shaping the competitive landscape – exactly 4 bullet points using "•": a segment share shift with a %, a named company\'s strategic action, an ESG or compliance pressure with a specific year or target, a demand surge in a named geography or end-use. Format: "• [stat or company name] — [one sharp insight]"
4. The decision window – 1-2 sentences on what procurement heads or investors must do before the market tightens, referencing a specific threshold or deadline.`,
  },
  {
    hook: 'Hook – a contrarian opening that names what "everyone" is focused on versus where the real opportunity lies (e.g. "Everyone is tracking [X]. The actual value in [market] is concentrating somewhere else entirely."). Include one specific figure.',
    sections: `2. The overlooked segment – 2 sentences with market size, CAGR, and the under-reported region or sub-segment outperforming the headline number.
3. Four data points that change the thesis – exactly 4 bullet points using "•": the hidden segment\'s share shift with a %, a competitor already moving there (name the company), a policy or ESG tailwind with a date or target, a geography-specific demand spike. Format: "• [stat or company name] — [one sharp insight]"
4. Portfolio implication – 1-2 sentences on reallocating procurement spend or investment weight toward the overlooked segment before consolidation closes the window.`,
  },
  {
    hook: 'Hook – a forward-looking prediction anchored to a specific year and dollar figure (e.g. "By [year], the [market] will be unrecognisable. $X billion in new capacity is already being committed."). No "If you assume" phrasing.',
    sections: `2. Today\'s baseline – 2 sentences on current market size, CAGR, and the region leading growth, to set the scale of the coming shift.
3. Four forces driving the transformation – exactly 4 bullet points using "•": a segment accelerating beyond the overall CAGR with a %, a named company leading the buildout, a regulatory or ESG mandate with a specific year or threshold, a geographic demand wave tied to infrastructure or policy. Format: "• [stat or company name] — [one sharp insight]"
4. First-mover window – 1-2 sentences on the specific contracts, partnerships, or positions that early movers must secure now to capture disproportionate value.`,
  },
  {
    hook: 'Hook – open with a direct question that forces a procurement or investment decision (e.g. "When [market condition hits], which supply contracts do you have locked in?"). Follow immediately with the market size figure.',
    sections: `2. The pressure building – 2 sentences on market size, CAGR, and the geographic or segment dynamic creating the urgency behind the question.
3. Four signals procurement and investors cannot ignore – exactly 4 bullet points using "•": a capacity or volume shift with a %, a named player expanding or exiting, an ESG or compliance deadline, a demand driver tied to a specific region or end-use. Format: "• [stat or company name] — [one sharp insight]"
4. The answer – 1-2 sentences with a concrete, actionable response to the opening question, referencing specific thresholds, timelines, or criteria.`,
  },
  {
    hook: 'Hook – open with a short declarative statement naming what is quietly happening in the market right now, without "If you assume" (e.g. "The [market] is consolidating faster than most procurement teams have updated their supplier lists."). Include a specific figure.',
    sections: `2. The scale of the shift – 2 sentences with exact market size in USD, CAGR, and the dominant region, framed as the context for the consolidation or shift.
3. What is driving it – exactly 4 bullet points using "•": a segment share movement with a %, a named company making a strategic move, a regulatory or ESG pressure with a specific year or target, a geography or end-use pulling disproportionate demand. Format: "• [stat or company name] — [one sharp insight]"
4. Strategic implication – 1-2 sentences on what procurement heads or investors must do differently in the next quarter, referencing a specific deadline or capacity threshold.`,
  },
];

export async function generateFbPost(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
}): Promise<string> {
  const utmUrl = `${params.url}${UTM_PARAMS.Facebook}`;
  const marketData = await fetchMarketData(params.title);
  const marketDataSection = marketData
    ? `REAL MARKET DATA (from web search — use specific numbers, CAGR, market size, competitors if present):\n${marketData}`
    : 'No web data available — use general market language without inventing numbers.';

  const style = FB_STYLES[Math.floor(Math.random() * FB_STYLES.length)];

  const prompt = `You are a professional B2B content writer who acts as an independent industry observer, not a publisher, researcher, or representative of Ken Research or any other organization.

You write from a neutral, third-party perspective, offering insights as an external market professional analyzing publicly available industry information.

Your task is to generate a Facebook post based on the market report landing page URL provided below.

TONE AND STYLE:
- Write as an independent industry expert sharing insights publicly
- Do not imply any affiliation with Ken Research
- Maintain a neutral, analytical, third-party viewpoint
- Do not use emojis, bold text, italics, headings, or any formatting elements
- Do not mention "Ken Research", "report", "study", "analysis", or "whitepaper" in the main body
- Every section must include at least one specific number, percentage, or named company from the web data

POST STRUCTURE (use exactly this order, one blank line between each section):
1. ${style.hook}
${style.body}
5. CTA – choose one from the approved list below, on its own line, followed immediately by the UTM URL on the same line

SPACING RULES (critical):
- Use exactly one blank line between each of the 5 sections above
- No blank lines within a section
- No double blank lines anywhere
- Hashtags go on the very last line with no blank line before them

${marketDataSection}

APPROVED CTA VARIATIONS (choose one, do not modify wording):
1. Explore the complete research report below for detailed insights, forecasts, and competitive mapping from Ken Research:
2. For deeper insights into market size, competitive benchmarking, segment analysis, and forecasts, explore the full research report here:
3. To further understand the market's dynamics, growth themes, and competitive landscape, you can review the full research report from Ken Research here:
4. For a comprehensive view of key drivers, opportunities, and future projections, access the research report from Ken Research below:
5. If you're looking to dive deeper into market trends and strategic shifts, the full research report from Ken Research is available here:

CTA RULES:
- The CTA must mention "Ken Research"
- Final URL must be exactly: ${utmUrl}
- Do not add a blank line between the CTA+URL line and the hashtags

HASHTAGS (6-10):
- Clean, professional, industry-relevant hashtags
- No #KenResearch, no emojis
- All on one line, space-separated

STRICT RULES:
- Only use numbers/companies from the web data provided above — do not invent statistics
- Do not mention "report", "study", or "analysis" in the body
- No emojis, no bold, no markdown, no special characters
- Output ONLY the post text, nothing else

URL: ${params.url}`;

  return await callLLM(prompt, 750);
}

/**
 * Generate a LinkedIn post for a Ken Research report.
 * Used by LI batch.
 */
export async function generateLiPost(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
}): Promise<string> {
  const utmUrl = `${params.url}${UTM_PARAMS.LinkedIn}`;
  const marketData = await fetchMarketData(params.title);
  const marketDataSection = marketData
    ? `REAL MARKET DATA (from web search — use specific numbers, CAGR, market size, top competitors if present):\n${marketData}`
    : 'No web data available — use general market language without inventing numbers.';

  const style = LI_STYLES[Math.floor(Math.random() * LI_STYLES.length)];

  const prompt = `You are a senior B2B market strategist writing a LinkedIn post that speaks directly to procurement heads, investors, and industry executives — not general readers.

Title: ${params.title}
URL: ${utmUrl}

${marketDataSection}

DATA RULE: Every section of this post must include at least one specific number, percentage, dollar figure, or named company drawn from the web data above. Do not write any section without a concrete figure.

POST STRUCTURE (one blank line between each section):
1. ${style.hook}
${style.sections}
5. CTA – "Full competitive benchmarking, segment forecasts, and regional breakdowns from Ken Research: ${utmUrl}"

RULES:
- Write as an independent expert, not affiliated with Ken Research
- Only use numbers and company names from the web data above — do not invent
- No emojis, no bold, no markdown
- 4-6 hashtags on last line, space-separated, B2B-focused
- Output ONLY the post text, nothing else`;

  return await callLLM(prompt, 600);
}

/**
 * Generate Medium post — uses pre-written content from sheet (no LLM)
 */
export async function generateMediumPost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  // Inject UTM parameters into the content
  return injectUTM(content, UTM_PARAMS.Medium);
}

/**
 * Generate Google Sites post — uses pre-written content from sheet (no LLM)
 */
export async function generateGoogleSitePost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  // Inject UTM parameters into the content
  return injectUTM(content, UTM_PARAMS.GoogleSite);
}

/**
 * Generate Dev.to post — uses pre-written content from sheet (no LLM)
 */
export async function generateDevtoPost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  // Inject UTM parameters into the content
  return injectUTM(content, UTM_PARAMS.Devto);
}

/**
 * Generate LinkedIn Pulse article — uses pre-written content from sheet (no LLM)
 * Returns: { title, html, seoTitle, seoDescription }
 */
export async function generateLinkedinPulsePost(row: SheetRow): Promise<{ title: string; html: string; seoTitle: string; seoDescription: string }> {
  // Use Main Title from sheet (blog headline)
  const mainTitle = (row.descriptionTitle || row.title || '').trim();
  if (!mainTitle) {
    throw new Error('No Main Title (descriptionTitle) or title found');
  }

  // Use Blog Content for all (article body)
  const blogContent = (row.blogContent || '').trim();
  if (!blogContent) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }

  // Use Description column as SEO description / share text
  const finalSeoDesc = row.description?.trim() || blogContent.replace(/<[^>]*>/g, '').slice(0, 160);

  return {
    title: mainTitle,
    html: injectUTM(blogContent, UTM_PARAMS.LinkedIn),
    seoTitle: mainTitle, // Use Main Title as SEO title
    seoDescription: finalSeoDesc || 'Explore the latest market insights and analysis',
  };
}

/**
 * Generate Calisthenics post — uses pre-written content from sheet (no LLM)
 */
export async function generateCalisthenicsPost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  // Inject UTM parameters into the content
  return injectUTM(content, UTM_PARAMS.Calisthenics);
}

/**
 * Generate Substack post — uses pre-written content from sheet (no LLM)
 */
export async function generateSubstackPost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  // Inject UTM parameters into the content
  return injectUTM(content, UTM_PARAMS.Substack);
}

/**
 * Generate Guffiz post — uses pre-written content from sheet (no LLM)
 */
export async function generateGuffizPost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  // Inject UTM parameters into the content
  return injectUTM(content, UTM_PARAMS.Guffiz);
}

/**
 * Generate Linkmate post — uses pre-written content from sheet (no LLM)
 */
export async function generateLinkmatePost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  return injectUTM(content, UTM_PARAMS.Linkmate);
}

/**
 * Generate HackMD post — uses pre-written content from sheet (no LLM)
 */
export async function generateHackmdPost(row: SheetRow): Promise<string> {
  const content = (row.blogContent || '').trim();
  if (!content) {
    throw new Error('No blog content provided (Blog Content for all column is empty)');
  }
  // Inject UTM parameters into the content
  return injectUTM(content, UTM_PARAMS.HackMD);
}

// ── Legacy: generate all 4 posts at once (used by weekly recheck) ──────────────

export async function runContentAgent(params: ContentParams): Promise<ContentResult> {
  const prompt = `Generate social media content for this Ken Research market report.
Return ONLY valid JSON (no markdown, no extra text).

Title: ${params.title}
URL: ${params.url}
Priority: ${params.priority}
Rank: ${params.seoRanking}

JSON format:
{
  "tweet": "tweet max 280 chars with URL and hashtags",
  "fbPost": "facebook post 2-3 paragraphs",
  "liPost": "linkedin post 3-4 paragraphs with hashtags",
  "blog": "blog post 200-300 words"
}`;

  const raw = await callLLM(prompt, 1500);

  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*?"blog"[\s\S]*?\}/);
    if (!jsonMatch) throw new Error(`No valid JSON in response: ${raw.slice(0, 150)}`);
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(`Could not parse JSON: ${jsonMatch[0].slice(0, 150)}`);
    }
  }

  if (!parsed.tweet) throw new Error('Incomplete content: missing tweet field');

  return {
    tweet: String(parsed.tweet).slice(0, 280),
    fbPost: String(parsed.fbPost || ''),
    liPost: String(parsed.liPost || ''),
    blog: String(parsed.blog || ''),
    seoScore: 75,
    sanityIssues: [],
  };
}
