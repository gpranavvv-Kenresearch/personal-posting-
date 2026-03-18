# X Posting Agent — Supervisor Instructions

## 🎯 Goal
Automatically post tweets to X.com from Ken Research blog content.

## 🧠 Supervisor Rules (Claude Code follows these)
1. Before ANY task — read the relevant skill file in .claude/skills/
2. Before fixing ANY bug — read the broken file first
3. Never make changes without reading current code first
4. After fixing — run npm run dev and check output
5. If same error appears twice — try a completely different approach
6. Never spend more than 3 attempts on the same error
7. Log every fix and what caused it

## 🚫 Never Do This
- Never open a second browser window
- Never use Stagehand for login — use plain Playwright only
- Never use wrong model names — always use claude-3-5-sonnet-20241022
- Never use CSS selectors without waitForSelector first
- Never skip humanDelay between browser actions
- Never run npm run dev more than 3 times without fixing something

## ✅ Tech Stack (Current Working)
- Login: Plain Playwright with persistent Chrome profile
- Posting: Plain Playwright with CSS selectors
- Content: Anthropic SDK claude-3-5-sonnet-20241022
- Session: .sessions/chrome-profile (persistent context)

## 📁 File Structure
```
src/
  agents/
    orchestrator.ts     → controls all agents in sequence
    contentGenerator.ts → scrapes + generates tweet
  browser/
    stagehand.ts        → humanDelay utility only
    twitter/
      login.ts          → Playwright stealth login
      poster.ts         → Playwright tweet posting
  config/
    settings.ts         → all config in one place
  index.ts              → entry point
```

## 🔑 Environment Variables
```
ANTHROPIC_API_KEY=
X_USERNAME=
X_PASSWORD=
X_HANDLE=
```

## 🤖 Agent Pipeline
```
index.ts
  → orchestrator.ts
      → Agent 1: login.ts        (returns Page object)
      → Agent 2: contentGenerator.ts  (returns tweet string)
      → Agent 3: poster.ts       (posts tweet, returns URL)
```

## 🔄 Supervisor Workflow
When user runs npm run dev:
1. Read all skill files
2. Run pipeline
3. If error → identify which agent failed
4. Read that agent's skill file
5. Fix the exact error
6. Run again
7. Repeat max 3 times
8. If still failing → report clearly what is wrong

## ✅ Known Working Code Patterns
- Login uses: chromium.launchPersistentContext with channel:'chrome'
- Post button: div[role="button"]:has(span:has-text("Post"))
- Tweet box: [data-testid="tweetTextarea_0"]
- Typing: page.keyboard.type(text, { delay: 80 })
- Model: claude-3-5-sonnet-20241022

## ❌ Past Mistakes (Never Repeat)
- Used Stagehand for login → browser closed mid-login
- Used claude-sonnet-4-20250514 → authentication error
- Used page.fill() → target closed error
- Opened Stagehand after login → second browser opened
- Used networkidle → timeout on X.com