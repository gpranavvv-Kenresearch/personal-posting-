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
import { isRefusal, stripModelArtifacts, isDegenerate, isReasoningLeak, isPromptEcho, isSafetyClassifierLeak } from '../utils/textChecks.js';
import { isModelQuarantined, recordModelOutcome } from '../config/modelHealthTracker.js';

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

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

// Groq is tried FIRST (fastest, genuinely free — no credit card gate like
// Eden AI/HaiMaker hit). Live probe 2026-08-27, same prompt shape as
// generateTweet/generateFbPost (debug-scratch/verifyGroq.mjs):
//   - 'qwen/qwen3.8-27b'    → 3/3 clean, ~500ms avg — fastest clean model found across ALL providers tested
//   - 'groq/compound-mini'  → 3/3 clean, ~4s avg — backup
//   - 'qwen/qwen3.6-27b'    → 3/3 leaked raw <think>...</think> chain-of-thought (caught by
//                             isReasoningLeak()'s THINK_TAG_RE fix, added the same day this was found) — excluded
//   - 'groq/compound'       → rate-limited every time — excluded
//   - 'openai/gpt-oss-20b' / '120b' on Groq → empty every time — excluded
const GROQ_MODELS = [
  'qwen/qwen3.8-27b',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.8-27b',
  'groq/compound-mini',
];
// 'meta/llama-3.1-70b-instruct' (previous pin) hit end-of-life 2026-08-26 and
// started returning HTTP 410 on every single call — all 4 NVIDIA keys were
// silent dead weight in the pool until caught by a manual probe
// (debug-scratch/scanNvidiaAll.mjs + verifyNvidia2.mjs). Replaced with the
// best-testing candidate from that account's actually-invokable models: 3/3
// clean, 15-27s latency. The isModelQuarantined()/recordModelOutcome() circuit
// breaker in callLLM() below now catches this class of failure automatically
// going forward — a model that starts erroring/trashing 5x in a row gets
// pulled out of rotation for 6h without needing a manual re-probe.
const NVIDIA_MODEL = 'deepseek-ai/deepseek-v4-pro-0813';

// Rotating across several free OpenRouter models — not just one — matters:
// every key already rotates, but they were all hitting the SAME model, so
// the model's own shared rate-limit/quota (not the key count) was the real
// ceiling. Confirmed live (2026-08-24): all 15 keys hit 429 together on
// gemma-4-26b-a4b-it:free (hammered all day by production traffic) — proof
// it's per-model exhaustion, not a shared-account problem, since different
// models on the same keys behave completely differently.
//
// This exact list was chosen by testing every one of OpenRouter's ~18 live
// free models (GET https://openrouter.ai/api/v1/models, filter
// id.endsWith(':free')) for two things: (1) actual spare capacity across
// all 15 keys, and (2) clean output — several models exist but were
// excluded: 'z-ai/glm-5.2:free' and 'google/gemma-4-31b-it:free' were
// heavily 429'd on every test; 'nvidia/nemotron-3.5-lightning:free' and
// 'nvidia/nemotron-3-ultra-550b-a55b:free' respond but leak their internal
// reasoning/prompt-echo text into the answer ("Here's a thinking process:
// 1. Analyze the Request..." / "The user asks: ...") and would need extra
// stripping to be usable; several others (dots-studio, poolside, cohere
// code model, nvidia's content-safety classifier) returned HTTP 200 with
// empty content; a few more 403/503'd outright. Re-check that models
// endpoint periodically — OpenRouter's free-model lineup and quotas shift.
//
// Confirmed live (2026-08-25): 'nvidia/nemotron-3-nano-30b-a3b:free' and
// 'nvidia/nemotron-nano-12b-v2-vl:free' are GONE from OpenRouter's free
// tier entirely (404 "No endpoints found" / "unavailable for free") — they
// were silently dead weight in the rotation, instantly failing on every
// assigned key and forcing heavier load onto the remaining models. Removed
// both; re-verify against GET https://openrouter.ai/api/v1/models before
// adding replacements, since IDs and free-tier availability both drift.
//
// Reverted 2026-08-27 from 'openrouter/free' ("Free Models Router") back to
// hand-pinned models — the router was the actual cause of trash output
// (raw prompt echo, chain-of-thought leaks, "User Safety: safe"
// classifier-verdict responses), because it randomly lands on whichever
// underlying free model is up, including several that are genuinely unusable
// for this (nemotron-3-super-120b, nemotron-3.5-content-safety, etc).
//
// Live probe across all 15 OpenRouter keys, 5 trials/model, same prompt
// shape as generateTweet/generateFbPost (debug-scratch/probeFreeModels.mjs):
//   - 'openrouter/free'                                   → 1/5 clean (rest: reasoning leak / empty)
//   - 'google/gemma-4-26b-a4b-it:free' (previous pin)      → 0/5 — rate-limited every time
//   - 'minimax/minimax-m3:free'                            → 5/5 clean, ~3.8s avg
//   - 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' → 3/5 clean, 2/5 empty (never trash)
//   - every other live free model tested: HTTP 403, rate-limited, or trash
//
// Follow-up load test (debug-scratch/verifyChosenModels.mjs) — all 15 keys
// against each model, spaced sequential AND fired concurrently at once (the
// realistic worst case: a batch run posting many rows together):
//   - minimax-m3:        13/15 spaced → 7/15 concurrent burst (never trash, only 429s)
//   - nemotron-nano-omni:  9/15 spaced → 2/15 concurrent burst (mostly empty under
//                          load, plus one reasoning-leak on a longer prompt —
//                          correctly caught and rotated, but confirms it's the
//                          weaker of the two). Kept only as a secondary model so
//                          a correlated 429 on minimax alone can't stall the pool.
// Re-run both probe scripts periodically — OpenRouter's free-tier lineup and
// per-model capacity drift, same as the dead-model-ID issue this replaced.
const OPENROUTER_MODELS = [
  'minimax/minimax-m3:free',
  'minimax/minimax-m3:free',
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
];

interface ApiKey {
  key: string;
  baseUrl: string;
  model: string;
  label: string;
}

/** Fisher-Yates shuffle — used so each call's key/model pool starts from a
 * different point instead of always hammering the same (key, model) pair
 * first. */
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

// ── Tiered API key pools ─────────────────────────────────────────────────────
// Per explicit instruction (2026-08-27): NOT one flat shuffled pool anymore.
// Three separate provider tiers, tried in strict order — every Groq key
// first, then every OpenRouter key, then every NVIDIA key. Only moves to the
// next tier once every key in the current one has failed. Within a tier, key
// order is still shuffled so repeated calls don't always hammer the same key
// first; each OpenRouter/Groq key also gets a randomly assigned model from
// its own MODELS list per call, same rationale as before (spread traffic
// across models' independent quotas, not just across keys).

function buildGroqPool(): ApiKey[] {
  const pool: ApiKey[] = [];
  // Supports either a bare GROQ_API_KEY (single key) or GROQ_API_KEY_1..15
  // (multiple keys) — same numbered pattern as OPENROUTER_API_KEY_N.
  const first = process.env['GROQ_API_KEY_1']?.trim() || process.env['GROQ_API_KEY']?.trim();
  if (first) {
    const model = GROQ_MODELS[Math.floor(Math.random() * GROQ_MODELS.length)];
    pool.push({ key: first, baseUrl: GROQ_BASE_URL, model, label: `Groq-1/${model.split('/')[1]}` });
  }
  for (let i = 2; i <= 15; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`]?.trim();
    if (k) {
      const model = GROQ_MODELS[Math.floor(Math.random() * GROQ_MODELS.length)];
      pool.push({ key: k, baseUrl: GROQ_BASE_URL, model, label: `Groq-${i}/${model.split('/')[1]}` });
    }
  }
  return shuffle(pool);
}

function buildOpenRouterPool(): ApiKey[] {
  const pool: ApiKey[] = [];
  for (let i = 1; i <= 15; i++) {
    const k = process.env[`OPENROUTER_API_KEY_${i}`]?.trim();
    if (k) {
      const model = OPENROUTER_MODELS[Math.floor(Math.random() * OPENROUTER_MODELS.length)];
      pool.push({ key: k, baseUrl: OPENROUTER_BASE_URL, model, label: `OpenRouter-${i}/${model.split('/')[1]}` });
    }
  }
  return shuffle(pool);
}

function buildNvidiaPool(): ApiKey[] {
  const pool: ApiKey[] = [];
  for (let i = 1; i <= 4; i++) {
    const envKey = i === 1 ? 'NVIDIA_API_KEY' : `NVIDIA_API_KEY_${i}`;
    const k = process.env[envKey]?.trim();
    if (k) pool.push({ key: k, baseUrl: NVIDIA_BASE_URL, model: NVIDIA_MODEL, label: `NVIDIA-${i}` });
  }
  return shuffle(pool);
}

function buildTieredPools(): ApiKey[][] {
  return [buildGroqPool(), buildOpenRouterPool(), buildNvidiaPool()];
}

// ── Core LLM caller ────────────────────────────────────────────────────────────
// Tries each tier (Groq → OpenRouter → NVIDIA) in order, every key within a
// tier before moving to the next.

function pickRandomCaption(raw: string): string {
  // Split on "---" separator used between the 5 captions
  const parts = raw.split(/\n?---\n?/).map(p => p.trim()).filter(p => p.length > 50);
  if (parts.length === 0) return raw.trim();
  return parts[Math.floor(Math.random() * parts.length)];
}


async function callLLMWithRetry(prompt: string, maxTokens: number, retries = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await callLLM(prompt, maxTokens);
    if (!isRefusal(result)) return result;
    console.warn(`   ⚠️ LLM returned a refusal on attempt ${attempt}/${retries} — retrying...`);
    await new Promise(r => setTimeout(r, 2000));
  }
  // Return last result even if it's a refusal, so the caller can decide what to do
  return await callLLM(prompt, maxTokens);
}

// A `fetch()` throw (not an HTTP error response) means the request never
// reached the server at all — DNS failure, connection refused, no route.
// When every key in the pool fails that way in one pass, it's almost
// certainly a transient local network blip, not 19 simultaneous account
// problems across two unrelated providers (OpenRouter and NVIDIA don't fail
// in sync). Give a real network hiccup a couple of short chances to clear
// before treating the whole pool as exhausted and skipping the row.
const NETWORK_OUTAGE_RETRIES = 2;
const NETWORK_OUTAGE_RETRY_DELAY_MS = 8000;

async function callLLM(prompt: string, maxTokens = 512): Promise<string> {
  // Flattened but tier-ordered: every Groq key, then every OpenRouter key,
  // then every NVIDIA key. Shuffling only happens WITHIN each tier (done in
  // buildGroqPool/buildOpenRouterPool/buildNvidiaPool) — tiers themselves are
  // never interleaved, so Groq is always fully exhausted before OpenRouter is
  // tried, and OpenRouter before NVIDIA.
  const pool = buildTieredPools().flat();
  if (pool.length === 0) throw new Error('No API keys found. Set GROQ_API_KEY_1…_15, OPENROUTER_API_KEY_1…_15, or NVIDIA_API_KEY in .env');

  for (let outageAttempt = 0; outageAttempt <= NETWORK_OUTAGE_RETRIES; outageAttempt++) {
    let allFailuresWereNetworkErrors = true;

    for (let i = 0; i < pool.length; i++) {
      const { key, baseUrl, model, label } = pool[i];

      if (isModelQuarantined(model)) {
        console.log(`   ⏭  ${label} (${i + 1}/${pool.length}): ${model} is quarantined (repeated failures) — skipping`);
        continue;
      }

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
        allFailuresWereNetworkErrors = false; // reached a real HTTP response

        if (res.status === 402 || res.status === 429) {
          // Transient/per-key capacity issue, not a sign the model itself is
          // broken — don't count against its health.
          console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): ${res.status === 402 ? 'no credits' : 'rate limited'} — rotating`);
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          // Any other HTTP error (404/410/400/403...) means this specific
          // model endpoint is broken, not just this key — e.g. exactly how
          // NVIDIA's EOL'd model surfaced (410 on every key).
          recordModelOutcome(model, 'bad', `HTTP ${res.status}`);
          console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): status ${res.status} → ${text.slice(0, 80)} — rotating`);
          continue;
        }

        const json = await res.json() as { choices: Array<{ message: { content: string } }> };
        const raw = json.choices?.[0]?.message?.content?.trim() ?? '';

        if (raw && isDegenerate(raw)) {
          recordModelOutcome(model, 'bad', 'degenerate');
          console.log(`   ⚠️  ${label} (${i + 1}\${pool.length}): degenerate/padding-token response (${raw.length} chars) — rotating`);
          continue;
        }

        if (raw && isReasoningLeak(raw)) {
          recordModelOutcome(model, 'bad', 'reasoning_leak');
          console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): raw chain-of-thought leaked into response — rotating`);
          continue;
        }

        if (raw && isPromptEcho(raw)) {
          recordModelOutcome(model, 'bad', 'prompt_echo');
          console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): echoed the prompt instructions instead of writing a post — rotating`);
          continue;
        }

        if (raw && isSafetyClassifierLeak(raw)) {
          recordModelOutcome(model, 'bad', 'safety_leak');
          console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): returned a safety-classifier verdict instead of a post — rotating`);
          continue;
        }

        const text = stripModelArtifacts(raw).replace(/\s*—\s*/g, ' ').replace(/–/g, '-').trim();
        if (text) {
          recordModelOutcome(model, 'ok');
          return text;
        }
      } catch (err: any) {
        console.log(`   ⚠️  ${label} (${i + 1}/${pool.length}): ${err.message} — rotating`);
        continue;
      }
    }

    if (allFailuresWereNetworkErrors && outageAttempt < NETWORK_OUTAGE_RETRIES) {
      console.log(`   ⚠️  Every key failed at the network level (not HTTP) — looks like a connectivity blip, not exhausted keys. Waiting ${NETWORK_OUTAGE_RETRY_DELAY_MS / 1000}s and retrying the full pool (attempt ${outageAttempt + 2}/${NETWORK_OUTAGE_RETRIES + 1})...`);
      await new Promise(r => setTimeout(r, NETWORK_OUTAGE_RETRY_DELAY_MS));
    }
  }

  throw new Error('All API keys exhausted (OpenRouter + NVIDIA). Add credits or new keys.');
}

// ── Market data fetcher ────────────────────────────────────────────────────────
// Searches Tavily for market size, CAGR, and top competitors. Returns a compact
// context string injected into LLM prompts. Returns empty string on failure.

// Single alternation so a currency-prefixed amount ("USD 8.71 billion") and a
// bare amount ("8.71 billion") never both match the same digits — matching
// each number twice with separate regexes caused a real figure to be blanked
// out immediately after being kept.
const STAT_AMOUNT_RE = /(?:USD|US\$|\$|£|€)\s?[\d,.]+\s*(?:billion|million|trillion|bn|mn|tn|k)?|\b[\d,.]+\s*(?:billion|million|trillion|bn|mn|tn)\b/gi;
const PERCENT_RE = /\d+(?:\.\d+)?\s?%/g;

// Strips currency amounts and percentage/CAGR figures so supporting snippets
// can't hand the LLM a second market-size or growth-rate number to restate.
function stripStatFigures(text: string): string {
  return text
    .replace(STAT_AMOUNT_RE, '[figure omitted]')
    .replace(PERCENT_RE, '[figure omitted]');
}

// Tavily's synthesized "answer" can itself blend numbers from multiple
// reports (e.g. global vs regional). Keep only the first currency figure
// and first percentage figure; blank out any additional ones.
function limitToOneStat(text: string): string {
  let amountSeen = false;
  let pctSeen = false;
  let out = text.replace(STAT_AMOUNT_RE, (m) => {
    if (amountSeen) return '[figure omitted]';
    amountSeen = true;
    return m;
  });
  out = out.replace(PERCENT_RE, (m) => {
    if (pctSeen) return '[figure omitted]';
    pctSeen = true;
    return m;
  });
  return out;
}

// Ken Research market-research competitors — never cite these as a data source.
// Excluded from Tavily search so their figures can't leak into generated posts.
const COMPETITOR_DOMAINS = [
  'mordorintelligence.com', 'imarcgroup.com', 'precedenceresearch.com', 'futuremarketinsights.com',
  'renub.com', 'marketresearchfuture.com', 'marketsandmarkets.com', 'technavio.com',
  'credenceresearch.com', 'marketsandata.com', 'chemanalyst.com', 'psmarketresearch.com',
  'skyquestt.com', 'delveinsight.com', 'strategicmarketresearch.com', 'kbvresearch.com',
  'industryarc.com', 'snsinsider.com', 'market.us', 'techsciresearch.com',
  'towardshealthcare.com', 'fortunebusinessinsights.com', 'intelmarketresearch.com',
  'maximizemarketresearch.com', 'grandviewresearch.com', 'alliedmarketresearch.com',
  'globalmarketinsights.com', 'businessresearchinsights.com', 'verifiedmarketresearch.com',
  'datamintelligence.com', 'sphericalinsights.com', 'marketintelo.com',
];

async function fetchMarketData(
  title: string,
  opts: { advanced?: boolean; maxResults?: number } = {},
): Promise<string> {
  try {
    const query = `${title} market size CAGR value 2024 2025 2030 competition`;
    const maxResults = opts.maxResults ?? 3;
    const res = await callTavily({
      query,
      search_depth: opts.advanced ? 'advanced' : 'basic',
      include_answer: true,
      max_results: maxResults,
      exclude_domains: COMPETITOR_DOMAINS,
    });
    const sections: string[] = [];
    if (res.answer) {
      sections.push(`PRIMARY MARKET DATA (the ONLY market size/CAGR figure allowed in the post):\n${limitToOneStat(res.answer)}`);
    }
    const supporting = res.results
      .slice(0, maxResults - 1)
      .map(r => r.content?.slice(0, 300))
      .filter(Boolean)
      .map(stripStatFigures);
    if (supporting.length) {
      sections.push(`SUPPORTING CONTEXT ONLY (dollar/percentage figures removed on purpose — do not guess or reconstruct them) — use only for growth drivers, competitors, segments, certifications, or secondary references:\n${supporting.join(' | ')}`);
    }
    return sections.join('\n\n').slice(0, 1400);
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

Example A: "Ken Research finds the aerogel market in Bahrain gearing up for a game-changing outlook with surging demand and innovation accelerating growth. Explore the momentum building now: https://example.com #Aerogel #BahrainMarket"

Example B: "Global woodpulp market valued at $52B is set for a 4.2% CAGR through 2030, Ken Research finds, as sustainable packaging demand and Asia-Pacific capacity expansion reshape the competitive landscape. See what's driving the shift: https://example.com #WoodPulp #Sustainability"

Example C: "Ken Research identifies big shifts ahead in the oil gas epc services market as industry momentum builds with exciting changes on the horizon. Full outlook: https://example.com #OilGas #EPCServices"

──────────────────────
FORMAT RULES:
- ONE flowing block – no blank lines anywhere in the tweet body
- 1 or 2 sentences max – no em dashes; use "with", "as", "while", "and" for flow
- MANDATORY: work a short "Ken Research" attribution phrase naturally into the sentence — e.g. "Ken Research finds", "Ken Research identifies", "Ken Research reports", ", Ken Research finds," (mid-sentence). Never omit it, and keep it brief so it fits the character limit.
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
 * Generate a Tumblr caption for a Ken Research report. Tumblr posts go out
 * as a "Link" post type — the platform attaches the URL as its own card, so
 * (unlike generateTweet) the caption must NOT contain the URL at all.
 */
export async function generateTumblrPost(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
  marketValue?: string;
  overLimitBy?: number; // if set, tighten the char limit by this amount
}): Promise<string> {
  const mv = (params.marketValue ?? '').trim();
  const marketValueLine = mv && mv !== '0' && mv !== 'null'
    ? mv
    : '(not available — skip any market size number)';

  const marketData = await fetchMarketData(params.title);
  const marketDataSection = marketData
    ? `REAL MARKET DATA (from web search — use specific numbers if present):\n${marketData}`
    : 'No web data available — use general market language.';

  // Shares the same cross-platform history as X so the same URL doesn't get
  // the same angle/opening/CTA repeated across platforms.
  const pastTweets = getPastTweets(params.url);
  const pastTweetsSection = pastTweets.length > 0
    ? `──────────────────────
PREVIOUSLY POSTED CAPTIONS FOR THIS URL (${pastTweets.length} total, across platforms) — DO NOT reuse:
- Same opening word or phrase
- Same CTA phrase
- Same power phrase
- Same sentence structure or angle

Past captions:
${pastTweets.map((t, i) => `[${i + 1}] ${t}`).join('\n')}
──────────────────────`
    : '';

  const prompt = `You are a market insights social media writer for Tumblr.

STEP 1 – Extract the market name from this URL:
${params.url}

Rules:
- Take only the last path segment
- Replace hyphens with spaces
- Keep ALL words including geo (country, region) – do NOT remove any words
- Example: "bahrain-aerogel-market" → "Bahrain aerogel market"
- Example: "australia-renewable-hydrogen-transport-market" → "Australia renewable hydrogen transport market"

STEP 2 – Write the Tumblr caption in this EXACT style:

Study these real examples carefully – match the tone, structure, and phrasing:

Example A: "Ken Research finds the aerogel market in Bahrain gearing up for a game-changing outlook with surging demand and innovation accelerating growth. Explore the momentum building now."

Example B: "Global woodpulp market valued at $52B is set for a 4.2% CAGR through 2030, Ken Research finds, as sustainable packaging demand and Asia-Pacific capacity expansion reshape the competitive landscape. See what's driving the shift."

Example C: "Ken Research identifies big shifts ahead in the oil gas epc services market as industry momentum builds with exciting changes on the horizon. Read the full outlook."

──────────────────────
FORMAT RULES:
- ONE flowing block – no blank lines anywhere in the caption
- 1 or 2 sentences max – no em dashes; use "with", "as", "while", "and" for flow
- MANDATORY: work a short "Ken Research" attribution phrase naturally into the sentence — e.g. "Ken Research finds", "Ken Research identifies", "Ken Research reports", ", Ken Research finds," (mid-sentence). Never omit it, and keep it brief so it fits the character limit.
- If real market data has CAGR, market size, or competitor names – weave ONE specific number naturally into the caption
- End with a short CTA sentence — do NOT include the URL itself, Tumblr attaches the link as its own card
- Rotate CTA phrases: "Explore the momentum building now.", "Explore the surge shaping the future.", "Read the full outlook.", "Dive into the full picture.", "See what's driving the shift."
- Do not use hashtags or the # symbol anywhere in the caption

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
The full caption must be ${230 - (params.overLimitBy ?? 0)} characters or fewer.${params.overLimitBy ? `\nPrevious attempt was ${params.overLimitBy} characters over — write a shorter, more concise version.` : ''}

──────────────────────
OUTPUT RULES:
- First character must be a letter
- No quotes around the output
- No JSON, no labels, no explanation
- No emojis
- No bullet points
- No hashtags
- No URL anywhere in the output — Tumblr's Link block already shows the link as a card
- Output ONLY the caption text, nothing else
- Never use: "projected to reach", "anticipated to grow", "value expected to reach", "driving innovation", "growing demand for"
- Every caption must feel unique – vary the opening structure each time

${pastTweetsSection}`;

  const raw = await callLLM(prompt, 400);
  const caption = raw.trim();

  // Save to the same shared history as X so future calls for this URL (on
  // any platform) avoid repeating this angle.
  saveTweetToHistory(params.url, caption);

  return caption;
}

/**
 * Generate a Mastodon toot for a Ken Research report. Unlike Tumblr's Link
 * post type, Mastodon has no separate link-card field — the URL must be
 * inside the toot text itself, same as X.
 */
export async function generateMastodonPost(params: {
  url: string;
  title: string;
  marketValue?: string;
  overLimitBy?: number;
}): Promise<string> {
  const utmUrl = `${params.url}${UTM_PARAMS.Mastodon}`;

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
PREVIOUSLY POSTED CAPTIONS FOR THIS URL (${pastTweets.length} total, across platforms) — DO NOT reuse:
- Same opening word or phrase
- Same CTA phrase
- Same power phrase
- Same sentence structure or angle

Past captions:
${pastTweets.map((t, i) => `[${i + 1}] ${t}`).join('\n')}
──────────────────────`
    : '';

  const prompt = `You are a market insights social media writer for Mastodon.

STEP 1 – Extract the market name from this URL:
${params.url}

Rules:
- Take only the last path segment
- Replace hyphens with spaces
- Keep ALL words including geo (country, region) – do NOT remove any words
- Example: "bahrain-aerogel-market" → "Bahrain aerogel market"

STEP 2 – Write the Mastodon toot in this EXACT style:

Example A: "Ken Research finds the aerogel market in Bahrain gearing up for a game-changing outlook with surging demand and innovation accelerating growth. Explore the momentum building now: https://example.com #Aerogel #BahrainMarket"

Example B: "Global woodpulp market valued at $52B is set for a 4.2% CAGR through 2030, Ken Research finds, as sustainable packaging demand and Asia-Pacific capacity expansion reshape the competitive landscape. See what's driving the shift: https://example.com #WoodPulp #Sustainability"

──────────────────────
FORMAT RULES:
- ONE flowing block – no blank lines anywhere in the toot body
- 1 or 2 sentences max – no em dashes; use "with", "as", "while", "and" for flow
- MANDATORY: work a short "Ken Research" attribution phrase naturally into the sentence — e.g. "Ken Research finds", "Ken Research identifies", "Ken Research reports", ", Ken Research finds," (mid-sentence). Never omit it, and keep it brief so it fits the character limit.
- If real market data has CAGR, market size, or competitor names – weave ONE specific number naturally into the toot
- End with a short CTA phrase + colon, then the URL on the same line
- Then a space, then two hashtags
- Rotate CTA phrases: "Explore the momentum building now:", "Explore the surge shaping the future:", "Full outlook:", "Dive into the full picture:", "See what's driving the shift:"

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
The full toot text (excluding the URL) must be ${400 - (params.overLimitBy ?? 0)} characters or fewer — Mastodon's limit is 500 characters total, leave room for the URL and hashtags.
The URL does not count toward this limit.${params.overLimitBy ? `\nPrevious attempt was ${params.overLimitBy} characters over — write a shorter, more concise version.` : ''}

──────────────────────
OUTPUT RULES:
- First character must be a letter
- No quotes around the output
- No JSON, no labels, no explanation
- No emojis
- No bullet points
- Output ONLY the toot text, nothing else
- The URL in your output must be exactly: ${utmUrl}
- Never use: "projected to reach", "anticipated to grow", "value expected to reach", "driving innovation", "growing demand for"
- Every toot must feel unique – vary the opening structure each time

${pastTweetsSection}`;

  const raw = await callLLM(prompt, 400);
  const toot = raw.trim();

  let finalToot = toot;
  if (!finalToot.includes(utmUrl)) {
    const fixed = finalToot.replace(/https?:\/\/[^\s]+kenresearch[^\s]*/gi, utmUrl);
    finalToot = fixed.includes(utmUrl) ? fixed : `${finalToot}\n${utmUrl}`;
  }

  saveTweetToHistory(params.url, finalToot);
  return finalToot;
}

/**
 * Generate a short save-note for a Ken Research report on a bookmarking
 * platform (Instapaper / Raindrop). The URL is stored as the bookmark's own
 * link field, not inside the note — same reasoning as Tumblr's Link post.
 */
// SBM platforms (Pearltrees/Instapaper/Raindrop) never use any API
// key — this is a pure template, no LLM call and no Tavily lookup (Tavily
// is itself a keyed API). Deliberately simple: these are bookmark notes,
// not real posts, so there's no need to burn LLM quota on them.
const BOOKMARK_NOTE_TEMPLATES = [
  (title: string, mv: string) => `${title}${mv ? ` (${mv})` : ''}. Saved for a deeper read on the competitive landscape.`,
  (title: string) => `${title}. Worth revisiting for market size, growth drivers, and competitor coverage.`,
  (title: string, mv: string) => `${title}${mv ? ` — market valued at ${mv}` : ''}. Bookmarked for later reading.`,
  (title: string) => `${title}. Saved for the full breakdown of segments and outlook.`,
];

export async function generateBookmarkNote(params: {
  url: string;
  title: string;
  marketValue?: string;
  overLimitBy?: number;
}): Promise<string> {
  const mv = (params.marketValue ?? '').trim();
  const hasValue = !!(mv && mv !== '0' && mv !== 'null');

  const template = BOOKMARK_NOTE_TEMPLATES[Math.floor(Math.random() * BOOKMARK_NOTE_TEMPLATES.length)];
  let note = template(params.title, hasValue ? mv : '');

  const limit = 280 - (params.overLimitBy ?? 0);
  if (note.length > limit) note = note.slice(0, Math.max(0, limit - 1)).trimEnd() + '.';

  return note;
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
- MANDATORY: at least one tweet in the thread (tweet 1 or 2 is ideal) must naturally include a short "Ken Research" attribution phrase — e.g. "Ken Research finds", "Ken Research identifies", ", Ken Research finds," (mid-sentence). Never omit it from the whole thread.
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
 * Generate a Facebook or LinkedIn post for a Ken Research report.
 * Both platforms share the same pool of 3 prompts, picked at random.
 */

function dataBlock(marketDataSection: string): string {
  return `${marketDataSection}

From the market data above, extract: Market Name, Country/Region, latest available base year, base year market size, forecast market size + forecast year, CAGR + forecast period, 3-6 key growth drivers, 3 key segments, competitive landscape (named companies / organized vs unorganized / concentration), 2-3 whitespace opportunities, and 2-3 key risks or constraints.
If a specific data point above is genuinely not present in the market data, write [DATA NEEDED] for it instead of inventing it. Only use [SECONDARY DATA NEEDED] / [LATEST BASE YEAR NEEDED] where a rule below explicitly calls for it and no such data is available.

ONE CLEAN NUMBER RULE (critical): The entire post may contain exactly ONE market-size figure (one dollar/currency amount) and exactly ONE CAGR percentage, both taken from PRIMARY MARKET DATA. This applies everywhere in the post — the opening hook, every numbered fact/signal, the strategic section, and the closing — not just the first mention.
SUPPORTING CONTEXT may still be used, but ONLY reworded as qualitative facts with no dollar figure and no CAGR/percentage-growth-rate attached: growth drivers, named competitors, certifications, regulations, segments, or directional statements (e.g. "the broader fencing category is also expanding" is allowed; "the broader fencing market is valued at $54.92 billion, growing at 5.6% CAGR" is NOT allowed).
If a fact from SUPPORTING CONTEXT cannot be stated without also citing its own market-size or CAGR number, drop that fact entirely rather than include a second statistic.
Before finalizing, scan the draft: if more than one currency amount or more than one CAGR/percentage-growth figure appears anywhere in the post, delete all but the one from PRIMARY MARKET DATA.`;
}

// ── Prompt 1: Independent analyst, evidence-based, no branding push ─────────
function buildPrompt1(utmUrl: string, title: string, marketDataSection: string, currentYear: number): string {
  return `Act as an independent senior market analyst and strategy consultant.
You are writing a factual LinkedIn post from an independent point of view using Ken Research data as the source material.
Do not write like a brand copywriter.
Do not write like Ken Research is promoting itself.
Do not use "we", "our", or "at Ken Research".
Write like a consultant analyzing the market and using the executive summary as the evidence base.

Report Title: ${title}
Executive Summary Website Link: ${utmUrl}
Source: Ken Research Executive Summary
TODAY'S DATE: ${new Date().toISOString().split('T')[0]}
CURRENT YEAR: ${currentYear}

${dataBlock(marketDataSection)}

Target Audience: CEOs, founders, investors, strategy leaders, business heads, consultants, and market expansion teams.

Objective:
Create a highly factual LinkedIn caption that drives engagement and redirects readers to the Ken Research executive summary website link without sounding promotional.

Writing Angle:
The post should read like an independent market observation. It should explain what the data suggests, why the market matters, where the opportunity is forming, and what decision-makers should evaluate before entering, investing, or expanding. The executive summary link should be used as the clear next step for readers who want the detailed market breakdown.

Tone: Independent. Factual. Analytical. Consulting-style. Sharp. Credible. No hype. No exaggerated language. No sales pitch.

Strict Rules:
- Do not invent any number, company, CAGR, segment, or market fact.
- Every number must include the year or forecast period.
- Use "estimated", "projected", or "expected" only for forecast numbers.
- Do not use promotional words like booming, massive, revolutionary, game-changing, or unstoppable.
- Do not say "Ken Research has mapped" or "our latest report".
- Mention Ken Research only as the data source.
- If any required data point is missing, write [DATA NEEDED] instead of assuming.
- The post should not sound like an advertisement.
- The executive summary should feel like supporting evidence, not the main subject.
- Use the exact Executive Summary Website Link given above (${utmUrl}). Do not change, shorten, rewrite, or remove it.
- Place the website link after a clear CTA line.
- Do not use more than one link in the caption.

Caption Structure:
1. Start with a strong factual market opening using market size, forecast size, CAGR, or a key market shift.
2. Explain why the headline number is not enough to understand the opportunity.
3. Add 4 to 6 factual market signals in numbered format.
4. Interpret what these signals mean for business leaders, investors, or expansion teams.
5. Identify the main strategic question decision-makers should ask.
6. Add a soft CTA that redirects users to the executive summary website link.
7. Mention that the data is based on Ken Research's executive summary.
8. End with a thoughtful engagement question.
9. Add 3 to 5 relevant hashtags.

CTA Format — use exactly this structure near the end (or one of the alternatives below, followed by the link on its own line):
Read the executive summary here:
${utmUrl}
Alternative CTA lines (use only one if it fits better): "Explore the full market breakdown here:" / "Review the executive summary here:" / "Access the detailed market snapshot here:" — each followed by ${utmUrl} on its own line.

Length: Write between 1,800 and 2,000 characters maximum. Do not pad to fill space.

Formatting:
- Use short sentences.
- Use line breaks after every 1 to 2 sentences.
- Make the caption mobile-friendly.
- Avoid long paragraphs.
- Keep the writing clean and executive-level.

Output: Only provide the final LinkedIn caption. Do not explain the caption. Do not include notes. Do not include placeholders except where input data is genuinely missing.`;
}

// ── Prompt 2: Independent analyst + secondary research + branding keywords ──
function buildPrompt2(utmUrl: string, title: string, marketDataSection: string, currentYear: number): string {
  return `Act as an independent senior market analyst and strategy consultant.
You are writing a factual LinkedIn post from an independent point of view using Ken Research data as the primary source material, supported by credible secondary research where required.
Do not write like a brand copywriter.
Do not write like Ken Research is promoting itself.
Do not use "we", "our", or "at Ken Research".
Write like a consultant analyzing market signals using Ken Research Executive Summary data, latest available base-year information, and supporting secondary research.

Report Title: ${title}
Executive Summary Website Link: ${utmUrl}
Primary Source: Ken Research Executive Summary
Secondary Sources: use only credible sources such as government databases, regulators, industry associations, company annual reports, investor presentations, World Bank, IMF, OECD, Statista, trade bodies, news reports, or verified market disclosures if such context is present in the data below.
TODAY'S DATE: ${new Date().toISOString().split('T')[0]}
CURRENT YEAR: ${currentYear}

${dataBlock(marketDataSection)}
Identify 4-6 factual data signals (numbers, years, segments, or trends) from the market data for use below. If fewer than 4 clear signals are present, use what is available rather than inventing more.

Ken Research Branding Keywords to Use Naturally (use 5 to 8 of these where they add meaning — do not force all of them, do not keyword-stuff):
Market intelligence, executive summary, market attractiveness, whitespace opportunities, sunrise categories, go-to-market strategy, competition benchmarking, market expansion opportunities, operational viability, financial viability, growth strategy, strategic business consulting, demand-side shifts, category-level analysis, decision-ready intelligence, market entry assessment, hypothesis validation, secondary research, latest base year, forecast outlook.
Ken Research should be mentioned only as the data source and in the CTA/source section — the post should still read like an independent market analysis.

Secondary Research Rules:
- Use Ken Research Executive Summary as the primary source.
- Use secondary research only to strengthen, validate, or contextualize the market signals.
- Do not overwrite Ken Research data unless the secondary source clearly provides a more recent or more authoritative figure.
- If secondary sources show a different figure, mention it cautiously as a range or context.
- Do not invent secondary research sources or mention weak/unverified ones.
- If secondary data is unavailable, write [SECONDARY DATA NEEDED].

Latest Base Year Rules:
- Use the latest available base year from the data. Every market size number must state the exact year; every forecast number must state the exact forecast year; every CAGR must state the full forecast period.
- If the latest base year is not available, write [LATEST BASE YEAR NEEDED].

Target Audience: CEOs, founders, investors, strategy leaders, business heads, consultants, and market expansion teams.

Objective:
Create a highly factual LinkedIn caption that uses data signals, latest base-year information, and secondary research to drive engagement and redirect readers to the Ken Research executive summary website link without sounding promotional. Strengthen Ken Research's association with market intelligence, strategic business consulting, market attractiveness, whitespace opportunities, competition benchmarking, market expansion opportunities, and decision-ready intelligence.

Writing Angle:
The post should read like an independent market signal analysis — what the latest data indicates, what is changing, and why decision-makers should pay attention. The executive summary link is the next step for readers who want the complete market breakdown.

Tone: Independent. Factual. Analytical. Consulting-style. Sharp. Credible. Evidence-led. Research-backed. Boardroom-ready. No hype. No exaggerated language. No sales pitch.

Strict Rules:
- Do not invent any number, company, CAGR, segment, market fact, source, or signal.
- Every number must include the year, period, or forecast range.
- Use "estimated", "projected", or "expected" only for forecast numbers.
- Do not use promotional words like booming, massive, revolutionary, game-changing, or unstoppable.
- Do not say "Ken Research has mapped", "our latest report", or "we believe".
- Mention Ken Research only as the data source.
- If any required data point is missing, write [DATA NEEDED] instead of assuming.
- The post should not sound like an advertisement; the executive summary should feel like supporting evidence, not the main subject.
- Use the exact Executive Summary Website Link given above (${utmUrl}). Do not change, shorten, rewrite, or remove it. Do not use more than one website link in the caption.
- Maintain subtle Ken Research branding through language, not direct promotion.

Caption Structure:
1. Start with: "5 data-backed signals are shaping the [Market Name] market." (use the real market name)
2. Add one short context line on why the latest base-year data matters.
3. Present the factual market signals in numbered format (as many as are genuinely supported by the data, ideally 4-5). Each signal: a signal name, one factual sentence with year/number/source context, and one interpretation sentence on what it means for decision-makers.
4. Add a strategic interpretation section answering: what do these signals suggest; where is market attractiveness increasing; where are whitespace opportunities forming; which sunrise categories need closer evaluation; what should leaders/investors/expansion teams assess before acting; how does competition benchmarking change the view; where do operational and financial viability need deeper validation.
5. Add one sharp strategic question, e.g.: "The key question is not whether the market is growing. The key question is where growth is concentrated, defensible, and commercially viable."
6. Add a soft CTA redirecting to the executive summary link.

CTA Format — use exactly this structure near the end (or one alternative below), followed by the link on its own line:
Read the executive summary here:
${utmUrl}
Alternatives (use only one if it fits better): "Explore the full market intelligence brief here:" / "Review the full market breakdown here:" / "Access the detailed market snapshot here:"

Then mention sources clearly in this format:
Primary data source: Ken Research Executive Summary.
Secondary references: [name the secondary sources actually used, or [SECONDARY DATA NEEDED] if none were available].

End with a thoughtful engagement question (e.g. "Which signal would you prioritize before entering this market?").

Hashtags: Add 3 to 5 relevant hashtags. Always include #KenResearch. Do not overload the post with hashtags.

Length: Write between 1,800 and 2,000 characters maximum. Do not pad to fill space.

Formatting:
- Use short sentences, line breaks after every 1 to 2 sentences, mobile-friendly, no long paragraphs, clean executive-level writing.

Output: Only provide the final LinkedIn caption. No explanation, no notes, no placeholders except where input data is genuinely missing.`;
}

// ── Prompt 3: Decision-maker-only brief, engagement angle + secondary data ──
function buildPrompt3(utmUrl: string, title: string, marketDataSection: string, currentYear: number): string {
  return `Act as an independent senior market analyst and strategy consultant.
You are writing a factual LinkedIn post for decision-makers only — not general readers, students, job seekers, or broad followers. The audience includes CEOs, founders, investors, PE/VC teams, strategy leaders, business unit heads, corporate development teams, market expansion leaders, and senior consultants.
You are using Ken Research Executive Summary data as the primary source, supported by latest credible secondary research where Ken Research data is missing, outdated, or needs context.
Do not write like a brand copywriter. Do not write like Ken Research is promoting itself. Do not use "we", "our", or "at Ken Research".
Write like a consultant presenting a market view for people who need to make entry, investment, expansion, acquisition, partnership, competitive positioning, or capital allocation decisions.

Report Title: ${title}
Executive Summary Website Link: ${utmUrl}
Primary Source: Ken Research Executive Summary
TODAY'S DATE: ${new Date().toISOString().split('T')[0]}
CURRENT YEAR: ${currentYear}

${dataBlock(marketDataSection)}
Also identify (from the data, or secondary sources referenced within it): 4-5 decision-relevant facts each paired with a decision-maker implication, and 1-2 secondary-research-backed context points that validate or contextualize the Ken Research figures (label them clearly as secondary references; if none are present, write [SECONDARY DATA NEEDED]).

Ken Research Branding Keywords to Use Naturally (use 6 to 10 of these where they add meaning — do not force all, do not keyword-stuff):
Market intelligence, executive summary, market attractiveness, whitespace opportunities, sunrise categories, go-to-market strategy, competition benchmarking, market expansion opportunities, operational viability, financial viability, growth strategy, strategic business consulting, demand-side shifts, category-level analysis, decision-ready intelligence, market entry assessment, hypothesis validation, secondary research, latest base year, forecast outlook, capital allocation, strategic entry, commercial viability, demand depth, pricing power, margin potential, regulatory exposure.

Latest Base Year / Secondary Research Rules:
- Use the latest available base-year number as the main market number; label any secondary numbers clearly as secondary references and never falsely attribute them to Ken Research.
- If both Ken Research and secondary sources are used, phrase it as: "Based on Ken Research Executive Summary, supported by latest secondary indicators from [Source 1] and [Source 2]."
- Every number must include year, period, or forecast range.
- If latest base-year data is unavailable, write [LATEST BASE YEAR NEEDED]. If secondary data is unavailable, write [SECONDARY DATA NEEDED].

Objective:
Create a highly factual LinkedIn caption that redirects senior decision-makers to the Ken Research executive summary website link. Drive engagement, comments, saves, and clicks by making the market decision feel urgent, specific, and commercially relevant. Help decision-makers understand: is this market attractive, where is the commercial opportunity, which segments deserve attention, where are whitespace opportunities forming, what risks need validation, and what should be checked before entry, investment, expansion, partnership, or acquisition.

Engagement Angle — pick ONE that fits the data best:
- Contrarian decision angle, e.g. "The market is attractive, but not every segment deserves capital."
- Boardroom question angle, e.g. "Before entering this market, the first question should not be CAGR. It should be commercial viability."
- Capital allocation angle, e.g. "For investors and expansion teams, the issue is not whether demand exists. The issue is where demand converts into profitable growth."
- Risk-validation angle, e.g. "The opportunity is visible. The risk is assuming that all growth pockets are equally scalable."
- Whitespace angle, e.g. "The real opportunity may not sit in the largest segment. It may sit in the least contested one."

Writing Angle: Do not educate broadly. Help decision-makers frame the market. Focus on business decisions, not general awareness. Position the executive summary as a decision-support resource for market entry, growth strategy, competition benchmarking, market expansion evaluation, and capital allocation.

Tone: Independent. Factual. Analytical. Boardroom-ready. Commercially sharp. Evidence-led. Research-backed. Decision-focused. Engagement-oriented. No hype. No exaggerated claims. No sales pitch. No generic educational tone.

Strict Rules:
- Do not invent any number, company, CAGR, segment, market fact, source, or signal.
- Every number must include the year, period, or forecast range. Use "estimated"/"projected"/"expected" only for forecast numbers.
- Do not use promotional words like booming, massive, revolutionary, game-changing, or unstoppable.
- Do not say "Ken Research has mapped", "our latest report", "we believe", or "we have released". Mention Ken Research only as the primary source.
- If a required data point is missing, write [DATA NEEDED]; keep [SECONDARY DATA NEEDED] / [LATEST BASE YEAR NEEDED] where noted above.
- Do not write for general readers or explain basic market concepts. Do not make the post sound like awareness content or an advertisement.
- Use the exact Executive Summary Website Link given above (${utmUrl}). Do not change, shorten, rewrite, or remove it. Do not use more than one website link in the caption.
- Keep the post factual, but make the opening strong enough to stop senior decision-makers from scrolling.

Caption Structure:
1. Decision-maker hook, e.g. "For decision-makers evaluating [Market Name], the headline market size is only the first layer." or "Before allocating capital to [Market Name], decision-makers need to separate market growth from investable growth."
2. Latest base-year fact, e.g. "Ken Research places the market at [figure] in [Year]. Latest secondary indicators from [Source] show [figure/trend] in [Year]." (omit secondary sentence if none available)
3. One line on why the market needs decision-level evaluation (demand depth, competition intensity, regulatory exposure, operational viability, pricing power, segment-level profitability).
4. 4 to 5 decision-relevant facts, each with a factual statement and a "Decision-maker implication:" line.
5. 1-2 secondary-research-backed context points (do not let them overpower the Ken Research data).
6. Strategic interpretation section answering: where is market attractiveness increasing; where are whitespace opportunities forming; which segments are commercially viable; how does competition benchmarking change the view; which risks affect entry/investment/expansion/acquisition; where do operational and financial viability need deeper validation.
7. One sharp decision-maker question, e.g. "The key question is not whether the market is growing. The key question is which segment is attractive, scalable, defensible, and financially viable."
8. Soft CTA with the executive summary link.

CTA Format — use exactly this structure (or one alternative below), followed by the link on its own line:
For decision-makers evaluating this market, read the executive summary here:
${utmUrl}
Alternatives (use only one if it fits better): "Review the full market intelligence brief here:" / "Access the detailed market snapshot here:" / "Explore the decision-ready market breakdown here:"

Then state sources clearly:
Primary source: Ken Research Executive Summary.
Secondary references: [name the secondary sources actually used, or [SECONDARY DATA NEEDED] if none available].

End with a decision-focused engagement question, e.g. "Would you prioritize demand depth, competition intensity, pricing power, regulatory exposure, or margin potential before entering this market?"

Hashtags: Add 3 to 5 relevant hashtags. Always include #KenResearch. Do not overload the post with hashtags.

Length: Write between 1,800 and 2,000 characters maximum. Do not pad to fill space.

Formatting: Short sentences. Line breaks after every 1 to 2 sentences. Mobile-friendly. Avoid long paragraphs. Use numbered points. One sharp question before the CTA. One engagement question at the end. Clean, executive-level writing.

Output: Only provide the final LinkedIn caption. No explanation, no notes, no placeholders except where input data is genuinely missing.`;
}

const SHARED_PROMPT_BUILDERS = [buildPrompt1, buildPrompt2, buildPrompt3];

function buildSharedPrompt(
  platform: 'fb' | 'li',
  utmUrl: string,
  title: string,
  marketDataSection: string,
  currentYear: number,
): { label: string; prompt: string } {
  const pick = Math.floor(Math.random() * SHARED_PROMPT_BUILDERS.length);
  const raw = SHARED_PROMPT_BUILDERS[pick](utmUrl, title, marketDataSection, currentYear);
  const platformLabel = platform === 'fb' ? 'Facebook' : 'LinkedIn';
  const prompt = platform === 'fb' ? raw.replace(/LinkedIn/g, platformLabel) : raw;
  return { label: `Prompt-${pick + 1}`, prompt };
}

// TEMP DEBUG HELPER — remove after manual prompt testing is done.
export async function __debugGenerateWithPrompt(
  promptIndex: 1 | 2 | 3,
  platform: 'fb' | 'li',
  params: { url: string; title: string },
): Promise<{ prompt: string; output: string }> {
  const utmUrl = `${params.url}${platform === 'fb' ? UTM_PARAMS.Facebook : UTM_PARAMS.LinkedIn}`;
  const marketData = await fetchMarketData(params.title);
  const marketDataSection = marketData
    ? `REAL MARKET DATA (from web search — use specific numbers, CAGR, market size, competitors if present):\n${marketData}`
    : 'No web data available — use general market language without inventing numbers; use [DATA NEEDED] for anything not derivable.';
  const currentYear = new Date().getFullYear();
  const raw = SHARED_PROMPT_BUILDERS[promptIndex - 1](utmUrl, params.title, marketDataSection, currentYear);
  const platformLabel = platform === 'fb' ? 'Facebook' : 'LinkedIn';
  const prompt = platform === 'fb' ? raw.replace(/LinkedIn/g, platformLabel) : raw;
  const output = await callLLMWithRetry(prompt, 1600);
  return { prompt, output };
}

// ── V2 prompt flow ───────────────────────────────────────────────────────────
// 5 full prompt templates (user-authored). Logic: pick one at random, append
// one line naming the URL + title, send as-is to the LLM, return the raw
// output. No structured data extraction, no Tavily lookup — the template's
// own [DATA NEEDED]-style rules handle anything it can't know.
// buildPrompt1/2/3/buildSharedPrompt above are kept, unused, for reference.
// The prior FB_STYLES/LI_STYLES prompt set is no longer in this file but is
// still recoverable from git history (commit a44d5f6) if ever needed.

const LI_PROMPT_TEMPLATES: string[] = [
  // Prompt 1 — independent analyst, Ken Research as sole source
  `Act as an independent senior market analyst and strategy consultant.
You are writing a factual LinkedIn post from an independent point of view using Ken Research data as the source material.
Do not write like a brand copywriter.
Do not write like Ken Research is promoting itself.
Do not use "we", "our", or "at Ken Research".
Write like a consultant analyzing the market and using the executive summary as the evidence base.
Source:
Ken Research Executive Summary
Target Audience:
CEOs, founders, investors, strategy leaders, business heads, consultants, and market expansion teams.
Objective:
Create a highly factual LinkedIn caption that drives engagement and redirects readers to the Ken Research executive summary website link without sounding promotional.
Writing Angle:
The post should read like an independent market observation.
It should explain what the data suggests, why the market matters, where the opportunity is forming, and what decision-makers should evaluate before entering, investing, or expanding.
The executive summary link should be used as the clear next step for readers who want the detailed market breakdown.
Tone:
Independent. Factual. Analytical. Consulting-style. Sharp. Credible. No hype. No exaggerated language. No sales pitch.
Strict Rules:
Do not invent any number, company, CAGR, segment, or market fact.
Every number must include the year or forecast period.
Use "estimated", "projected", or "expected" only for forecast numbers.
Do not use promotional words like booming, massive, revolutionary, game-changing, or unstoppable.
Do not say "Ken Research has mapped" or "our latest report".
Mention Ken Research only as the data source.
Never name or cite any market-research firm other than Ken Research (e.g. Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, Research and Markets, The Business Research Company, Global Info Research, 6Wresearch, GlobalData, Grand View Research, Fortune Business Insights, Verified Market Research, or similar) — they are Ken Research's direct competitors and must never appear anywhere in this post. The only sources you may name are Ken Research itself, government/regulatory bodies, and multilateral institutions (UN, WHO, World Bank, IMF, OECD). If a figure in the source material is only attributable to a competing research firm, use the figure without naming its source, or omit it entirely.
If any required data point is missing, write [DATA NEEDED] instead of assuming.
The post should not sound like an advertisement.
The executive summary should feel like supporting evidence, not the main subject.
Use the exact Executive Summary Website Link provided in the input. Do not change, shorten, rewrite, or remove the website link.
Place the website link after a clear CTA line.
Do not use more than one link in the caption.
Caption Structure:
1. Start with a strong factual market opening using market size, forecast size, CAGR, or a key market shift.
2. Explain why the headline number is not enough to understand the opportunity.
3. Add 4 to 6 factual market signals in numbered format.
4. Interpret what these signals mean for business leaders, investors, or expansion teams.
5. Identify the main strategic question decision-makers should ask.
6. Add a soft CTA that redirects users to the executive summary website link.
7. Mention that the data is based on Ken Research's executive summary.
8. End with a thoughtful engagement question.
9. Add 3 to 5 relevant hashtags.
CTA Format:
Use this exact structure near the end of the caption:
Read the executive summary here:
[Insert Executive Summary URL]
Alternative CTA options (use only one if it fits better): "Explore the full market breakdown here:" / "Review the executive summary here:" / "Access the detailed market snapshot here:" — each followed by [Insert Executive Summary URL].
Length:
Write between 1,800 and 2,000 characters maximum. Do not pad to fill space.
Formatting:
Use short sentences. Use line breaks after every 1 to 2 sentences. Make the caption mobile-friendly. Avoid long paragraphs. Keep the writing clean and executive-level.
Output:
Only provide the final LinkedIn caption. Do not explain the caption. Do not include notes. Do not include placeholders except where input data is missing.`,

  // Prompt 2 — independent analyst + secondary research + branding keywords
  `Act as an independent senior market analyst and strategy consultant.
You are writing a factual LinkedIn post from an independent point of view using Ken Research data as the primary source material, supported by credible secondary research where required.
Do not write like a brand copywriter.
Do not write like Ken Research is promoting itself.
Do not use "we", "our", or "at Ken Research".
Write like a consultant analyzing market signals using Ken Research Executive Summary data, latest available base-year information, and supporting secondary research.
Primary Source:
Ken Research Executive Summary
Secondary Sources:
Use only credible sources such as government databases, regulatory bodies, industry associations, company annual reports, investor presentations, World Bank, IMF, OECD, trade bodies, news reports, or verified market disclosures — if such context is available.
Never name or cite any market-research firm other than Ken Research (e.g. Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, Research and Markets, The Business Research Company, Global Info Research, 6Wresearch, GlobalData, Grand View Research, Fortune Business Insights, Statista, Verified Market Research, or similar) — they are Ken Research's direct competitors and must never appear anywhere in this post, including in the "Secondary references" line. If a figure is only attributable to a competing research firm, use the figure without naming its source, or omit it entirely.
Ken Research Branding Keywords to Use Naturally:
Market intelligence, executive summary, market attractiveness, whitespace opportunities, sunrise categories, go-to-market strategy, competition benchmarking, market expansion opportunities, operational viability, financial viability, growth strategy, strategic business consulting, demand-side shifts, category-level analysis, decision-ready intelligence, market entry assessment, hypothesis validation, secondary research, latest base year, forecast outlook.
Keyword Usage Rules:
Use 5 to 8 of the above keywords naturally inside the caption. Do not force all keywords. Do not keyword-stuff. Use keywords only where they add meaning. The post should still read like an independent market analysis. Ken Research should be mentioned only as the data source and in the CTA/source section.
Secondary Research Rules:
Use Ken Research Executive Summary as the primary source. Use secondary research only to strengthen, validate, or contextualize the market signals. Do not overwrite Ken Research data unless the secondary source clearly provides a more recent or more authoritative figure. If secondary sources show a different figure, mention it cautiously as a range or context. Do not invent secondary research sources. Do not mention weak or unverified sources. If secondary data is unavailable, write [SECONDARY DATA NEEDED].
Latest Base Year Rules:
Use the latest available base year from the Ken Research Executive Summary. Every market size number must mention the exact year. Every forecast number must mention the exact forecast year. Every CAGR must mention the full forecast period. If the latest base year is not available, write [LATEST BASE YEAR NEEDED].
Target Audience:
CEOs, founders, investors, strategy leaders, business heads, consultants, and market expansion teams.
Objective:
Create a highly factual LinkedIn caption that uses data signals, latest base-year information, and secondary research to drive engagement and redirect readers to the Ken Research executive summary website link without sounding promotional. The caption should strengthen Ken Research's association with market intelligence, strategic business consulting, market attractiveness, whitespace opportunities, competition benchmarking, market expansion opportunities, and decision-ready intelligence.
Writing Angle:
The post should read like an independent market signal analysis — what the latest data is indicating, what is changing in the market, and why decision-makers should pay attention. The executive summary link should be positioned as the next step for readers who want the complete market breakdown.
Tone:
Independent. Factual. Analytical. Consulting-style. Sharp. Credible. Evidence-led. Research-backed. Boardroom-ready. No hype. No exaggerated language. No sales pitch.
Strict Rules:
Do not invent any number, company, CAGR, segment, market fact, source, or signal. Every number must include the year, period, or forecast range. Use "estimated", "projected", or "expected" only for forecast numbers. Do not use promotional words like booming, massive, revolutionary, game-changing, or unstoppable. Do not say "Ken Research has mapped", "our latest report", or "we believe". Mention Ken Research only as the data source. If any required data point is missing, write [DATA NEEDED] instead of assuming. The post should not sound like an advertisement; the executive summary should feel like supporting evidence, not the main subject. Use the exact Executive Summary Website Link provided in the input. Do not change, shorten, rewrite, or remove the website link. Place the website link after a clear CTA line. Do not use more than one website link in the caption. Use only factual signals provided or validated through credible secondary research. Maintain subtle Ken Research branding through language, not direct promotion.
Caption Structure:
1. Start with: "5 data-backed signals are shaping the [Market Name] market."
2. Add one short context line explaining why the latest base-year data matters.
3. Present 5 factual market signals in numbered format, each with a signal name, one factual sentence with year/number/source context, and one interpretation sentence on what it means for decision-makers.
4. Add a strategic interpretation section answering: what do these signals suggest; where is market attractiveness increasing; where are whitespace opportunities forming; which sunrise categories need closer evaluation; what should leaders/investors/expansion teams assess before acting; how does competition benchmarking change the view; where do operational and financial viability need deeper validation.
5. Add one sharp strategic question, e.g. "The key question is not whether the market is growing. The key question is where growth is concentrated, defensible, and commercially viable."
6. Add a soft CTA that redirects users to the executive summary website link.
CTA Format:
Read the executive summary here:
[Insert Executive Summary URL]
Alternatives (use only one if it fits better): "Explore the full market intelligence brief here:" / "Review the full market breakdown here:" / "Access the detailed market snapshot here:"
Then mention the source clearly, in this format:
Primary data source: Ken Research Executive Summary.
Secondary references: [Insert secondary source names used, or [SECONDARY DATA NEEDED] if none available].
End with a thoughtful engagement question (e.g. "Which signal would you prioritize before entering this market?").
Hashtag Rule:
Add 3 to 5 relevant hashtags. Always include #KenResearch. Do not overload the post with hashtags.
Length:
Write between 1,800 and 2,000 characters maximum. Do not pad to fill space.
Formatting:
Use short sentences. Use line breaks after every 1 to 2 sentences. Make the caption mobile-friendly. Avoid long paragraphs. Keep the writing clean and executive-level.
Output:
Only provide the final LinkedIn caption. Do not explain the caption. Do not include notes. Do not include placeholders except where input data is missing.`,

  // Prompt 3 — decision-maker-only brief, engagement angle + secondary data
  `Act as an independent senior market analyst and strategy consultant.
You are writing a factual LinkedIn post for decision-makers only. The audience is not general readers, students, job seekers, or broad LinkedIn followers. The audience includes CEOs, founders, investors, PE/VC teams, strategy leaders, business unit heads, corporate development teams, market expansion leaders, and senior consultants.
You are using Ken Research Executive Summary data as the primary source, supported by latest credible secondary research where Ken Research data is missing, outdated, or needs context.
Do not write like a brand copywriter. Do not write like Ken Research is promoting itself. Do not use "we", "our", or "at Ken Research".
Write like a consultant presenting a market view for people who need to make entry, investment, expansion, acquisition, partnership, competitive positioning, or capital allocation decisions.
Primary Source: Ken Research Executive Summary.
Secondary Sources Allowed: government databases, regulatory bodies, industry associations, company annual reports, investor presentations, SEC filings, FDA/CDC/NIH/World Bank/IMF/OECD, trade bodies, reputed publications, verified company disclosures.
Never name or cite any market-research firm other than Ken Research (e.g. Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, Research and Markets, The Business Research Company, Global Info Research, 6Wresearch, GlobalData, Grand View Research, Fortune Business Insights, Verified Market Research, or similar) — they are Ken Research's direct competitors and must never appear anywhere in this post, including in the "Secondary references" line. If a figure is only attributable to a competing research firm, use the figure without naming its source, or omit it entirely.
Ken Research Branding Keywords to Use Naturally:
Market intelligence, executive summary, market attractiveness, whitespace opportunities, sunrise categories, go-to-market strategy, competition benchmarking, market expansion opportunities, operational viability, financial viability, growth strategy, strategic business consulting, demand-side shifts, category-level analysis, decision-ready intelligence, market entry assessment, hypothesis validation, secondary research, latest base year, forecast outlook, capital allocation, strategic entry, commercial viability, demand depth, pricing power, margin potential, regulatory exposure.
Keyword Usage Rules:
Use 6 to 10 branding keywords naturally inside the caption. Do not force all keywords. Do not keyword-stuff. Use keywords only where they improve meaning. The post should read like an independent market brief for decision-makers. Ken Research should be mentioned only as the primary source and near the CTA/source section.
Latest Base Year Rules:
Use the latest available base-year number. If Ken Research provides it, use it as the main market number; otherwise use the latest credible secondary number and label it clearly as a secondary reference — never falsely attribute it to Ken Research. When both are used: "Based on Ken Research Executive Summary, supported by latest secondary indicators from [Source 1], [Source 2], and [Source 3]." Every number must include year, period, or forecast range. If latest base-year data is unavailable, write [LATEST BASE YEAR NEEDED]. If secondary data is unavailable, write [SECONDARY DATA NEEDED].
Secondary Research Rules:
Use Ken Research Executive Summary as the primary source. Use secondary research to update, validate, or contextualize the market. Do not overwrite Ken Research data unless the secondary source is clearly newer and more authoritative. If figures differ across sources, state the difference cautiously. Do not invent secondary sources. Do not cite weak blogs, unverified databases, or unsourced claims.
Objective:
Create a highly factual LinkedIn caption that redirects senior decision-makers to the Ken Research executive summary website link. Drive engagement, comments, saves, and website clicks by making the market decision feel urgent, specific, and commercially relevant. Help decision-makers understand: is this market attractive, where is the commercial opportunity, which segments deserve attention, where are whitespace opportunities forming, what risks need validation, and what should be checked before entry, investment, expansion, partnership, or acquisition.
Engagement Strategy — use one of these angles:
Contrarian decision angle, e.g. "The market is attractive, but not every segment deserves capital."
Boardroom question angle, e.g. "Before entering this market, the first question should not be CAGR. It should be commercial viability."
Capital allocation angle, e.g. "For investors and expansion teams, the issue is not whether demand exists. The issue is where demand converts into profitable growth."
Risk-validation angle, e.g. "The opportunity is visible. The risk is assuming that all growth pockets are equally scalable."
Whitespace angle, e.g. "The real opportunity may not sit in the largest segment. It may sit in the least contested one."
Writing Angle:
The caption should not educate broadly. It should help decision-makers frame the market and focus on business decisions, not general awareness. The executive summary should be positioned as a decision-support resource for market entry, growth strategy, competition benchmarking, market expansion evaluation, and capital allocation.
Tone:
Independent. Factual. Analytical. Boardroom-ready. Commercially sharp. Evidence-led. Research-backed. Decision-focused. Engagement-oriented. No hype. No exaggerated claims. No sales pitch. No generic educational tone.
Strict Rules:
Do not invent any number, company, CAGR, segment, market fact, source, or signal. Every number must include the year, period, or forecast range. Use "estimated", "projected", or "expected" only for forecast numbers. Do not use promotional words like booming, massive, revolutionary, game-changing, or unstoppable. Do not say "Ken Research has mapped", "our latest report", "we believe", or "we have released". Mention Ken Research only as the primary source. If any required data point is missing, write [DATA NEEDED]. If credible secondary research is missing, write [SECONDARY DATA NEEDED]. If latest base year is not available, write [LATEST BASE YEAR NEEDED]. Do not write for general readers or explain basic market concepts. Do not make the post sound like awareness content. Use the exact Executive Summary Website Link provided. Do not change, shorten, rewrite, or remove the website link. Place the website link after a clear CTA line. Do not use more than one website link in the caption. Do not falsely attribute secondary numbers to Ken Research. Keep the post factual, but make the opening strong enough to stop senior decision-makers from scrolling.
Caption Structure:
1. Decision-maker hook, e.g. "For decision-makers evaluating [Market Name], the headline market size is only the first layer." or "Before allocating capital to [Market Name], decision-makers need to separate market growth from investable growth."
2. Latest base-year fact: "Ken Research places the market at [USD X] in [Year]. Latest secondary indicators from [Source] show [figure/trend] in [Year]." (omit if none available)
3. One line on why the market needs decision-level evaluation (demand depth, competition intensity, regulatory exposure, operational viability, pricing power, segment-level profitability).
4. 4 to 5 decision-relevant facts, each with a factual statement and a "Decision-maker implication:" line.
5. 1 to 2 secondary-research-backed context points (do not let them overpower the Ken Research data).
6. Strategic interpretation section answering: where is market attractiveness increasing; where are whitespace opportunities forming; which segments are commercially viable; how does competition benchmarking change the view; which risks affect entry/investment/expansion/acquisition; where do operational and financial viability need deeper validation.
7. One sharp decision-maker question, e.g. "The key question is not whether the market is growing. The key question is which segment is attractive, scalable, defensible, and financially viable."
8. Soft CTA with the executive summary link.
CTA Format:
For decision-makers evaluating this market, read the executive summary here:
[Insert Executive Summary URL]
Alternatives (use only one if it fits better): "Review the full market intelligence brief here:" / "Access the detailed market snapshot here:" / "Explore the decision-ready market breakdown here:"
Then state sources clearly:
Primary source: Ken Research Executive Summary.
Secondary references: [Insert secondary source names used, or [SECONDARY DATA NEEDED] if none available].
End with a decision-focused engagement question, e.g. "Would you prioritize demand depth, competition intensity, pricing power, regulatory exposure, or margin potential before entering this market?"
Hashtag Rule:
Use #KenResearch in every caption. Use only 3 to 5 hashtags total. Do not overload the post with hashtags.
Length:
Write between 1,800 and 2,000 characters maximum. Do not pad to fill space.
Formatting:
Use short sentences. Line breaks after every 1 to 2 sentences. Mobile-friendly. Avoid long paragraphs. Use numbered points. One sharp question before the CTA. One engagement question at the end. Clean, executive-level writing.
Output:
Only provide the final LinkedIn caption. Do not explain the caption. Do not include notes. Do not include placeholders except where input data is missing.`,

  // Prompt 4 — decision-maker + explicit tension pairs, no "Ken Research Executive Summary" phrasing
  `Act as an independent senior market analyst and strategy consultant.
You are writing a highly factual, high-engagement LinkedIn post for decision-makers only. The audience includes CEOs, founders, investors, PE/VC teams, corporate development leaders, strategy heads, business unit leaders, market expansion teams, and senior consultants.
You are using Ken Research data as the primary market source. You may use credible 2025 or 2026 secondary research to update, validate, or contextualize the latest market view where Ken Research data is older or incomplete.
Do not write like a brand copywriter. Do not write like Ken Research is promoting itself. Do not use "we", "our", or "at Ken Research". Do not use the phrase "Ken Research Executive Summary" in the final caption.
Use these attribution phrases instead: "Ken Research data indicates…" / "Ken Research market data places…" / "According to Ken Research market data…" / "Ken Research identifies…" / "Primary market source: Ken Research."
Ken Research Branding Keywords to Use Naturally:
Market intelligence, market attractiveness, whitespace opportunities, sunrise categories, go-to-market strategy, competition benchmarking, market expansion opportunities, operational viability, financial viability, growth strategy, strategic business consulting, demand-side shifts, category-level analysis, decision-ready intelligence, market entry assessment, hypothesis validation, secondary research, latest base year, forecast outlook, capital allocation, strategic entry, commercial viability, investment thesis, expansion thesis, market sizing, demand validation, competitive positioning.
Keyword Usage Rules:
Use 6 to 10 branding keywords naturally. Do not force all keywords. Do not keyword-stuff. Ken Research should appear as the primary market source, not as a promotional brand.
Latest Base Year Rules:
Do not treat the Ken Research publication date as the latest base year. If Ken Research data is from 2024 but credible secondary research provides 2025 or 2026 context, use the latest secondary data to make the post feel current. Clearly separate Ken Research data from secondary research data. Do not falsely attribute secondary research numbers to Ken Research. Correct format: "Ken Research market data places [Market Name] at [number + year]. Latest secondary indicators from [Source] in [2025/2026] suggest [latest signal]." If no credible 2025 or 2026 secondary data is available, write [LATEST SECONDARY DATA NEEDED]. Every number must include the exact year or period; every forecast number the forecast year; every CAGR the full forecast period.
Secondary Research Rules:
Use Ken Research as the primary market source. Use secondary research only to update, validate, or contextualize the latest market view. Use only credible secondary sources (government databases, regulators, industry associations, company annual reports, investor presentations, public filings, multilateral institutions, reputed publications). Do not use weak blogs, unknown websites, anonymous sources, or unsupported claims. Never name or cite any market-research firm other than Ken Research (e.g. Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, Research and Markets, The Business Research Company, Global Info Research, 6Wresearch, GlobalData, Grand View Research, Fortune Business Insights, Verified Market Research, or similar) — they are Ken Research's direct competitors and must never appear anywhere in this post, including in the "Latest secondary references" line. If a figure is only attributable to a competing research firm, use the figure without naming its source, or omit it entirely. Do not invent any source, number, company, segment, CAGR, or market fact. Use cautious language such as "indicates", "suggests", "points to", "provides additional context", "supports the demand-side view", "adds a current-year signal".
Engagement Objective:
Create a LinkedIn caption that increases comments, saves, and website clicks without clickbait. Use decision-maker tension, contrast, and sharp strategic questions. Make the reader feel that market size alone is not enough to make an entry, investment, expansion, or acquisition decision. Create tension between: market size vs commercial viability; growth vs defensibility; CAGR vs margin potential; entry opportunity vs execution risk; 2024 base data vs 2025/2026 market signals.
Objective:
Create a highly factual LinkedIn caption that redirects senior decision-makers to the Ken Research market report website link, helping them understand: is this market attractive, where is the commercial opportunity, which segments deserve attention, where are whitespace opportunities forming, what changed in 2025 or 2026, which risks need validation, what should be checked before entry, investment, expansion, partnership, or acquisition.
Writing Angle:
Do not educate broad readers. Help decision-makers frame the market. Focus on business decisions, not general awareness. Position the market report link as a decision-support resource for market entry, growth strategy, competition benchmarking, and market expansion evaluation.
Tone:
Independent. Factual. Analytical. Boardroom-ready. Commercially sharp. Evidence-led. Research-backed. Decision-focused. Slightly provocative. No hype. No exaggerated claims. No sales pitch. No generic educational tone.
Strict Rules:
Do not invent any number, company, CAGR, segment, market fact, source, or signal. Every number must include the year, period, or forecast range. Use "estimated", "projected", or "expected" only for forecast numbers. Do not use promotional words like booming, massive, revolutionary, game-changing, unstoppable, or once-in-a-lifetime. Do not say "Ken Research has mapped", "our latest report", "we believe", "we have released", or "Ken Research Executive Summary". Mention Ken Research only as the primary market source. If any required data point is missing, write [DATA NEEDED]. If credible secondary research is missing, write [SECONDARY DATA NEEDED]. If latest base year is not available, write [LATEST BASE YEAR NEEDED]. Do not write for general readers or explain basic market concepts. Speak directly to decision-makers evaluating market entry, investment, expansion, partnership, acquisition, or competitive positioning. Use the exact Market Report Website Link provided. Do not change, shorten, rewrite, or remove the website link. Place the website link after a clear CTA line. Do not use more than one website link in the caption. Do not falsely attribute secondary research data to Ken Research.
Caption Structure:
1. Decision-maker hook — one of: "For decision-makers evaluating [Market Name], the headline market size is only the first layer." / "The [Market Name] market cannot be evaluated only through CAGR." / "Before entering [Market Name], decision-makers need to separate market growth from commercial viability." / "The latest 2025/2026 signals in [Market Name] point to a sharper question: where is growth actually defensible?" / "Market size confirms relevance. It does not confirm pricing power, margin potential, or defensible entry."
2. Factual opening using Ken Research data: "Ken Research market data places the [Market Name] market at [USD X billion] in [Year]."
3. Latest secondary context: "Latest secondary indicators from [Source] in [2025/2026] suggest [factual market signal], adding a more current view of demand, regulation, funding, adoption, or competitive activity."
4. Explain why the headline number is not enough: "Market size confirms relevance. It does not confirm pricing power, margin potential, operational viability, or defensible entry."
5. 4 to 5 decision-relevant signals, each with a "Fact:" line (with year/source) and a "Decision-maker implication:" line.
6. Strategic interpretation section answering: where is market attractiveness increasing; where are whitespace opportunities forming; which segments are commercially viable; where does competition benchmarking change the view; which 2025/2026 signals change the decision; which risks affect entry/investment/expansion; where do operational and financial viability need deeper validation.
7. One sharp decision-maker question — e.g. "The key question is not whether the market is growing. The key question is which segment is attractive, scalable, defensible, and financially viable." or "Market entry is not a size decision. It is a segment, timing, margin, and execution decision."
8. Soft CTA with the market report website link.
CTA Format:
For decision-makers evaluating this market, review the full market breakdown here:
[Insert Website URL]
Alternatives (use only one if it fits better): "Access the decision-ready market intelligence brief here:" / "Review the full market expansion view here:" / "Explore the complete market intelligence breakdown here:"
Then state sources clearly:
Primary market source: Ken Research.
Latest secondary references: [Insert source names used].
End with a decision-focused engagement question — one of: "Which factor would you evaluate first before entering this market?" / "Would you prioritize demand depth, competition intensity, pricing power, regulatory exposure, or margin potential?" / "Where would you expect the strongest whitespace opportunity to emerge in this market?" / "For investors, would this market be more attractive as a growth play, margin play, consolidation play, or category-entry play?"
Hashtag Rule:
Use #KenResearch in every caption. Use only 3 to 5 hashtags total. Do not overload the post with hashtags.
Length:
Write between 1,800 and 2,000 characters maximum. Do not pad to fill space.
Formatting:
Use short sentences. Line breaks after every 1 to 2 sentences. Use numbered points. Mobile-friendly. Avoid long paragraphs. Keep the writing clean, executive-level, and commercially sharp.
Output:
Only provide the final LinkedIn caption. Do not explain the caption. Do not include notes. Do not include placeholders except where input data is missing.`,

  // Prompt 5 — "decision-risk / outdated view" trigger, shortest and sharpest
  `Act as an independent senior market analyst and strategy consultant.
Write a LinkedIn post for senior decision-makers using Ken Research data as the primary market source and credible 2025 or 2026 secondary statistics as the freshness layer. The post should create a "not updated / decision-risk" trigger — it should make the reader feel: "My current market view may be incomplete."
Do not write like a brand promotion. Do not use "we", "our", or "at Ken Research". Do not use the phrase "Ken Research Executive Summary". Use Ken Research only as the primary market source, with simple attribution such as "Ken Research data places…" / "Ken Research identifies…" / "According to Ken Research market data…" / "Primary market source: Ken Research."
Secondary sources allowed: government databases, regulators, industry associations, company annual reports, investor presentations, public filings, research institutions, multilateral bodies, reputed publications.
Never name or cite any market-research firm other than Ken Research (e.g. Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, Research and Markets, The Business Research Company, Global Info Research, 6Wresearch, GlobalData, Grand View Research, Fortune Business Insights, Verified Market Research, or similar) — they are Ken Research's direct competitors and must never appear anywhere in this post, including in the "Latest secondary references" line. If a figure is only attributable to a competing research firm, use the figure without naming its source, or omit it entirely.
Target Audience:
CEOs, founders, investors, PE/VC teams, corporate development leaders, strategy heads, business unit leaders, market expansion teams, and senior consultants.
Objective:
Create a LinkedIn caption that drives comments, saves, and website clicks by showing why decision-makers need an updated 2025/2026 market view before making entry, investment, expansion, partnership, or acquisition decisions.
Core Angle:
Do not write "this market is growing". Write from this angle: "The market may be attractive, but the decision can still go wrong if the assumptions are outdated." Core message: market size confirms relevance — it does not confirm where to enter, how to win, which segment is defensible, or where capital should be deployed.
Stats Usage Rule:
Do not dump statistics. Every statistic must be converted into a decision-maker implication: what does this stat change, what assumption does it challenge, what decision risk does it create, how does it affect entry/investment/expansion/pricing/competition/regulation/funding/margin.
Hook Instructions:
Write the first 2 lines like a scroll-stopper for senior decision-makers. Use one style, e.g.: "2026 market decisions need 2026 signals. Not last-cycle assumptions." / "The risk is not missing the market. The risk is reading it late." / "Market size tells you if a market matters. It does not tell you where to enter." / "A market can be attractive and still be entered wrongly." / "The expensive mistake is not always late entry. Sometimes it is wrong entry." Do not use stale-year hooks like "A 2024 market view may not be enough…".
Caption Structure:
1. Sharp 2-line hook.
2. One setup line: "For decision-makers evaluating [Market Name], the question is not only market size."
3. Ken Research data: "Ken Research data places the [Market Name] market at [Market Size] in [Year]."
4. Contrast: "That confirms relevance. It does not confirm commercial viability."
5. 3 latest 2025/2026 secondary statistics, each formatted as: "[Source] states/reports/shows [stat + year]. This matters because [decision-maker implication]. The mistake would be [wrong assumption / wrong decision risk]."
6. 2 to 3 Ken Research-backed market facts, formatted as: "Ken Research identifies [fact]. That matters because [strategic implication]."
7. A decision-risk lens: "The mistake would be to evaluate this market only through: Market size, CAGR, Broad demand, Generic competition, Old segment assumptions. The better lens is: Demand depth, Segment attractiveness, Competition benchmarking, Recurring revenue potential, Operational viability, Financial viability, Market entry timing."
8. One strong boardroom line, e.g. "The cost of an outdated market view is not only missed growth. It is misallocated capital." / "Market entry is not a size decision. It is a timing, segment, margin, and execution decision." / "The real risk is not entering late. The real risk is entering the wrong part of the market." / "Growth does not automatically create a good investment thesis."
9. Soft CTA: "For decision-makers refreshing their 2026 market view, review the full market breakdown here: [Insert Website Link]"
10. Source line: "Primary market source: Ken Research. Latest secondary references: [Insert source names]."
11. Comment-driving question, e.g. "Which factor would you validate first before entering this market?" / "Where do you think companies are most likely to misread this market?" / "What matters more here: demand depth, competition, pricing, regulation, funding, or margin potential?" / "For investors, is this more attractive as a growth play, margin play, consolidation play, or category-entry play?"
12. 3 to 5 hashtags, always including #KenResearch, #MarketIntelligence, #GrowthStrategy, #MarketExpansion, #CompetitionBenchmarking as the pool to draw from.
Advanced Rules:
First 2 lines should create professional tension. Make the post useful even if the reader does not click. The CTA should feel like the natural next step, not the main purpose. Use short lines and white space. Avoid long paragraphs. Avoid generic statements like "the market is growing rapidly". Make every claim specific. Use 2025 or 2026 secondary statistics wherever credible data is available. Do not mention outdated years in the hook. Do not sound like a report advertisement.
Factual Rules:
Do not invent numbers, sources, companies, CAGR, or market size. Every number must include a year. Clearly separate Ken Research data from secondary data. Do not falsely attribute secondary-source numbers to Ken Research. If Ken Research data is missing, write [KEN RESEARCH DATA NEEDED]. If 2025/2026 secondary data is missing, write [LATEST SECONDARY DATA NEEDED]. If a source is weak or unverified, do not use it.
Tone:
Independent. Factual. Sharp. Commercial. Boardroom-level. Decision-maker focused. Slightly provocative. No hype. No fearmongering. No sales pitch.
Length:
Between 1,800 and 2,000 characters maximum.
Output:
Only provide the final LinkedIn caption. Do not explain. Do not include notes. Do not include placeholders unless data is missing.`,
];

// Picks one of the 5 templates at random and appends the one-line command.
// `platform` swaps "LinkedIn" → "Facebook" in the template text so the same
// 5 prompts serve both channels.
function buildV2Prompt(
  platform: 'fb' | 'li',
  params: { url: string; title: string },
  forceIndex?: number,
): { prompt: string; index: number } {
  const index = forceIndex ?? Math.floor(Math.random() * LI_PROMPT_TEMPLATES.length);
  const template = LI_PROMPT_TEMPLATES[index];
  const platformLabel = platform === 'fb' ? 'Facebook' : 'LinkedIn';
  const base = platform === 'fb' ? template.replace(/LinkedIn/g, platformLabel) : template;
  const utmUrl = `${params.url}${platform === 'fb' ? UTM_PARAMS.Facebook : UTM_PARAMS.LinkedIn}`;
  // Prompt used exactly as given — no added rules/overrides. Just the URL,
  // title, and a length constraint appended at the end, per instruction. URL
  // carries UTM tracking so the character-count check below reflects the
  // link that actually gets posted.
  // URL and title are on separate lines — on one line the model sometimes
  // reads them as a single string and merges the title text into the URL's
  // query string (observed corrupting utm_campaign with the title, url-encoded).
  const prompt = `${base}\n\nGenerate me a post for this url - ${utmUrl}\nReport title: ${params.title}\nBefore writing, search the web for the real market size, CAGR, forecast year, and key data points for this report/market. Use your browsing capability — do not skip this step. Only write [DATA NEEDED] (or similar) for a figure if a genuine web search turns up nothing relevant after trying.\nKeep the total post (including the link) under ${MAX_POST_LENGTH} characters. Use the URL exactly as given above — do not modify, append to, or add anything to it.`;
  return { prompt, index };
}

async function generateFromV2Templates(
  platform: 'fb' | 'li',
  params: { url: string; title: string },
  forceIndex?: number,
): Promise<string> {
  const { prompt, index } = buildV2Prompt(platform, params, forceIndex);
  console.log(`   [${platform.toUpperCase()}] (API) Prompt style: Prompt-${index + 1}`);
  return await callLLMWithRetry(prompt, 1600);
}

// TEMP DEBUG HELPER — force a specific V2 template (1-5) for manual testing.
export async function __debugGenerateWithV2Prompt(
  promptIndex: 1 | 2 | 3 | 4 | 5,
  platform: 'fb' | 'li',
  params: { url: string; title: string },
): Promise<string> {
  return await generateFromV2Templates(platform, params, promptIndex - 1);
}

// Used ONLY by the standalone generateSocialPosts.ts tool (manual, terminal-run).
// NOT wired into generateFbPost/generateLiPost below — those are what cron calls.
// Primary path is the real ChatGPT web session (paste + read reply); the API
// (OpenRouter/NVIDIA) is only a fallback if that browser run fails or is empty.
// No API fallback here by design — on failure/refusal this keeps retrying the
// real ChatGPT browser session only, forever. Account-level retry/rotation
// (10 fails on one account -> next account, full cycle exhausted -> 10-minute
// cooldown -> retry from the first account again) is owned by
// chatGptAccountTracker.ts / promptRunner.ts — this loop just keeps calling
// until one of those attempts succeeds.
const CHATGPT_RETRY_DELAY_MS = 3000;
const CHATGPT_COOLDOWN_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function generateViaChatGptWithFallback(platform: 'fb' | 'li', params: { url: string; title: string }): Promise<string> {
  const label = platform.toUpperCase();
  for (;;) {
    const { prompt, index } = buildV2Prompt(platform, params);
    try {
      console.log(`   [${label}] (ChatGPT) Prompt style: Prompt-${index + 1}`);
      const { runChatGptPrompt } = await import('../browser/chatgpt/promptRunner.js');
      return await runChatGptPrompt(prompt);
    } catch (err: any) {
      console.warn(`   ⚠️  ${label} ChatGPT attempt failed (${err.message}) — no API fallback`);
      if (err.chatGptCycleExhausted) {
        console.warn(`   ⚠️  ${label} every saved ChatGPT account just failed a full cycle — waiting 10 minutes before retrying from the first account`);
        await sleep(CHATGPT_COOLDOWN_MS);
      } else {
        await sleep(CHATGPT_RETRY_DELAY_MS);
      }
    }
  }
}

// 2,280 chars is the hard ceiling for the post text including the UTM-tagged
// link. If a generation comes back over that, regenerate (fresh attempt, not
// a mechanical trim) up to a few times; if it's still over after that, save
// the shortest of the attempts rather than looping forever.
export const MAX_POST_LENGTH = 3000;
const MAX_LENGTH_ATTEMPTS = 3;

// Neither Facebook nor LinkedIn renders **markdown** bold in native posts —
// literal asterisks just show up as asterisks. Real Unicode "Mathematical
// Bold" characters are separate codepoints that display as true bold in any
// plain-text field, no markup needed — this is what actual LinkedIn bold-text
// generators use under the hood.
const BOLD_CHAR_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const upperStart = 0x1d400; // 𝐀
  const lowerStart = 0x1d41a; // 𝐚
  const digitStart = 0x1d7ce; // 𝟎
  for (let i = 0; i < 26; i++) {
    map[String.fromCharCode(65 + i)] = String.fromCodePoint(upperStart + i);
    map[String.fromCharCode(97 + i)] = String.fromCodePoint(lowerStart + i);
  }
  for (let i = 0; i < 10; i++) {
    map[String.fromCharCode(48 + i)] = String.fromCodePoint(digitStart + i);
  }
  return map;
})();

function toUnicodeBold(str: string): string {
  return Array.from(str).map(ch => BOLD_CHAR_MAP[ch] ?? ch).join('');
}

function convertMarkdownBoldToUnicode(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gs, (_match, inner: string) => toUnicodeBold(inner));
}

// Reverse of BOLD_CHAR_MAP — the LLM sometimes writes Unicode Mathematical
// Bold characters directly (not via **markdown**), so a plain-ASCII
// placeholder regex would miss "[𝐊𝐄𝐍 𝐑𝐄𝐒𝐄𝐀𝐑𝐂𝐇 𝐃𝐀𝐓𝐀 𝐍𝐄𝐄𝐃𝐄𝐃]". Normalize
// back to ASCII before scanning for leftover placeholder tokens.
const UNBOLD_CHAR_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [ascii, bold] of Object.entries(BOLD_CHAR_MAP)) map[bold] = ascii;
  return map;
})();

function normalizeUnicodeBold(str: string): string {
  return Array.from(str).map(ch => UNBOLD_CHAR_MAP[ch] ?? ch).join('');
}

const PLACEHOLDER_PATTERN = /\[[^[\]]{0,80}\bNEEDED\b[^[\]]{0,20}\]/i;

/** True if the text still contains an unfilled [... NEEDED] placeholder token. */
export function hasUnfilledPlaceholder(text: string): boolean {
  return PLACEHOLDER_PATTERN.test(normalizeUnicodeBold(text));
}

// Non-negotiable: no em dashes in anything saved to the sheet. Replace with
// a plain hyphen surrounded by spaces (reads naturally, no markup needed).
// En dashes (–, used in ranges like "2024–2030") are left untouched.
function stripEmDashes(text: string): string {
  return text.replace(/\s*—\s*/g, ' - ');
}

// LLMs routinely ignore "add a blank line between numbered points" prompt
// instructions, especially under a tight character-count cap where the
// model prioritizes fitting content over formatting — the wall-of-text
// problem this was meant to fix kept happening even with that instruction
// in place. Enforce the line break mechanically instead of hoping for it:
// force a blank line before every inline "N. " list marker (single digit
// 1-9, not preceded by another digit — excludes years like "2025." and
// multi-digit numbers) followed by a capital letter.
// This runs AFTER convertMarkdownBoldToUnicode(), so a point that opens
// with a bolded phrase ("1. **Kosher-certified...**") has its first letter
// already converted to a Unicode Mathematical Bold codepoint (e.g. 𝐊),
// which plain [A-Z] does not match — that silently skipped every bolded
// list item. \p{Lu} (Unicode "uppercase letter" category) covers both
// ordinary ASCII capitals and the Unicode bold variants.
//
// Also match when followed by a DIGIT, not just a letter — a stat-led point
// like "3. 30 platforms specialize..." or "4. 17 providers operate..." opens
// with a number, and the letter-only lookahead silently skipped those,
// leaving them glued mid-paragraph to the previous point (confirmed live on
// a real LinkedIn post 2026-08-31 — points 2/3/4 ran together as one
// wall-of-text block because 3./4. both opened with digits).
// Use \p{Nd} ("decimal number" Unicode category), not plain \d — the model
// routinely bolds the leading number of a point ("3. **30 platforms**..."),
// and convertMarkdownBoldToUnicode() (which runs before this) turns that
// into Unicode Mathematical Bold digit codepoints (e.g. 𝟑𝟎), which plain \d
// does NOT match. \p{Nd} covers both ordinary ASCII digits and every bold
// digit variant, same fix as \p{Lu} above but for numbers instead of letters
// (confirmed live 2026-08-31 — this exact case slipped through even after
// the \d fix, on the very next real generation).
function ensureNumberedListSpacing(text: string): string {
  const withBreaks = text.replace(/(?<!\p{Nd})([1-9])\.(\s+)(?=[\p{Lu}\p{Nd}])/gu, '\n\n$1.$2');
  // The rule above also fires on markers already correctly at the start of
  // their own paragraph, producing 3+ newlines in a row — collapse any run
  // of blank lines down to exactly one, and drop a leading blank line.
  return withBreaks.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

// Same reliability problem as ensureNumberedListSpacing above, but for the
// "• [stat] — [insight]" bullet markers used in FB/LI "Key Highlights"
// sections: the prompt asks for each bullet on its own line, but the model
// frequently runs them together mid-paragraph instead. Force a line break
// before every "•" that isn't already at the start of a line.
function ensureBulletListSpacing(text: string): string {
  return text.replace(/[ \t]*•/g, (match, offset: number, str: string) => {
    return offset === 0 || str[offset - 1] === '\n' ? '•' : '\n•';
  });
}

function insertBreakBefore(text: string, marker: RegExp): string {
  return text.replace(marker, (match, offset: number, str: string) => {
    return offset === 0 || str[offset - 1] === '\n' ? match : `\n${match}`;
  });
}

// After the last numbered/bulleted point, LI's remaining structural pieces
// (CTA+URL, "Data source: Ken Research", the engagement question, hashtags)
// have no numeric/bullet marker for ensureNumberedListSpacing/
// ensureBulletListSpacing to hook onto — so the model routinely glues them
// all onto one line, e.g. "...URL Data source: Ken Research How do you
// think... #tag1 #tag2" with zero breaks between them (the exact wall-of-text
// failure seen on live LinkedIn posts). Force breaks around these fixed
// anchors instead.
// LI's CTA lead-in phrases, straight from LI_STYLES (below) — used to force a
// break before whichever one the model actually wrote, instead of hardcoding
// guesses that drift out of sync if LI_STYLES changes. Built lazily (called
// only at runtime, after the whole module — including LI_STYLES further down
// this file — has finished initializing), so declaration order is safe here.
function liCtaLeadInRe(): RegExp | null {
  const leadIns = LI_STYLES.map((s) => s.ctaVerb).filter((v, i, arr) => arr.indexOf(v) === i);
  if (leadIns.length === 0) return null;
  const escaped = leadIns.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'i');
}

function ensureStructuralLineBreaks(text: string): string {
  let out = text;

  // Break before "Data source:" if it isn't already starting its own line.
  out = insertBreakBefore(out, /Data source:/gi);

  // Break immediately after the "Data source: Ken Research[.]" mini-sentence
  // — covers both the plain and Unicode-bold ("𝐊𝐞𝐧 𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡") forms produced
  // by convertMarkdownBoldToUnicode, which runs before this in finalizeOutput.
  out = out.replace(/(Data source:\s*(?:Ken Research|𝐊𝐞𝐧\s𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡)\.?)[ \t]+(?=\S)/g, '$1\n');

  // Break before LI's CTA line ("Explore the full market intelligence brief
  // here:", etc.) if the model ran it on from the preceding sentence instead
  // of starting a new paragraph — the numbered-point markers this whole file
  // otherwise anchors on don't exist for this line, so it needs its own rule.
  const ctaRe = liCtaLeadInRe();
  if (ctaRe) out = insertBreakBefore(out, new RegExp(ctaRe.source, 'gi'));

  // Break immediately after a URL if more text follows it on the same line
  // (e.g. the model's engagement question glued straight onto the URL with
  // no break — confirmed live 2026-08-31 on a real LinkedIn post: "...URL
  // Which segment of the market does your portfolio overlook?").
  out = out.replace(/(https?:\/\/\S+)[ \t]+(?=\S)/g, '$1\n');

  // Break before the trailing hashtag block (always the last line per every
  // platform's prompt spec) if it isn't already on its own line — matched as
  // one whole block so individual hashtags stay together, space-separated.
  const hashtagMatch = out.match(/(\s*)(#[\w-]+(?:\s+#[\w-]+)*)\s*$/);
  if (hashtagMatch && !hashtagMatch[1].includes('\n')) {
    const start = out.length - hashtagMatch[0].length;
    out = `${out.slice(0, start)}\n${hashtagMatch[2]}`;
  }

  // insertBreakBefore() above inserts "\n" right before a marker but leaves
  // any pre-existing space/tab run in front of it untouched (it only checks
  // the single character immediately preceding the marker) — clean up the
  // resulting "text \nMarker" into "text\nMarker".
  return out.replace(/[ \t]+\n/g, '\n');
}

// Facebook's prompt renders each of its 5 sections (hook, context, bullets,
// closing, CTA) as exactly one line each — unlike LinkedIn, which pairs a
// numbered point with its own implication line within one section. That
// makes a full line-level rebuild safe for FB specifically: the model
// reliably puts a newline BETWEEN sections already (per the reported bug,
// just not a full BLANK line), so treating every non-bullet, non-hashtag,
// non-URL-only line as its own blank-line-separated block reconstructs the
// "one blank line between each of the 5 sections" spacing the prompt asks
// for but the model doesn't reliably produce. Running this on LI would
// wrongly split its intentional same-section line pairs (e.g. a numbered
// point + its implication sentence), so it's FB-only.
// FB's 5 approved CTA sentences (from generateFbPostRaw's prompt, "choose
// one from the approved list below, do not modify wording") — despite that
// instruction, the model sometimes rewrites the sentence anyway (comma
// dropped for a "?", "here" dropped, a stray line break inserted mid-
// sentence — all observed on a real published post). Since the exact
// approved wording is known ahead of time, this is self-healing: match on
// each CTA's short, stable lead-in phrase, then rebuild the WHOLE sentence
// from the canonical text rather than trusting whatever the model wrote
// after that lead-in — only the model's own URL is kept.
const FB_CTA_VARIATIONS: { leadIn: RegExp; canonical: string }[] = [
  {
    leadIn: /Explore the complete research report below/i,
    canonical: 'Explore the complete research report below for detailed insights, forecasts, and competitive mapping from Ken Research:',
  },
  {
    leadIn: /For deeper insights into market size/i,
    canonical: 'For deeper insights into market size, competitive benchmarking, segment analysis, and forecasts, explore the full research report here:',
  },
  {
    leadIn: /To further understand the market's dynamics/i,
    canonical: "To further understand the market's dynamics, growth themes, and competitive landscape, you can review the full research report from Ken Research here:",
  },
  {
    leadIn: /For a comprehensive view of key drivers/i,
    canonical: 'For a comprehensive view of key drivers, opportunities, and future projections, access the research report from Ken Research below:',
  },
  {
    leadIn: /If you're looking to dive deeper into market trends/i,
    canonical: "If you're looking to dive deeper into market trends and strategic shifts, the full research report from Ken Research is available here:",
  },
];

const FB_CTA_LEAD_IN_RE = new RegExp(FB_CTA_VARIATIONS.map((v) => v.leadIn.source).join('|'), 'i');

/** Rebuild a block containing one of FB's approved CTA sentences from its canonical text, keeping the model's own URL and anything glued on after it (e.g. hashtags). */
function reconstructFbCta(block: string): string {
  const variation = FB_CTA_VARIATIONS.find((v) => v.leadIn.test(block));
  if (!variation) return block;
  const urlMatch = block.match(/https?:\/\/\S+/);
  if (!urlMatch) return block; // no URL found — leave as-is rather than dropping it
  const trailing = block.slice(urlMatch.index! + urlMatch[0].length);
  return `${variation.canonical} ${urlMatch[0]}${trailing}`;
}

function ensureSectionSpacing(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return text;

  const isBullet = (l: string) => l.startsWith('•');
  const isNumberedPoint = (l: string) => /^\d+\.\s/.test(l);
  const isUrlOnly = (l: string) => /^https?:\/\/\S+$/.test(l);
  const isHashtagBlock = (l: string) => /^#[\w-]+(?:\s+#[\w-]+)*$/.test(l);
  const isDataSource = (l: string) => /^Data source:/i.test(l);

  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBullet(line)) {
      const group = [line];
      i++;
      while (i < lines.length && isBullet(lines[i])) {
        group.push(lines[i]);
        i++;
      }
      // Same spillover problem as numbered points below, but for the LAST
      // bullet in the run: the model sometimes keeps writing past it into
      // the closing paragraph on the same line, with no newline for the
      // earlier checks to find. Cut it at the end of its first sentence.
      const lastIdx = group.length - 1;
      const bulletMarkerLen = group[lastIdx].match(/^•\s*/)![0].length;
      const afterBulletMarker = group[lastIdx].slice(bulletMarkerLen);
      const bulletSentenceEnd = afterBulletMarker.search(/\.\s+(?=[A-Z])/);
      let bulletSpillover = '';
      if (bulletSentenceEnd !== -1) {
        group[lastIdx] = group[lastIdx].slice(0, bulletMarkerLen + bulletSentenceEnd + 1);
        bulletSpillover = afterBulletMarker.slice(bulletSentenceEnd + 1).trim();
      }
      blocks.push(group.join('\n'));
      if (bulletSpillover) blocks.push(bulletSpillover);
      continue;
    }
    if (blocks.length > 0 && (isUrlOnly(line) || isHashtagBlock(line) || isDataSource(line))) {
      blocks[blocks.length - 1] += `\n${line}`; // glue to the previous block, single break
      i++;
      continue;
    }
    // A numbered point is supposed to be exactly one sentence (per the
    // prompt's own "Format each as one flowing sentence" rule), but the
    // model sometimes keeps writing past it on the same line — running the
    // next section's prose (and even the CTA/URL) straight into the last
    // numbered point with no newline at all for the earlier checks above to
    // find. Cut the line at the end of its first sentence and start a new
    // block with whatever follows.
    if (isNumberedPoint(line)) {
      const markerLen = line.match(/^\d+\.\s+/)![0].length;
      const afterMarker = line.slice(markerLen);
      const sentenceEnd = afterMarker.search(/\.\s+(?=[A-Z])/);
      if (sentenceEnd !== -1) {
        blocks.push(line.slice(0, markerLen + sentenceEnd + 1));
        const rest = afterMarker.slice(sentenceEnd + 1).trim();
        if (rest) blocks.push(rest);
        i++;
        continue;
      }
    }
    blocks.push(line);
    i++;
  }

  // Final pass: FB's 5 approved CTA opening phrases are fixed, known text —
  // if one turns up mid-block (e.g. still stuck onto the closing paragraph
  // after the numbered-point split above), split it out into its own block.
  const ctaSplit: string[] = [];
  for (const block of blocks) {
    const match = block.match(FB_CTA_LEAD_IN_RE);
    if (match && match.index! > 0) {
      ctaSplit.push(block.slice(0, match.index).trim());
      ctaSplit.push(block.slice(match.index!).trim());
    } else {
      ctaSplit.push(block);
    }
  }

  // Reconstruction pass: the model sometimes rewrites the CTA sentence
  // despite "do not modify wording" — even inserting a stray line break
  // mid-sentence, splitting the CTA lead-in and its URL into two separate
  // blocks by the time the loop above ran. Find the CTA block; if its URL
  // isn't inline, pull it from the very next block (consuming it) before
  // rebuilding from the canonical text.
  const final: string[] = [];
  for (let j = 0; j < ctaSplit.length; j++) {
    const block = ctaSplit[j];
    if (FB_CTA_LEAD_IN_RE.test(block)) {
      let ctaBlock = block;
      if (!/https?:\/\/\S+/.test(ctaBlock) && j + 1 < ctaSplit.length && /https?:\/\/\S+/.test(ctaSplit[j + 1])) {
        ctaBlock = `${ctaBlock} ${ctaSplit[j + 1]}`;
        j++; // consume the next block — its URL is now folded into ctaBlock
      }
      final.push(reconstructFbCta(ctaBlock));
    } else {
      final.push(block);
    }
  }

  return final.join('\n\n');
}

function finalizeOutput(text: string, platform?: 'fb' | 'li'): string {
  let out = ensureBulletListSpacing(ensureNumberedListSpacing(stripEmDashes(convertMarkdownBoldToUnicode(text))));
  if (platform === 'fb') out = ensureSectionSpacing(out);
  return ensureStructuralLineBreaks(out);
}

/**
 * Mechanical last-resort trim — guarantees the result is ≤ limit chars.
 * Unlike the regenerate loop (which is best-effort), this always succeeds.
 * Preserves the URL and anything after it (hashtags), trimming only the body
 * text before it, at a sentence boundary where possible.
 */
/** Cut `text` to at most `limit` chars, preferring the last sentence/paragraph boundary over a mid-word chop. */
function trimAtSentenceBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  const boundaries = [
    cut.lastIndexOf('. '),
    cut.lastIndexOf('.\n'),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('\n\n'),
  ];
  const cutAt = Math.max(...boundaries);
  if (cutAt > limit * 0.5) cut = cut.slice(0, cutAt + 1);
  return cut.trimEnd();
}

function hardTrimToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!urlMatch) return trimAtSentenceBoundary(text, limit);

  const urlIdx = text.indexOf(urlMatch[0]);
  const before = text.slice(0, urlIdx);
  const after = text.slice(urlIdx);
  const allowedBefore = limit - after.length;
  if (allowedBefore <= 0) return trimAtSentenceBoundary(text, limit);

  const trimmedBefore = trimAtSentenceBoundary(before, allowedBefore);
  return (trimmedBefore.trimEnd() + '\n\n' + after).trim();
}

async function generateBounded(platform: 'fb' | 'li', params: { url: string; title: string }): Promise<string> {
  const label = platform.toUpperCase();
  let bestNoPlaceholder = '';
  let shortest = '';
  for (let attempt = 1; attempt <= MAX_LENGTH_ATTEMPTS; attempt++) {
    const output = await generateViaChatGptWithFallback(platform, params);
    const placeholder = hasUnfilledPlaceholder(output);
    if (!shortest || output.length < shortest.length) shortest = output;
    if (!placeholder && (!bestNoPlaceholder || output.length < bestNoPlaceholder.length)) bestNoPlaceholder = output;
    if (!placeholder && output.length <= MAX_POST_LENGTH) return finalizeOutput(output, platform);
    console.warn(`   ⚠️  ${label} post attempt ${attempt}/${MAX_LENGTH_ATTEMPTS} rejected (${placeholder ? 'unfilled placeholder' : `${output.length} chars, over ${MAX_POST_LENGTH}`}) — regenerating`);
  }
  if (bestNoPlaceholder) {
    console.warn(`   ⚠️  ${label} still over ${MAX_POST_LENGTH} chars after ${MAX_LENGTH_ATTEMPTS} attempts — hard-trimming the shortest placeholder-free attempt (${bestNoPlaceholder.length} chars)`);
    return finalizeOutput(hardTrimToLimit(bestNoPlaceholder, MAX_POST_LENGTH), platform);
  }
  console.warn(`   ⚠️  ${label} still has an unfilled placeholder after ${MAX_LENGTH_ATTEMPTS} attempts — hard-trimming the shortest attempt (${shortest.length} chars)`);
  return finalizeOutput(hardTrimToLimit(shortest, MAX_POST_LENGTH), platform);
}

export async function generateFbPostFromFivePrompts(params: { url: string; title: string }): Promise<string> {
  return await generateBounded('fb', params);
}

export async function generateLiPostFromFivePrompts(params: { url: string; title: string }): Promise<string> {
  return await generateBounded('li', params);
}

// ── Cron/production FB + LI generation (used by masterCoordinator) ─────────
// Numbered points here are supposed to be exactly TWO sentences each (stat
// then implication) so they carry real content instead of reading as a bare
// topic label — see NUMBERED_FINDINGS_RULE below, shared across all styles.
const NUMBERED_FINDINGS_RULE = `each point must be exactly TWO sentences on the same line: the first sentence states the specific stat, named entity, or comparison from the web data; the second sentence is a distinct implication sentence explaining what it means for banks, issuers, or investors (not a restatement of the first sentence). No topic labels, no em dash, no single-sentence points.`;

// Every hook below must mention "**Ken Research**" somewhere in the opening
// sentence — but NOT always as the first word. Vary where it lands (start,
// middle, or end of that sentence) from one generation to the next, so the
// post doesn't read as the same template every time. Each hook lists one
// example per position — pick whichever position fits the specific market
// data best, not always the same one.
const HOOK_PLACEMENT_RULE = 'Vary where "**Ken Research**" lands in the opening sentence across generations — start, middle, or end — do not always lead with it.';

const FB_STYLES = [
  {
    hook: `Opening Hook – a contrarian claim that challenges where most people assume the growth story is happening. ${HOOK_PLACEMENT_RULE} Examples: start – "**Ken Research** flags a GCC card story most people are watching in the wrong country." | middle – "Most coverage of GCC card markets is watching the wrong country, and **Ken Research**'s latest tracking shows exactly why." | end – "A card market most people have written off as too small to matter is quietly outgrowing its neighbors, at least according to **Ken Research**." No em dash, no emoji.`,
    body: `2. Context and Scale – 1-2 sentences, no em dash: market value, growth rate, and where the real momentum is versus common assumption, using real numbers.
3. Numbered Findings – exactly 3 numbered points (never "•"); ${NUMBERED_FINDINGS_RULE}
4. Closing – 2 sentences, no em dash: why the quiet/early window matters now, tied to a specific year or threshold.`,
  },
  {
    hook: `Opening Hook – a sharp, specific question about the market (not a generic "what does the future hold" question). ${HOOK_PLACEMENT_RULE} Examples: start – "**Ken Research** just asked why credit card penetration in Oman remains one of the lowest in the Gulf, even as its banking sector modernizes." | middle – "Why does credit card penetration in Oman still trail the rest of the Gulf? **Ken Research** raises the question as the country's banking sector modernizes fast." | end – "Credit card penetration in Oman remains one of the lowest in the Gulf, even as its banking sector modernizes fast, a gap **Ken Research** is now asking banks to explain." No em dash, no emoji.`,
    body: `2. Why the Question Matters – 1-2 sentences, no em dash: the specific tension in the data that makes this question live right now.
3. Numbered Findings – exactly 3 numbered points (never "•"); ${NUMBERED_FINDINGS_RULE}
4. Closing – 2 sentences, no em dash: what answering this question correctly is worth to the reader over a specific time horizon.`,
  },
  {
    hook: `Opening Hook – "[market] in [N] numbers, and one question" (N = however many numbered points follow). ${HOOK_PLACEMENT_RULE} Examples: start – "**Ken Research** breaks down the Oman credit card market in 4 numbers, and one question." | middle – "The Oman credit card market comes down to 4 numbers and one question, according to **Ken Research**." | end – "4 numbers and one question define where the Oman credit card market is really headed, per **Ken Research**'s latest tracking." No em dash, no emoji.`,
    body: `2. Numbered Findings – exactly 4 numbered points (never "•"); ${NUMBERED_FINDINGS_RULE}
3. The Question – 1 sharp sentence naming the real strategic question the four numbers add up to.
4. Closing – 1-2 sentences, no em dash, tying the question back to what **Ken Research**'s full report resolves.`,
  },
];

// Five persona/angle variants supplied by the user — rotated per generation.
// Each keeps: independent-consultant voice, no "we/our/at Ken Research",
// Ken Research mentioned only as data source, exact-URL CTA, 3-5 hashtags
// incl. one Ken Research tag, and a length target compressed to 1,800-2,000
// chars (down from the user's stated 2,300-2,900) so it lands under the
// hard 2,280-char MAX_POST_LENGTH cap enforced below instead of relying on
// hardTrimToLimit to chop it mid-sentence.
const LI_STYLES = [
  {
    persona: 'an independent senior market analyst and strategy consultant writing a factual LinkedIn post using Ken Research data as the evidence base',
    voiceRules: `- Do not write like a brand copywriter or like Ken Research is promoting itself
- Never use "we", "our", or "at Ken Research"
- Write like a consultant analyzing the market and citing Ken Research data as evidence, not the subject`,
    hook: 'Opening – one strong factual line using market size, forecast size, CAGR, or a key market shift from the web data. Then one sentence on why the headline number alone is not enough to understand the opportunity.',
    sections: `2. Factual market signals – exactly 4-6 numbered points, each with a specific number/%/CAGR and its year, drawn only from the web data below
3. Interpretation – 1-2 sentences on what these signals mean for CEOs, investors, and expansion teams
4. Strategic question – one sharp sentence naming the main question decision-makers should ask before acting`,
    ctaVerb: 'Read the executive summary here',
    banPhrase: null,
  },
  {
    persona: 'an independent senior market analyst and strategy consultant writing a factual, evidence-led LinkedIn post that positions Ken Research as a market-intelligence and strategic-consulting source, supported by the secondary context found in the web data',
    voiceRules: `- Do not write like a brand copywriter or like Ken Research is promoting itself
- Never use "we", "our", or "at Ken Research"; mention Ken Research only as the data source
- Naturally use 3-4 of these terms where they add meaning, without keyword-stuffing: market intelligence, market attractiveness, whitespace opportunities, competition benchmarking, go-to-market strategy, decision-ready intelligence`,
    hook: 'Opening – "5 data-backed signals are shaping the [market] market." followed by one line on why the latest available data matters.',
    sections: `2. Data signals – exactly 4-6 numbered signals, each: one factual sentence (number, year, source context) from the web data, then one interpretation sentence on what it means for decision-makers
3. Strategic interpretation – 1-2 sentences on where market attractiveness and whitespace opportunities are forming, and what leaders should evaluate before acting
4. Sharp question – one sentence framing where growth is concentrated, defensible, and commercially viable (not just whether it exists)`,
    ctaVerb: 'Explore the full market intelligence brief here',
    banPhrase: null,
  },
  {
    persona: 'an independent senior market analyst and strategy consultant writing for decision-makers only — CEOs, founders, investors, PE/VC teams, strategy leaders, corporate development and market-expansion teams',
    voiceRules: `- Do not write for general readers and do not explain basic market concepts
- Never use "we", "our", or "at Ken Research"; mention Ken Research only as the primary source
- Use one engagement angle: contrarian ("attractive, but not every segment deserves capital"), boardroom question, capital allocation, risk-validation, or whitespace framing`,
    hook: 'Opening – a decision-maker hook such as "For decision-makers evaluating [market], the headline market size is only the first layer" or "Before allocating capital to [market], decision-makers need to separate market growth from investable growth."',
    sections: `2. Decision-relevant facts – exactly 4-5 numbered points, each: a factual statement with year/number from the web data, followed by a one-line "Decision-maker implication:"
3. Strategic interpretation – 1-2 sentences on where market attractiveness is increasing, where whitespace opportunities are forming, and which risks need validation
4. Decision-maker question – one sharp sentence, e.g. "The key question is not whether the market is growing. The key question is which segment is attractive, scalable, defensible, and financially viable."`,
    ctaVerb: 'For decision-makers evaluating this market, read the executive summary here',
    banPhrase: null,
  },
  {
    persona: 'an independent senior market analyst and strategy consultant writing a boardroom-ready, commercially sharp LinkedIn post for decision-makers, using Ken Research as the primary market source and the web data below as the freshness/context layer',
    voiceRules: `- Never use "we", "our", "at Ken Research", or the phrase "Ken Research Executive Summary"
- Attribute data using phrasing like "Ken Research data indicates…", "According to Ken Research market data…", or "Ken Research identifies…"
- Create tension between market size and commercial viability, growth and defensibility, or opportunity and execution risk`,
    hook: 'Opening – a decision-maker hook such as "The [market] market cannot be evaluated only through CAGR" or "Market size confirms relevance. It does not confirm pricing power, margin potential, or defensible entry." Follow with the factual market size/CAGR figure and its year from the web data.',
    sections: `2. Decision-relevant signals – exactly 4-5 numbered points, each with a factual statement (number/year from web data) and a one-line decision-maker implication (entry, pricing, margin, risk, capital allocation)
3. Strategic interpretation – 1-2 sentences on where market attractiveness and whitespace opportunities are forming, and which risks affect entry or expansion
4. Sharp question – one sentence on which segment is attractive, scalable, defensible, and financially viable — not just whether the market is growing`,
    ctaVerb: 'For decision-makers evaluating this market, review the full market breakdown here',
    banPhrase: 'Ken Research Executive Summary',
  },
  {
    persona: 'an independent senior market analyst and strategy consultant writing a LinkedIn post for senior decision-makers that creates a "my current market view may be incomplete" trigger, using Ken Research as the primary market source and the web data below for current context',
    voiceRules: `- Never use "we", "our", "at Ken Research", or the phrase "Ken Research Executive Summary"
- Attribute data using phrasing like "Ken Research data places…", "Ken Research identifies…", or "Primary market source: Ken Research."
- Core message: market size confirms relevance, not where to enter, how to win, or where capital should be deployed`,
    hook: 'Opening – a 2-line scroll-stopper such as "The risk is not missing the market. The risk is reading it late." or "A market can be attractive and still be entered wrongly." followed by one setup line naming the market and the question beyond size.',
    sections: `2. Signals – exactly 3-4 numbered points, each: a factual statement (number/year from web data), then "This matters because…" and "The mistake would be…" lines
3. Decision-risk lens – 1-2 sentences contrasting the wrong lens (market size, CAGR, broad demand) with the better lens (demand depth, segment attractiveness, competition benchmarking, operational and financial viability)
4. Boardroom line – one sharp sentence, e.g. "The cost of an outdated market view is not only missed growth. It is misallocated capital."`,
    ctaVerb: 'For decision-makers refreshing their market view, review the full market breakdown here',
    banPhrase: 'Ken Research Executive Summary',
  },
];

/**
 * Generate a Facebook post, regenerating (fresh attempt) up to
 * MAX_LENGTH_ATTEMPTS times if the result exceeds MAX_POST_LENGTH (2,280
 * chars). Falls back to the shortest attempt if still over after that.
 */
export async function generateFbPost(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
}): Promise<string> {
  let bestNoPlaceholder = '';
  let shortest = '';
  for (let attempt = 1; attempt <= MAX_LENGTH_ATTEMPTS; attempt++) {
    // Shrink the target on each retry so the model actually converges under
    // MAX_POST_LENGTH instead of overshooting the same soft target again.
    const targetMax = attempt === 1 ? 2000 : attempt === 2 ? 1700 : 1450;
    const output = await generateFbPostRaw(params, targetMax);
    const placeholder = hasUnfilledPlaceholder(output);
    if (!shortest || output.length < shortest.length) shortest = output;
    if (!placeholder && (!bestNoPlaceholder || output.length < bestNoPlaceholder.length)) bestNoPlaceholder = output;
    if (!placeholder && output.length <= MAX_POST_LENGTH) return finalizeOutput(output, 'fb');
    console.warn(`   ⚠️  FB post attempt ${attempt}/${MAX_LENGTH_ATTEMPTS} rejected (${placeholder ? 'unfilled placeholder' : `${output.length} chars, over ${MAX_POST_LENGTH}`}) — regenerating`);
  }
  if (bestNoPlaceholder) {
    console.warn(`   ⚠️  FB post still over ${MAX_POST_LENGTH} chars after ${MAX_LENGTH_ATTEMPTS} attempts — hard-trimming the shortest placeholder-free attempt (${bestNoPlaceholder.length} chars)`);
    return finalizeOutput(hardTrimToLimit(bestNoPlaceholder, MAX_POST_LENGTH), 'fb');
  }
  console.warn(`   ⚠️  FB post still has an unfilled placeholder after ${MAX_LENGTH_ATTEMPTS} attempts — hard-trimming the shortest attempt (${shortest.length} chars)`);
  return finalizeOutput(hardTrimToLimit(shortest, MAX_POST_LENGTH), 'fb');
}

async function generateFbPostRaw(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
}, targetMax: number = 2000): Promise<string> {
  const utmUrl = `${params.url}${UTM_PARAMS.Facebook}`;
  const marketData = await fetchMarketData(params.title);
  const marketDataSection = marketData
    ? `REAL MARKET DATA (from web search — use specific numbers, CAGR, market size, competitors if present):\n${marketData}`
    : 'No web data available — use general market language without inventing numbers.';

  const style = FB_STYLES[Math.floor(Math.random() * FB_STYLES.length)];

  const prompt = `You are a professional B2B content writer producing a Facebook post that presents Ken Research's own market intelligence.

Your task is to generate a Facebook post based on the market report landing page URL provided below.

TONE AND STYLE:
- Write as an analyst presenting Ken Research's findings, using phrasing like "Ken Research finds", "Ken Research identifies", "Ken Research detects", "According to Ken Research" — never "we"/"our"/"at Ken Research"
- MANDATORY: mention "Ken Research" naturally at least once in the main body (not only in the CTA) — never omit it
- Maintain an analytical, evidence-led viewpoint — Ken Research is the source of the data, not the subject of the post
- Do not use emojis, stickers, italics, headings, or any formatting elements other than the bold wrapping specified below
- Never use an em dash (—) anywhere in the post — use a comma, "and", "with", or a period instead
- Do not mention "report", "study", "analysis", or "whitepaper" in the main body
- Every section must include at least one specific number, percentage, or named company from the web data

POST STRUCTURE (use exactly this order, one blank line between each section):
1. ${style.hook}
${style.body}
5. CTA – choose one from the approved list below, on its own line, followed immediately by the UTM URL on the same line

SPACING RULES (critical):
- Use exactly one blank line between each of the 5 sections above
- Each numbered point in section 3 goes on its own line (a real line break after every point, not run together as one paragraph) — this applies EVEN WHEN the point starts with a number instead of a word (e.g. "3. 30 platforms specialize in..." still needs its own line, exactly like "2. Adoption rates show...")
- No blank lines within a section
- No double blank lines anywhere
- Hashtags go on the very last line with no blank line before them

EXACT SPACING EXAMPLE (structure only — invent nothing from this, use your own real numbers/claims):
Hook sentence naming the market.

2. First stat point with a number.
3. Second point that itself starts with a number, like "45 companies now..." — still its own line.
4. Third point, own line.

CTA sentence: ${utmUrl}
#Tag1 #Tag2 #Tag3

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
- Never name or cite any market-research firm other than Ken Research (e.g. Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, or similar) — they are Ken Research's competitors. The only sources you may name are Ken Research itself and government/regulatory bodies (ministries, directives, acts). If a figure in the web data has no other attribution, use it without naming its source, or omit it.
- Do not mention "report", "study", or "analysis" in the body
- Wrap every mention of "Ken Research" in **double asterisks** (e.g. **Ken Research**), and wrap every specific number/%/CAGR/dollar figure the same way (e.g. **37.52%**, **USD 4.2 billion**) — these become bold text on Facebook. Do not bold anything else — no full sentences, no headers.
- No emojis, no other markdown, no special characters, no em dashes
- HARD LIMIT: your entire output, including the CTA and URL, must be under ${targetMax} characters. Count as you write. This is a strict cap, not a suggestion — going over means the post gets rejected outright. Shorter is fine; do not pad to fill space.
- Output ONLY the post text, nothing else

URL: ${params.url}`;

  return await callLLMWithRetry(prompt, 750);
}

/**
 * Generate a LinkedIn post for a Ken Research report.
 * Used by LI batch.
 */
/**
 * Generate a LinkedIn post, regenerating (fresh attempt) up to
 * MAX_LENGTH_ATTEMPTS times if the result exceeds MAX_POST_LENGTH (2,280
 * chars). Falls back to the shortest attempt if still over after that.
 */
export async function generateLiPost(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
}): Promise<string> {
  let bestNoPlaceholder = '';
  let shortest = '';
  for (let attempt = 1; attempt <= MAX_LENGTH_ATTEMPTS; attempt++) {
    // Shrink the target on each retry so the model actually converges under
    // MAX_POST_LENGTH instead of overshooting the same soft target again.
    const targetMax = attempt === 1 ? 2000 : attempt === 2 ? 1700 : 1450;
    const output = await generateLiPostRaw(params, targetMax);
    const placeholder = hasUnfilledPlaceholder(output);
    if (!shortest || output.length < shortest.length) shortest = output;
    if (!placeholder && (!bestNoPlaceholder || output.length < bestNoPlaceholder.length)) bestNoPlaceholder = output;
    if (!placeholder && output.length <= MAX_POST_LENGTH) return finalizeOutput(output);
    console.warn(`   ⚠️  LI post attempt ${attempt}/${MAX_LENGTH_ATTEMPTS} rejected (${placeholder ? 'unfilled placeholder' : `${output.length} chars, over ${MAX_POST_LENGTH}`}) — regenerating`);
  }
  if (bestNoPlaceholder) {
    console.warn(`   ⚠️  LI post still over ${MAX_POST_LENGTH} chars after ${MAX_LENGTH_ATTEMPTS} attempts — hard-trimming the shortest placeholder-free attempt (${bestNoPlaceholder.length} chars)`);
    return finalizeOutput(hardTrimToLimit(bestNoPlaceholder, MAX_POST_LENGTH));
  }
  console.warn(`   ⚠️  LI post still has an unfilled placeholder after ${MAX_LENGTH_ATTEMPTS} attempts — hard-trimming the shortest attempt (${shortest.length} chars)`);
  return finalizeOutput(hardTrimToLimit(shortest, MAX_POST_LENGTH));
}

async function generateLiPostRaw(params: {
  url: string;
  title: string;
  seoRanking: number;
  priority: string;
}, targetMax: number = 2000): Promise<string> {
  const utmUrl = `${params.url}${UTM_PARAMS.LinkedIn}`;
  const marketData = await fetchMarketData(params.title, { advanced: true, maxResults: 5 });
  const marketDataSection = marketData
    ? `REAL MARKET DATA (from Tavily web search — use specific numbers, CAGR, market size, top competitors if present):\n${marketData}`
    : 'No web data available — use general market language without inventing numbers.';

  const style = LI_STYLES[Math.floor(Math.random() * LI_STYLES.length)];

  const banRule = style.banPhrase
    ? `- Never use the phrase "${style.banPhrase}" anywhere in the post`
    : '';

  const prompt = `Act as ${style.persona}.

Title: ${params.title}
URL: ${utmUrl}

${marketDataSection}

VOICE:
${style.voiceRules}

DATA RULE: Every numbered signal must include at least one specific number, percentage, dollar figure, or named company drawn from the web data above, with its year. Do not invent numbers, companies, CAGR, segments, or sources — if a needed figure is missing from the web data, omit that specific claim rather than guessing.

SOURCE RULE: The only sources you may ever name in this post are Ken Research and government/regulatory bodies (ministries, directives, acts). Never name or cite any other market-research firm (e.g. Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, or similar) — they are Ken Research's direct competitors and must never appear in this post, even as a supporting or secondary reference. If a figure in the web data is only attributable to one of those firms, either use the figure without naming its source, or drop it entirely.

POST STRUCTURE — one blank line between EVERY section AND between EVERY numbered point (never run two numbered points together on adjacent lines; each one is its own paragraph). This applies EVEN WHEN a point starts with a number instead of a word — e.g. "3. 30 platforms specialize in..." still needs its own blank-line-separated paragraph, exactly like "2. Adoption rates show...":
1. ${style.hook}
${style.sections}
5. CTA — "${style.ctaVerb}:" on its own line, followed immediately by the URL on the next line
6. Mention Ken Research only as the data source (never "we"/"our"/"at Ken Research")
7. One thoughtful engagement question for readers
8. Hashtags

EXACT SPACING EXAMPLE (structure only — invent nothing from this, use your own real numbers/claims):
Opening hook line naming the market.

2. First signal with a number, then why it matters.

3. Second signal that itself starts with a number, like "45 companies now..." — still its own paragraph.

4. Third signal, own paragraph.

Decision-risk sentence.

For decision-makers, review the full breakdown here:
${utmUrl}

Engagement question for readers?
#KenResearch #Tag2 #Tag3

RULES:
${banRule}
- No emojis, no special characters
- Wrap every mention of "Ken Research" in **double asterisks** (e.g. **Ken Research**), and wrap every specific number/%/CAGR/dollar figure the same way (e.g. **37.52%**, **USD 4.2 billion**) — these become bold text on LinkedIn. Do not bold anything else (no full sentences, no headers).
- The executive summary/report should feel like supporting evidence, not the main subject — do not sound like an advertisement
- Use the exact URL given above — do not shorten, rewrite, or remove it; only one link in the whole post
- 3-5 hashtags on the last line, space-separated, always including #KenResearch
- HARD LIMIT: your entire output, including the CTA and URL, must be under ${targetMax} characters. Count as you write. This is a strict cap, not a suggestion — going over means the post gets rejected outright. Shorter is fine; do not pad to fill space.
- Output ONLY the post text, nothing else`;

  return await callLLMWithRetry(prompt, 1600);
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
 * Generate Telegraph page. Prefers pre-written "Blog Content for all" (no
 * LLM) when present; Telegraph shares Slot 2 of the Social Media tab with
 * Facebook/Tumblr/Pearltrees, which don't carry that column, so falls back
 * to a short templated article body built from title/URL/market value —
 * always produces something postable rather than throwing on those rows.
 */
export async function generateTelegraphPost(row: SheetRow): Promise<{ title: string; html: string }> {
  const title = (row.descriptionTitle || row.title || '').trim();
  if (!title) {
    throw new Error('No title found (descriptionTitle/title both empty)');
  }

  const preWritten = (row.blogContent || '').trim();
  const content = preWritten || [
    `<p>${title} — a detailed market research report from Ken Research.</p>`,
    row.marketValue && row.marketValue !== '0' ? `<p>Market value: ${row.marketValue}.</p>` : '',
    `<p>Read the full report: <a href="${row.targetUrl}">${row.targetUrl}</a></p>`,
  ].filter(Boolean).join('\n');

  return { title, html: injectUTM(content, UTM_PARAMS.Telegraph) };
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

  return {
    title: mainTitle,
    html: injectUTM(blogContent, UTM_PARAMS.LinkedIn),
    seoTitle: mainTitle,
    seoDescription: mainTitle,
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

