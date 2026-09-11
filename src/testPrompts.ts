/**
 * testPrompts.ts — Generate all FB and LI prompt styles for a test market
 * Run: node --import=tsx src/testPrompts.ts
 */
import 'dotenv/config';

const TEST_TITLE = 'India Electric Bus Market';
const TEST_URL   = 'https://www.kenresearch.com/blog/india-electric-bus-market';
const UTM_FB     = '?utm_source=facebook&utm_medium=social&utm_campaign=ken_research';
const UTM_LI     = '?utm_source=linkedin&utm_medium=social&utm_campaign=ken_research';

// ── LLM caller (mirrors callLLMWithRetry in contentAgentNew) ─────────────────
const OPENROUTER_KEYS = Object.keys(process.env)
  .filter(k => k.startsWith('OPENROUTER_API_KEY_'))
  .map(k => process.env[k]!)
  .filter(Boolean);

async function callLLM(prompt: string): Promise<string> {
  for (const key of OPENROUTER_KEYS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1200,
          temperature: 0.75,
        }),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      return data.choices?.[0]?.message?.content?.trim() ?? '';
    } catch { continue; }
  }
  throw new Error('All OpenRouter keys failed');
}

// ── Market data (static stub so we don't burn SERP quota) ───────────────────
const MARKET_DATA = `India Electric Bus Market size: USD 1.2 billion in 2024, projected to reach USD 7.8 billion by 2032 at a CAGR of 26.3%. Key drivers: FAME-II subsidy scheme, state EV policies, PM e-bus sewa programme (10,000 buses). Top players: Tata Motors, Olectra Greentech, JBM Auto, PMI Electro Mobility. Dominant segment: 12-metre city buses. Leading states: Maharashtra, Delhi, Tamil Nadu, Gujarat. Battery cost dropped 40% since 2020 (LFP chemistry dominant). India targets 50,000 e-buses on road by 2030.`;

const MARKET_DATA_SECTION = `REAL MARKET DATA (from web search — use specific numbers, CAGR, market size, competitors if present):\n${MARKET_DATA}`;

const currentYear = new Date().getFullYear();
const today = new Date().toISOString().split('T')[0];

// ═══════════════════════════════════════════════════════════════════════════
// FB PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

const utmFb = `${TEST_URL}${UTM_FB}`;

const FB_ORIGINAL = `You are a Senior SEO Content Strategist and Facebook Post Caption Writer for Ken Research.

Report URL: ${utmFb}

${MARKET_DATA_SECTION}

TODAY'S DATE: ${today}
CURRENT YEAR: ${currentYear}

IMPORTANT — YEAR RULE:
- If the market data contains previous year figures, do NOT use them as current. Always reference the forecast period or the current/upcoming year (${currentYear} or beyond).
- Frame all statistics as forward-looking or current-year projections.

Your task is to generate ONE professional Facebook caption for this Ken Research report.

Caption Requirements:
1. Strong hook in the opening line.
2. Use the market name naturally in the first 1-2 lines.
3. Include important report information: market size/value, forecast period, key growth drivers, major segments, leading regions, technology/demand trends, business opportunities.
4. Add 4-6 bullet-style market highlights.
5. Keep all text plain. Do NOT use markdown bold markers such as ** around words, numbers, or phrases.
6. Tone: professional, research-led, consulting-style.
7. No emojis.
8. Do NOT use em dashes (—) anywhere. Use a comma, colon, or period instead.
9. Do not sound promotional or generic.
10. End with this CTA:
    Read the full India Electric Bus Market Report by Ken Research:
    ${utmFb}
11. Add 5-7 relevant SEO hashtags at the end.

Caption Structure:
- Opening Hook (1-2 strong lines introducing the market opportunity)
- Information Paragraph (market size, key demand drivers, why this market matters)
- Market Highlights (4-6 bullets with clear strategic points)
- Business Relevance (why this matters for investors, manufacturers, distributors, consultants)
- CTA + URL
- Hashtags

Output ONLY the single caption. No numbering, no separators, no explanation before or after.
STRICT: Do NOT use em dashes (—) anywhere. Replace with a comma, colon, or period.`;

// FB CAPTION STYLE 1 — options 0/1/2
function fbCaption1(optionIndex: number): string {
  const options = ['Option 1: Sharp Executive-Style Caption', 'Option 2: Data-Led and Insight-Heavy Caption', 'Option 3: CXO Pain-Point Focused Caption'];
  return `Act as a Senior LinkedIn Content Strategist for a B2B consulting and market research firm (Ken Research).

URL: ${utmFb}

${MARKET_DATA_SECTION}

TODAY'S DATE: ${today}
CURRENT YEAR: ${currentYear}

IMPORTANT — YEAR RULE: Always reference the forecast period or the current/upcoming year (${currentYear} or beyond). Do not use stale figures as current.

Your task:
First, silently analyze the URL/market data and extract key statistics, market numbers, growth signals, business pain points, and strategic implications.
Then, output ONLY ONE finished LinkedIn caption — ${options[optionIndex]}.

Caption must follow this structure:
Hook → Data/Stat → Business Pain Point → Strategic Implication → Ken Research Positioning → CTA → Hashtags

Caption Rules:
- 120–180 words.
- Start with a strong, high-impact hook. Avoid weak openers like "The market is growing rapidly" or "This report talks about".
  Good hooks: "The real opportunity isn't market growth. It's where the next profit pool is shifting." / "For CXOs, this market is no longer about expansion. It's about margin protection." / "Growth is visible. Profitability is where the real question begins."
- Include 1–2 statistics or market signals from the URL/data.
- Reference at least one business pain point (margin pressure, demand uncertainty, competitive intensity, market entry risk).
- Include ONE subtle Ken Research positioning line, e.g.: "At Ken Research, we help businesses decode such market shifts through intelligence-led strategy."
- End with CTA: "Explore the full report here: ${utmFb}"
- Add 3–5 professional hashtags.
- Tone: professional, consulting-led, CXO-focused, data-backed, human-written. Not sales-heavy or generic.
- Do NOT use em dashes (—). Use commas, colons, or periods instead.

MANDATORY FORMATTING (never skip):
- Each section (Hook / Data / Pain Points / Implication / Positioning / CTA / Hashtags) must be separated by a blank line.
- List pain points or signals as arrow bullets, one per line: "→ first point"
- Hashtags must use plain # symbol.
- CTA must be on its own line after a blank line.
- No walls of text. Every distinct idea gets its own paragraph or line.

Output ONLY the caption. No headings, no analysis, no numbering, no explanation.`;
}

// FB CAPTION STYLE 2 — options 0/1/2
function fbCaption2(optionIndex: number): string {
  const options = [
    'Option 1: Sharp Executive-Style (market opportunity, boardroom relevance, strategic positioning)',
    'Option 2: Data-Led and Insight-Heavy (statistics, market numbers, operational meaning)',
    'Option 3: CXO Pain-Point Focused (decision-making risks, margin pressure, competition, market entry concerns)',
  ];
  return `Act as a Senior LinkedIn Content Strategist for a B2B consulting and market research firm (Ken Research).

URL: ${utmFb}

${MARKET_DATA_SECTION}

TODAY'S DATE: ${today}
CURRENT YEAR: ${currentYear}

IMPORTANT — YEAR RULE: Always reference the forecast period or the current/upcoming year (${currentYear} or beyond).

Your task:
Silently analyze the URL/market data. Extract key statistics, market numbers, growth signals, business pain points, and strategic implications.
Then output ONLY ONE finished LinkedIn caption — ${options[optionIndex]}.

Structure: Hook → Data/Stat → Business Pain Point → Strategic Implication → Ken Research Positioning → CTA → Hashtags

Rules:
- 120–180 words.
- Hook must be sharp and boardroom-ready. Never start with "The market is growing" or "This report talks about".
  Strong openers: "The companies that understand this shift early will not just enter the market. They will shape it." / "The real question for decision-makers is not whether this market will grow. It is who captures the margin." / "Market size is the headline. Profitability is the story beneath it."
- Use 1–2 data points from the provided market data. Do NOT invent numbers.
- Reference at least one pain point relevant to CXOs (weak market visibility, competitive pressure, margin compression, demand uncertainty).
- Include ONE Ken Research positioning line: "Ken Research supports decision-makers in assessing market size, competitive intensity, and growth pathways with clarity."
- CTA: "For deeper competitive intelligence, read the complete insight: ${utmFb}"
- 3–5 professional, topic-relevant hashtags.
- Tone: sharp, consulting-grade, data-backed, human-written. Not promotional, not generic, not academic.
- Do NOT use em dashes (—). Replace with commas, colons, or periods.

MANDATORY FORMATTING (never skip):
- Each section separated by a blank line.
- List pain points as arrow bullets: "→ first point"
- Hashtags use plain # symbol.
- CTA on its own line after a blank line.
- No walls of text.

Output ONLY the caption text. No analysis section, no headings, no separators.`;
}

// FB_STYLES[0–4]
const FB_STYLE_HOOKS = [
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
3. Four data points that change the picture – exactly 4 bullet points covering: the overlooked segment\'s share shift with a %, a competitor expanding into it (name the company), a policy or ESG tailwind, and a demand driver in a specific end-use or geography. Format: "• [stat or company] — [one sharp insight]"
4. Strategic takeaway – 2 sentences on repositioning procurement or portfolio allocation before the opportunity closes.`,
  },
  {
    hook: 'Opening Hook – a forward-looking prediction sentence anchored to a specific year and figure (e.g. "By [year], the [market] will look completely different — here is what the data says is coming.").',
    body: `2. Current baseline – 2 sentences on today\'s market size, CAGR, and dominant region to anchor the forecast.
3. The four forces behind the shift – exactly 4 bullet points: a segment acceleration stat, a named company leading the change, a regulatory or ESG catalyst, and a geographic demand wave. Format: "• [stat or company] — [one sharp insight]"
4. Action window – 2 sentences on the specific procurement contracts or investment positions to secure before the inflection point arrives.`,
  },
];

function fbStylePrompt(idx: number): string {
  const s = FB_STYLE_HOOKS[idx];
  return `You are a Senior Facebook Content Writer for Ken Research, a global market intelligence firm.

Report URL: ${utmFb}

${MARKET_DATA_SECTION}

TODAY'S DATE: ${today}
CURRENT YEAR: ${currentYear}

IMPORTANT — YEAR RULE: Always reference the forecast period or the current/upcoming year (${currentYear} or beyond). Do not present past figures as current.

Write ONE professional Facebook post following this exact structure:

1. ${s.hook}
${s.body}
5. Ken Research CTA – one sentence ending with: "Read the full report: ${utmFb}"
6. Hashtags – 5–7 relevant professional hashtags.

Hard rules:
- Use ONLY data from the web search results. Do NOT invent numbers.
- Do NOT use em dashes (—). Replace with a comma, colon, or period.
- No emojis. No generic filler phrases ("rapidly growing", "exciting opportunity").
- Tone: professional, research-led, consulting-style.
- Output ONLY the post. No preamble, no labels, no commentary.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// LI PROMPTS
// ═══════════════════════════════════════════════════════════════════════════

const utmLi = `${TEST_URL}${UTM_LI}`;

const LI_STYLE_DEFS = [
  {
    hook: 'Hook – one sharp, provocative line challenging a B2B blind spot. Start with "If you assume" or "If your team still treats". Reference a specific market figure in the same sentence.',
    sections: `2. Market reality – 2 sentences with exact figures (market size in USD, CAGR %, dominant region) from web data. Frame as intelligence a decision-maker needs.
3. What B2B leaders must watch – exactly 4 bullet points using "•": a segment shift with a %, a named competitor move, a regulatory or ESG pressure, a demand driver in a specific geography. Format: "• [stat or company name] — [one sharp insight]"
4. Strategic implication – 1-2 sentences on procurement, investment, or competitive positioning. Make it directly actionable.`,
  },
  {
    hook: 'Hook – open with the single most striking number from web data as a standalone sentence, then a second sentence naming who is already acting on it. No "If you assume" phrasing.',
    sections: `2. Why this number is a signal, not a statistic – 2 sentences linking the figure to a structural shift: segment consolidation, geography expansion, or regulatory pressure. Use specific numbers.
3. Four moves shaping the competitive landscape – exactly 4 bullet points using "•": a segment share shift with a %, a named company\'s strategic action, an ESG or compliance pressure with a specific year or target, a demand surge in a named geography or end-use. Format: "• [stat or company name] — [one sharp insight]"
4. The decision window – 1-2 sentences on what procurement heads or investors must do before the market tightens, referencing a specific threshold or deadline.`,
  },
  {
    hook: 'Hook – a contrarian opening that names what "everyone" is focused on versus where the real opportunity lies. Include one specific figure.',
    sections: `2. The overlooked segment – 2 sentences with market size, CAGR, and the under-reported region or sub-segment outperforming the headline number.
3. Four data points that change the thesis – exactly 4 bullet points using "•": the hidden segment\'s share shift with a %, a competitor already moving there (name the company), a policy or ESG tailwind with a date or target, a geography-specific demand spike. Format: "• [stat or company name] — [one sharp insight]"
4. Portfolio implication – 1-2 sentences on reallocating procurement spend or investment weight toward the overlooked segment before consolidation closes the window.`,
  },
  {
    hook: 'Hook – a forward-looking prediction anchored to a specific year and dollar figure. No "If you assume" phrasing.',
    sections: `2. Today\'s baseline – 2 sentences on current market size, CAGR, and the region leading growth, to set the scale of the coming shift.
3. Four forces driving the transformation – exactly 4 bullet points using "•": a segment accelerating beyond the overall CAGR with a %, a named company leading the buildout, a regulatory or ESG mandate with a specific year or threshold, a geographic demand wave tied to infrastructure or policy. Format: "• [stat or company name] — [one sharp insight]"
4. First-mover window – 1-2 sentences on the specific contracts, partnerships, or positions that early movers must secure now to capture disproportionate value.`,
  },
  {
    hook: 'Hook – open with a direct question that forces a procurement or investment decision. Follow immediately with the market size figure.',
    sections: `2. The pressure building – 2 sentences on market size, CAGR, and the geographic or segment dynamic creating the urgency behind the question.
3. Four signals procurement and investors cannot ignore – exactly 4 bullet points using "•": a capacity or volume shift with a %, a named player expanding or exiting, an ESG or compliance deadline, a demand driver tied to a specific region or end-use. Format: "• [stat or company name] — [one sharp insight]"
4. The answer – 1-2 sentences with a concrete, actionable response to the opening question, referencing specific thresholds, timelines, or criteria.`,
  },
  {
    hook: 'Hook – open with a short declarative statement naming what is quietly happening in the market right now. Include a specific figure.',
    sections: `2. The scale of the shift – 2 sentences with exact market size in USD, CAGR, and the dominant region, framed as the context for the consolidation or shift.
3. What is driving it – exactly 4 bullet points using "•": a segment share movement with a %, a named company making a strategic move, a regulatory or ESG pressure with a specific year or target, a geography or end-use pulling disproportionate demand. Format: "• [stat or company name] — [one sharp insight]"
4. Strategic implication – 1-2 sentences on what procurement heads or investors must do differently in the next quarter, referencing a specific deadline or capacity threshold.`,
  },
];

function liOriginalPrompt(styleIdx: number): string {
  const s = LI_STYLE_DEFS[styleIdx];
  return `You are a Senior B2B LinkedIn Content Writer for Ken Research, a global market intelligence firm.

Report URL: ${utmLi}

${MARKET_DATA_SECTION}

TODAY'S DATE: ${today}
CURRENT YEAR: ${currentYear}

IMPORTANT — YEAR RULE:
- Do not use previous year figures as current. Always reference the forecast period or the current/upcoming year (${currentYear} or beyond).
- Frame all statistics as forward-looking or current-year projections.

Write ONE LinkedIn post (250–350 words) strictly following this structure:

1. ${s.hook}
${s.sections}
5. Ken Research CTA – one sentence ending with: "Explore the full report: ${utmLi}"
6. Hashtags – 4–6 professional hashtags relevant to the market topic.

Hard rules:
- Use only data from the web search results. Do NOT invent numbers.
- Do NOT use em dashes (—). Replace with a comma, colon, or period.
- No emojis. No generic phrases ("rapidly growing", "exciting opportunity"). No filler sentences.
- Output ONLY the LinkedIn post. No preamble, no labels, no commentary.`;
}

function liCaption1(optionIndex: number): string {
  const options = ['Option 1: Sharp Executive-Style Caption', 'Option 2: Data-Led and Insight-Heavy Caption', 'Option 3: CXO Pain-Point Focused Caption'];
  return `Act as a Senior LinkedIn Content Strategist for a B2B consulting and market research firm (Ken Research).

URL: ${utmLi}

${MARKET_DATA_SECTION}

TODAY'S DATE: ${today}
CURRENT YEAR: ${currentYear}

IMPORTANT — YEAR RULE: Always reference the forecast period or the current/upcoming year (${currentYear} or beyond). Do not use stale figures as current.

Your task:
First, silently analyze the URL/market data and extract key statistics, market numbers, growth signals, business pain points, and strategic implications.
Then, output ONLY ONE finished LinkedIn caption — ${options[optionIndex]}.

Caption must follow this structure:
Hook → Data/Stat → Business Pain Point → Strategic Implication → Ken Research Positioning → CTA → Hashtags

Caption Rules:
- 120–180 words.
- Start with a strong, high-impact hook. Avoid weak openers like "The market is growing rapidly" or "This report talks about".
- Include 1–2 statistics or market signals from the URL/data.
- Reference at least one business pain point (margin pressure, demand uncertainty, competitive intensity, market entry risk).
- Include ONE subtle Ken Research positioning line, e.g.: "At Ken Research, we help businesses decode such market shifts through intelligence-led strategy."
- End with CTA: "Explore the full report here: ${utmLi}"
- Add 3–5 professional hashtags.
- Tone: professional, consulting-led, CXO-focused, data-backed, human-written. Not sales-heavy or generic.
- Do NOT use em dashes (—). Use commas, colons, or periods instead.

MANDATORY FORMATTING (never skip):
- Each section separated by a blank line.
- List pain points as arrow bullets: "→ first point"
- Hashtags use plain # symbol.
- CTA on its own line after a blank line.

Output ONLY the caption. No headings, no analysis, no numbering, no explanation.`;
}

function liCaption2(optionIndex: number): string {
  const options = [
    'Option 1: Sharp Executive-Style (market opportunity, boardroom relevance, strategic positioning)',
    'Option 2: Data-Led and Insight-Heavy (statistics, market numbers, operational meaning)',
    'Option 3: CXO Pain-Point Focused (decision-making risks, margin pressure, competition, market entry concerns)',
  ];
  return `Act as a Senior LinkedIn Content Strategist for a B2B consulting and market research firm (Ken Research).

URL: ${utmLi}

${MARKET_DATA_SECTION}

TODAY'S DATE: ${today}
CURRENT YEAR: ${currentYear}

IMPORTANT — YEAR RULE: Always reference the forecast period or the current/upcoming year (${currentYear} or beyond).

Your task:
Silently analyze the URL/market data. Extract key statistics, market numbers, growth signals, business pain points, and strategic implications.
Then output ONLY ONE finished LinkedIn caption — ${options[optionIndex]}.

Structure: Hook → Data/Stat → Business Pain Point → Strategic Implication → Ken Research Positioning → CTA → Hashtags

Rules:
- 120–180 words.
- Hook must be sharp and boardroom-ready. Never start with "The market is growing" or "This report talks about".
- Use 1–2 data points from the provided market data. Do NOT invent numbers.
- Reference at least one pain point relevant to CXOs (weak market visibility, competitive pressure, margin compression, demand uncertainty).
- Include ONE Ken Research positioning line: "Ken Research supports decision-makers in assessing market size, competitive intensity, and growth pathways with clarity."
- CTA: "For deeper competitive intelligence, read the complete insight: ${utmLi}"
- 3–5 professional, topic-relevant hashtags.
- Tone: sharp, consulting-grade, data-backed, human-written.
- Do NOT use em dashes (—). Replace with commas, colons, or periods.

MANDATORY FORMATTING (never skip):
- Each section separated by a blank line.
- List pain points as arrow bullets: "→ first point"
- Hashtags use plain # symbol.
- CTA on its own line after a blank line.

Output ONLY the caption text. No analysis section, no headings, no separators.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════

const SEP = '\n' + '═'.repeat(80) + '\n';

async function run() {
  const fbJobs: Array<{ label: string; prompt: string }> = [
    { label: 'FB-1  Original (bullets + bold)',            prompt: FB_ORIGINAL },
    { label: 'FB-2  Caption-Style-1 / Sharp Executive',    prompt: fbCaption1(0) },
    { label: 'FB-3  Caption-Style-1 / Data-Led',           prompt: fbCaption1(1) },
    { label: 'FB-4  Caption-Style-1 / CXO Pain-Point',     prompt: fbCaption1(2) },
    { label: 'FB-5  Caption-Style-2 / Sharp Executive',    prompt: fbCaption2(0) },
    { label: 'FB-6  Caption-Style-2 / Data-Led',           prompt: fbCaption2(1) },
    { label: 'FB-7  Caption-Style-2 / CXO Pain-Point',     prompt: fbCaption2(2) },
    { label: 'FB-8  FB_STYLE-1 (Insight-Driven Hook)',     prompt: fbStylePrompt(0) },
    { label: 'FB-9  FB_STYLE-2 (Warning-Tone Hook)',       prompt: fbStylePrompt(1) },
    { label: 'FB-10 FB_STYLE-3 (Striking-Number Hook)',    prompt: fbStylePrompt(2) },
    { label: 'FB-11 FB_STYLE-4 (Contrarian Hook)',         prompt: fbStylePrompt(3) },
    { label: 'FB-12 FB_STYLE-5 (Forward-Looking Hook)',    prompt: fbStylePrompt(4) },
  ];

  const liJobs: Array<{ label: string; prompt: string }> = [
    { label: 'LI-1  Original / LI_STYLE-1 (Blind-Spot Hook)',       prompt: liOriginalPrompt(0) },
    { label: 'LI-2  Original / LI_STYLE-2 (Striking-Number Hook)',  prompt: liOriginalPrompt(1) },
    { label: 'LI-3  Original / LI_STYLE-3 (Contrarian Hook)',       prompt: liOriginalPrompt(2) },
    { label: 'LI-4  Original / LI_STYLE-4 (Forward-Looking Hook)',  prompt: liOriginalPrompt(3) },
    { label: 'LI-5  Original / LI_STYLE-5 (Direct-Question Hook)',  prompt: liOriginalPrompt(4) },
    { label: 'LI-6  Original / LI_STYLE-6 (Declarative Hook)',      prompt: liOriginalPrompt(5) },
    { label: 'LI-7  Caption-Style-1 / Sharp Executive',             prompt: liCaption1(0) },
    { label: 'LI-8  Caption-Style-1 / Data-Led',                    prompt: liCaption1(1) },
    { label: 'LI-9  Caption-Style-1 / CXO Pain-Point',              prompt: liCaption1(2) },
    { label: 'LI-10 Caption-Style-2 / Sharp Executive',             prompt: liCaption2(0) },
    { label: 'LI-11 Caption-Style-2 / Data-Led',                    prompt: liCaption2(1) },
    { label: 'LI-12 Caption-Style-2 / CXO Pain-Point',              prompt: liCaption2(2) },
  ];

  console.log(`\nMarket: ${TEST_TITLE}`);
  console.log(`Generating ${fbJobs.length} FB posts + ${liJobs.length} LI posts...\n`);

  console.log(SEP + '  FACEBOOK POSTS' + SEP);
  for (const job of fbJobs) {
    console.log(`\n▶ ${job.label}\n${'─'.repeat(60)}`);
    try {
      const result = await callLLM(job.prompt);
      console.log(result);
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
    }
    console.log();
  }

  console.log(SEP + '  LINKEDIN POSTS' + SEP);
  for (const job of liJobs) {
    console.log(`\n▶ ${job.label}\n${'─'.repeat(60)}`);
    try {
      const result = await callLLM(job.prompt);
      console.log(result);
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
    }
    console.log();
  }

  console.log('\n✅ All done. Review above and pick your favourite styles.\n');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
