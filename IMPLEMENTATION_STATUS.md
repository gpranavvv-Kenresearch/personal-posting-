# Implementation Status — Coordinator-Based Agent System

## ✅ COMPLETED

### Tools Layer (5 files)
- ✅ `src/tools/seoTools.ts` — SerpAPI + Tavily wrappers
- ✅ `src/tools/contentTools.ts` — Content generation wrappers
- ✅ `src/tools/browserTools.ts` — Browser automation (X, FB, LI) with module-level page state
- ✅ `src/tools/sheetsTools.ts` — Google Sheets read/write wrappers
- ✅ `src/tools/visionTools.ts` — Screenshot + vision analysis for popup detection
- ✅ `src/tools/fileTools.ts` — File I/O for self-healing

### Agents Layer (6 files)
- ✅ `src/agents/seoAgentNew.ts` — Claude loop for SEO ranking + priority (P1/P2/P3)
- ✅ `src/agents/contentAgentNew.ts` — Claude loop for tweet/FB/LI/blog generation
- ✅ `src/agents/xAgentNew.ts` — Claude loop for X posting
- ✅ `src/agents/fbBatchAgentNew.ts` — FB batch posting (sequential 15 accounts)
- ✅ `src/agents/liBatchAgentNew.ts` — LI batch posting (sequential 15 accounts)

### Coordinator (2 files)
- ✅ `src/coordinator/masterCoordinator.ts` — Batch decision logic + X/FB/LI batch runners
- ✅ `src/scheduler-new.ts` — Cron-based scheduling (every 30 min during 11 AM - 6 PM IST)

---

## ⚠️  TO DO (High Priority)

### 1. **Sheet Modifications**
**Location**: `src/sheets/sheets.ts`

Add these new columns to `SheetRow` interface:
```typescript
seoRanking?: string;        // 1-100+ ranking
seoIndexed?: string;        // "yes" | "no" | "unknown"
priority?: string;          // "P1" | "P2" | "P3"
lastSerpCheckDate?: string; // When SEO was last checked (YYYY-MM-DD)
tweetPost?: string;         // Generated tweet
fbPost?: string;            // Generated FB post
liPost?: string;            // Generated LI post
blogPost?: string;          // Generated blog post
```

Add these query functions:
```typescript
// Get rows where fbPostUrl is empty (for FB batch agent)
export async function getRowsForFbPosting(limit: number): Promise<SheetRow[]>

// Get rows where liPostUrl is empty (for LI batch agent)
export async function getRowsForLinkedInPosting(limit: number): Promise<SheetRow[]>

// Update row with content columns
export async function updateRowContent(row: SheetRow, content: {
  tweet?: string; fbPost?: string; liPost?: string; blog?: string;
}): Promise<void>

// Update row with SEO data
export async function updateRowWithSeo(row: SheetRow, seoData: any): Promise<void>
```

### 2. **Agent Imports & Exports**
Need to update `index.ts` to use new agents:
- Import from `seoAgentNew.ts`, `contentAgentNew.ts`, etc.
- Keep CLI modes working (test manually)
- Update manual posting flows

### 3. **Master Coordinator Enhancements**
Complete the coordinator in `src/coordinator/masterCoordinator.ts`:
- ✅ Implement `getRowsForFb()` — query sheet for fbPostUrl empty rows
- ✅ Implement `getRowsForLi()` — query sheet for liPostUrl empty rows
- Add P2/P3 scheduling logic (alternate days, skip Sunday for P3)
- Add error handling + retry logic
- Add vision-based popup detection (optional, Phase 2)

### 4. **Daily Counter Reset**
Ensure daily counters reset at midnight:
- Check `src/config/accountTracker.ts` — verify `resetDailyCounters()` is called

### 5. **Browser Script Compatibility**
Verify browser script exports match tool signatures:
- `src/browser/twitter/login.ts` → `loginToX(account)` returns `Page`
- `src/browser/twitter/poster.ts` → `postTweet(page, text, handle)` returns URL
- `src/browser/facebook/login.ts` → `loginToFacebook(nickname)` returns `Page`
- `src/browser/facebook/poster.ts` → `postToFacebook(page, text)` returns URL
- `src/browser/linkedin/login.ts` → `loginToLinkedIn(nickname)` returns `Page`
- `src/browser/linkedin/poster.ts` → `postToLinkedIn(page, text)` returns URL

---

## 🔄 TESTING CHECKLIST

Once all TO DO items above are completed:

1. **Manual Test X Batch**:
   ```bash
   node --import=tsx src/index.ts -- once
   # Should trigger X batch if in posting window
   ```

2. **Manual Test Coordinator**:
   ```bash
   node --import=tsx src/scheduler-new.ts
   # Should run coordinator every 30 min
   ```

3. **Verify Sheet Updates**:
   - Check seoRanking, priority, tweetPost columns populated
   - Check fbPost, liPost, blogPost columns populated
   - Check tweetUrl, fbPostUrl, liPostUrl populated after posting

4. **Test Priority Logic**:
   - Day 1: Unprocessed URLs get SEO ranking + priority
   - Day 2+: Should post P1 URLs every day, P2 alternate days, P3 Mon-Sat

5. **Test Cooldowns**:
   - X: 30 min cooldown between batches ✅
   - FB: 1 hr cooldown between batches ✅
   - LI: 2 hr cooldown between batches ✅

6. **Test Sequential Posting**:
   - FB agent should open/post/close for each of 15 accounts (NOT parallel)
   - LI agent should do same

---

## 🚀 QUICK START TO TESTING

1. Update `src/sheets/sheets.ts` with new columns + functions
2. Update `getRowsForFb()` and `getRowsForLi()` in `src/coordinator/masterCoordinator.ts`
3. Test with: `npm run dev` (uses new scheduler-new.ts)
4. Verify terminal logs show coordinator running every 30 min

---

## 📁 NEW FILES CREATED

```
src/tools/
  ├─ seoTools.ts ✅
  ├─ contentTools.ts ✅
  ├─ browserTools.ts ✅
  ├─ sheetsTools.ts ✅
  ├─ visionTools.ts ✅
  └─ fileTools.ts ✅

src/agents/
  ├─ seoAgentNew.ts ✅
  ├─ contentAgentNew.ts ✅
  ├─ xAgentNew.ts ✅
  ├─ fbBatchAgentNew.ts ✅
  └─ liBatchAgentNew.ts ✅

src/coordinator/
  └─ masterCoordinator.ts ✅

src/
  └─ scheduler-new.ts ✅
```

---

## 🔧 FILES TO KEEP (OLD SYSTEM)

Do NOT delete until fully tested:
- `src/agents/supervisor.ts` (backup)
- `src/agents/masterOrchestrator.ts` (backup)
- `src/agents/scheduler.ts` (old)
- `src/agents/seoAgent.ts` (old)

Delete after confirming new system works:
- `src/agents/xPostingAgent.ts`
- `src/agents/facebookPostingAgent.ts`
- `src/agents/linkedinPostingAgent.ts`
- `src/agents/socialOrchestrator.ts`
- `src/agents/dailyPlannerAgent.ts`

---

## 📝 NOTES

- All agents use Claude model: `claude-3-5-sonnet-20241022` (hardcoded)
- API key: `process.env.ANTHROPIC_API_KEY` (must be set in .env)
- Posting window: 11 AM - 6 PM IST (controlled by scheduler)
- Max retries per batch: 3 (can be tuned)
- Page objects stored in module-level vars to cross tool boundaries

---

**Status**: ~75% Complete. Core system ready for integration testing.
