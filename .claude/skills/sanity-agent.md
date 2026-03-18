# Skill: Sanity Agent (v2)

## Purpose
Validate tweet content BEFORE posting. Pure TypeScript — no OpenRouter/Claude calls.

## File
`src/agents/sanityAgent.ts`

## Input
```typescript
runSanityCheck(tweet: string, row: SheetRow, batchCtx?: BatchContext): Promise<SanityResult>
```

## Output
```typescript
{ valid: boolean, issues: string[], sanitized?: string }
```

## BatchContext (duplicate detection across a batch)
```typescript
// Create once per batch, pass to every runSanityCheck call
const batchCtx = createBatchContext();
// After a PASS, the agent auto-registers the URL + normalized text into batchCtx
```

## X Character Count Formula
```
xCount = tweet.length + Σ(23 - url.length) for each URL
```
URLs always count as 23 chars on X regardless of actual length.

## Checks (in order)
| # | Check | Rule | Severity |
|---|---|---|---|
| 1 | Empty tweet | `tweet.trim().length === 0` | MAJOR → reject |
| 2 | URL present | no `https?://` match | MAJOR → reject |
| 3 | Domain whitelist | domain not in `ALLOWED_DOMAINS` (`kenresearch.com`) | MAJOR → reject |
| 4 | URL reachable | HEAD request, 5s timeout | MAJOR if 4xx/5xx; MINOR if timeout/error |
| 5 | Link-only | `text_without_url.length < 40` | MAJOR → reject |
| 6 | Uppercase spam | `uppercase_ratio > 0.6` (letters only, URLs excluded) | MAJOR → reject |
| 7 | Hashtag present | try fallback list in order until one fits | MAJOR if none fit |
| 8 | Hashtag count | `> 4` hashtags | MAJOR → reject |
| 9 | Length >280 | multi-strategy trim (see below) | MINOR if fixed; MAJOR if not |
| 10 | Profanity | hardcoded word list | MAJOR → reject |
| 11 | Spam patterns | `!!!` (3+ exclamations) | MAJOR → reject |
| 12 | Duplicate URL | URL already in `batchCtx.seenUrls` | MAJOR → reject (requires batchCtx) |
| 13 | Duplicate text | Jaccard similarity > 0.85 vs `batchCtx.seenTexts` | MAJOR → reject (requires batchCtx) |
| 14 | Title keyword | 1+ word >4 chars from `row.title` in tweet | MINOR → log only |

## Hashtag Fallback List (check 7)
```
#MarketResearch → #MarketInsights → #IndustryTrends → #Research
```
Try each in order; use first one that fits within 280 X-chars.

## Multi-Strategy Trim (check 9, in order)
1. **Sentence boundary** — find last `.`, `!`, `?`, `\n`, or `: ` before the URL, cut there
2. **Filler words** — strip `just`, `really`, `truly`, `very`, `now` one at a time
3. **CTA shortening** — e.g. `Read more about this here` → `Read:`

If all strategies fail → MAJOR reject.

## Duplicate Text Similarity (check 13)
```
Jaccard(a, b) = |words(a) ∩ words(b)| / |words(a) ∪ words(b)|
```
Text is normalized: strip URLs + hashtags, lowercase, remove punctuation.

## Return Logic
- Any MAJOR issue → `{ valid: false, issues }`
- Auto-fix applied → `{ valid: true, issues, sanitized: fixedTweet }`
- All clear → `{ valid: true, issues: [] }`

## Console Logging
```
🔍 Sanity check running...
✅ Sanity passed
✅ Sanity passed (with auto-fixes)
⚠️  Minor issue auto-fixed: <description>
⚠️  Minor: <description> (not blocking)
❌ Sanity FAILED: <reason>
```

## Never Do
- Never call OpenRouter or any Claude API (pure logic + fetch only)
- Never throw — always catch and return `{ valid: false, issues: ['MAJOR:unexpected_error:...'] }`
- Never modify the URL portion of the tweet
- Never reject for MINOR issues alone
- Never skip adding to batchCtx after a PASS (duplicate detection depends on it)
