# Product Requirements Document (PRD)
## X Posting Agent - Automated Social Media Distribution System

**Version:** 2.0
**Date:** March 26, 2026
**Status:** Production Ready
**Future Expansion:** Micro blog platforms (HackMD, Hashnode, Google Sites, Medium, Dev.to) & PR distribution websites

---

## 📋 Executive Summary

The **X Posting Agent** is an intelligent automation system that takes content from Ken Research blog articles and automatically posts them across multiple social media platforms (X/Twitter, Facebook, LinkedIn) while strategically managing 15 accounts per platform. The system uses AI-powered content generation and smart scheduling to maximize reach and engagement without violating rate limits or platform policies.

Think of it as a **smart content distribution robot** that reads blog articles, understands their value, breaks them down into platform-specific messages, and posts them at the right time to the right accounts.

---

## 🎯 Core Problem & Solution

**The Problem:**
- Ken Research writes valuable blog articles that deserve wider audience
- Manually posting to 45 social accounts (15 on X, 15 on Facebook, 15 on LinkedIn) is time-consuming
- Different platforms need different content formats (280 chars for X, longer posts for FB/LinkedIn)
- Need to maintain consistent posting schedule without hitting platform rate limits
- Need to track which URLs have been posted and when
- Articles that rank well should be reposted after a week

**Our Solution:**
An autonomous system that:
- ✅ Reads blog URLs from a Google Sheet
- ✅ Analyzes their SEO value using Google Search API
- ✅ Automatically generates platform-specific content (tweet, Facebook post, LinkedIn post, blog)
- ✅ Posts to 45 accounts sequentially (no conflicts)
- ✅ Respects platform limits (X: 195/day, FB: 75/day, LinkedIn: 45/day)
- ✅ Re-checks article rankings after 7 days and reposts if still valuable
- ✅ Handles errors automatically (detects popups, fixes broken selectors)

---

## 🏗️ Architecture Overview

### **High-Level Flow:**

```
Blog URL (from Google Sheet)
    ↓
[SEO Agent] → Check Google ranking → Assign priority (P1/P2/P3)
    ↓
[Content Agent] → Generate 4 posts (Tweet, FB, LinkedIn, Blog)
    ↓
[Posting Agents] → Post to 45 accounts sequentially
    ↓
[Sheet Update] → Record URLs, status, results
    ↓
[Week 2+] → Re-check ranking → Regenerate content → Repost if valuable
```

### **System Components:**

#### **1. Scheduler (Daemon)**
- Runs every 30 minutes during 11 AM - 6 PM IST (posting window)
- Checks daily limits (X: 195, FB: 75, LinkedIn: 45)
- Respects cooldowns (X: 30 min, FB: 1 hr, LinkedIn: 2 hrs)
- Saturday 10 PM: Triggers weekly SERP re-check for old URLs

#### **2. SEO Agent (Claude AI)**
- Searches Google with SerpAPI to find article ranking
- Determines: Is article on page 1-2? Page 3-4? Below page 4 or not indexed?
- Assigns priority:
  - **P1** (Rank 1-30): Post every day to all platforms
  - **P2** (Rank 31-69): Post alternate days (Mon/Wed/Fri)
  - **P3** (Rank 70+ or not indexed): Post Mon-Sat only

#### **3. Content Agent (Claude AI)**
- Reads the blog URL content
- Generates 4 different posts:
  - **Tweet:** 280 characters max, engaging, with hashtags
  - **Facebook Post:** Conversational, emoji-friendly, encouraging engagement
  - **LinkedIn Post:** Professional tone, B2B focused, thought leadership
  - **Blog Post:** 600-800 words, deep dive, shareable insights
- Validates tweet meets length requirements
- Runs sanity check (detects gibberish, checks tone)

#### **4. Posting Agents (Playwright Browser Automation)**
- **X Agent:** Logs in, posts tweet, captures URL
- **Facebook Agent:** Logs in, posts to 15 FB accounts sequentially
- **LinkedIn Agent:** Logs in, posts to 15 LinkedIn accounts sequentially
- Each account opens fresh browser, posts, closes (no parallel conflicts)

#### **5. Coordinator (Master Brain)**
- Decides which platform batch to run next
- Tracks daily usage per platform
- Manages cooldown timers
- Detects and removes popups automatically
- Fixes broken selectors by reading code and suggesting fixes
- Retries failed batches up to 3 times

#### **6. Google Sheets Integration**
- **Read:** Blog URLs, titles, priority hints
- **Write:** SEO rankings, priority levels, generated posts, post URLs, status
- Single "insta" tab stores everything

---

## 📊 Data Model

### **What Gets Tracked (Sheet Columns):**

```
URL Information:
  • targetUrl - The blog link
  • title - Article title
  • marketValue - Market size mentioned in article

SEO Data:
  • seoRanking - Google search rank (1, 2, 55, 100+, N/A)
  • seoIndexed - Is article in Google index? (yes/no/unknown)
  • seoPage - Which Google result page? (1, 2, 3, 4, 5+)
  • seoKeywords - Keywords article ranks for
  • priority - P1 / P2 / P3 (stays valid 7 days)
  • lastSerpCheckDate - When we last checked Google ranking

Generated Content:
  • X Post - Generated tweet text
  • FB Post - Generated Facebook post text
  • LinkedIn Post - Generated LinkedIn post text
  • Message Status - Generated blog post draft

Posting Results:
  • X Post URL - Link to posted tweet
  • FB Post URL - Link to posted FB post
  • LinkedIn Post URL - Link to posted LinkedIn post
  • X Status / FB Status / LinkedIn Status - Posted / Failed
  • X Error / FB Error / LinkedIn Error - Why it failed (if failed)

Metadata:
  • lastPostedX - When last posted to X
  • lastPostedFb - When last posted to FB
  • lastPostedLi - When last posted to LinkedIn
  • date - When added to system
  • batch - Which posting batch
```

---

## ⏰ Weekly Schedule

### **Week 1 (Monday):**
```
MON: P1 URLs post (all 15 X accounts)
TUE: P1 URLs post
WED: P1 URLs post + P2 URLs post
THU: P1 URLs post
FRI: P1 URLs post + P2 URLs post
SAT: P1 URLs post + P3 URLs post
SUN: P1 URLs post (P3 skip Sunday)
```

### **Week 2 (Saturday 10 PM):**
```
Automatic SERP re-check for URLs from Week 1:
- Article still ranking well? → Keep priority, allow reposting
- Article dropped in ranking? → Update priority
- Priority changed? → Generate NEW content
- Clear old posting URLs → Allow re-selection for Week 2
```

### **Week 2+ (Continuous):**
```
FB/LI batch posting continues sequentially:
- Batch 1: Rows 1-15
- Batch 2: Rows 16-30
- Batch 3: Rows 31-45
(No daily reset - continuous week-long posting)
```

---

## 🤖 How AI Brain Works

### **Claude AI Decision Loop:**

Every agent follows same pattern:
```
1. Receive task (URL to analyze / content to generate / tweet to post)
2. Call tools as needed (search API / browser action / sheet read)
3. Process results
4. Make decision based on results
5. Report back with success/failure + details
6. Loop if needed (for retries)
```

**Example - SEO Agent Loop:**
```
1. Get: https://www.kenresearch.com/blog/ai-market-2024
2. Call: search_google("ai market 2024 ken research")
3. Get: Results showing rank position 25
4. Decide: Rank 25 = P1 (posts daily)
5. Report: {rank: 25, priority: "P1", indexed: true}
```

**Example - Content Agent Loop:**
```
1. Get: Blog URL + "AI is transforming markets"
2. Call: fetch_content(url) → Get article text
3. Decide: Tweet angle = "AI market growing 300%"
4. Generate: "🤖 AI market expanding rapidly... [tweet]"
5. Call: run_sanity_check(tweet)
6. If bad: Regenerate, run sanity check again (max 3 tries)
7. Report: {tweet, fbPost, liPost, blog}
```

---

## 🔧 Technical Stack

```
Frontend: Google Sheets (data input/output)
├─ Single sheet with all data
└─ Google Sheets API for reads/writes

Backend: Node.js + TypeScript
├─ Browser Automation: Playwright
├─ AI: Claude API (claude-3-5-sonnet-20241022 via OpenRouter)
├─ Search API: SerpAPI (Google rank checking)
├─ Task Scheduling: node-cron (30-min checks, Saturday 10 PM)
└─ State Management: JSON files in .sessions/

Accounts Storage:
├─ X/Twitter: 15 accounts with credentials
├─ Facebook: 15 accounts with credentials
└─ LinkedIn: 15 accounts with credentials

Logs & Monitoring:
├─ Daily counters: How many posted today
├─ Cooldown timers: When next batch can run
├─ Batch state: Which row FB/LI are at
└─ Error logs: What failed and why
```

---

## 📈 Daily Posting Capacity

**X/Twitter:**
- 13 batches × 15 URLs = **195 posts/day**
- Timing: 11:00 AM - 5:30 PM IST (sequential, ~2 min per batch)
- Cooldown: 30 minutes between batches

**Facebook:**
- 5 batches × 15 accounts = **75 posts/day**
- Timing: 11:30 AM - 5:45 PM IST
- Cooldown: 1 hour between batches
- Each account: Open → Post → Close (sequential, ~3-5 min per account)

**LinkedIn:**
- 3 batches × 15 accounts = **45 posts/day**
- Timing: 11:30 AM - 5:15 PM IST
- Cooldown: 2 hours between batches
- Each account: Open → Post → Close (sequential, ~3-5 min per account)

**Total: 315 posts/day maximum**

---

## 🔄 Week 2+ Features (Smart Recycling)

### **Feature 1: Continuous Row Picking**
- FB/LI don't reset daily - they continue where they left off
- Week 1: Posts rows 1-15
- Week 2: Posts rows 16-30
- Benefit: No duplicate posting, steady flow, re-posts old content if updated

### **Feature 2: Weekly SERP Re-check**
- Saturday 10 PM: Automatically checks ranking for all old URLs
- If article still ranks well: Mark eligible for re-posting
- If article dropped: Update priority

### **Feature 3: Content Regeneration**
- When priority changes: Generates NEW unique content
- Old tweet → New tweet (different angle, different hashtags)
- Prevents boring repeated content

### **Feature 4: Re-posting Logic**
- Old post URLs cleared after re-check
- FB/LI continuous picking selects them again
- Fresh content generated → Posted again

---

## 🛡️ Error Handling & Recovery

The system automatically:
- **Detects Popups:** Takes screenshot, uses vision to identify popup type
- **Removes Popups:** Clicks dismiss, closes dialogs, dismisses notifications
- **Retries Failed Posts:** 3 attempts per batch, then logs and skips
- **Fixes Broken Selectors:** Reads code, identifies selector issues, suggests fixes
- **Handles Rate Limits:** Waits and retries if platform returns 429 errors
- **Detects Account Issues:** Skips locked/suspended accounts, logs reason

---

## 🔐 Security & Safety

- **Credentials:** Stored separately in .accounts/ directory (not in code)
- **Session Persistence:** Browser profiles cached so no re-login each time
- **Rate Limiting:** Hard limits enforced (195/day X, 75/day FB, 45/day LI)
- **Posting Window:** Only posts 11 AM - 6 PM IST (no spam hours)
- **Content Validation:** Sanity checks before posting (max 3 regeneration attempts)
- **Error Tracking:** All errors logged with timestamp, context, and recovery action

---

## 📱 Future Expansion

This system is designed for expansion to additional platforms:

**Phase 2 - Micro Blog Platforms:**
- HackMD - Technical documentation sharing
- Hashnode - Developer blog network
- Google Sites - Simple website publishing
- Medium - General interest publication
- Dev.to - Developer community platform

**Phase 3 - PR Distribution:**
- Press release distribution networks
- Media outreach platforms
- Journalist contact automation

Each platform will:
1. Have its own agent (similar to X/FB/LI agents)
2. Generate platform-specific content format
3. Follow its own posting rules & rate limits
4. Report results back to sheet
5. Integrate into same scheduler & coordinator

---

## 📊 Success Metrics

- ✅ Posting Consistency: 315+ posts/day during window
- ✅ Content Quality: All posts pass sanity check
- ✅ Error Rate: < 5% failures after retries
- ✅ Coverage: All 15 accounts per platform get posted
- ✅ Recycling: 100% of old URLs re-checked on schedule
- ✅ Uptime: 99.9% availability during posting window

---

## 🚀 Deployment & Operations

**Running the System:**
```bash
npm run dev                    # Start daemon (runs until 6 PM IST)
npx tsx tests/test-seo-agent  # Test SEO analysis
npx tsx tests/test-content-agent # Test content generation
```

**Monitoring:**
- Check `.sessions/daily-counts.json` for today's posting count
- Check `logs/errors.json` for failure details
- Review Google Sheet for posted URLs and results

**Maintenance:**
- Weekly: Check error logs for patterns
- Monthly: Test new content generation quality
- As needed: Update selectors if X/FB/LinkedIn UI changes

---

## 🎓 How to Use

### **Setup:**
1. Place Ken Research blog URL in Google Sheet
2. System automatically analyzes it
3. Generates content and schedules posting

### **Monitoring:**
1. Check sheet for "posted" status
2. Review generated content quality
3. Click post URLs to verify on actual platforms

### **Optimization:**
1. Add market_value hints for better priority
2. Check error logs for patterns
3. Adjust cooldowns if needed for coverage

---

## 📝 Example Workflow

**Real Example - March 26, 2026:**

```
11:00 AM - Coordinator starts X Batch 1
├─ Gets 15 unposted URLs from sheet
├─ For each URL:
│  ├─ SEO Agent checks: "AI market" article → Rank 25 → P1
│  ├─ Content Agent generates: tweet, FB post, LI post, blog draft
│  └─ X Agent posts tweet → Captures tweet URL
├─ Updates sheet with results
└─ Cooldown 30 min

11:30 AM - Facebook Batch 1 starts
├─ Gets 15 rows without FB post URL
├─ For Account 1:
│  ├─ Opens browser
│  ├─ Logs in to Facebook
│  ├─ Posts content
│  ├─ Closes browser
│  └─ Updates sheet
├─ Repeats for accounts 2-15 (sequential)
└─ Takes ~60 minutes total

12:45 PM - LinkedIn Batch 1 starts
├─ Same process as FB (but LinkedIn)
└─ Takes ~60 minutes

[Continue batches every 30 min for X through 5:30 PM]
[Continue FB/LI batches respecting 1hr/2hr cooldowns]

6:00 PM - Posting window closes
└─ System logs daily summary

Saturday 10:00 PM - Weekly SERP Re-check
├─ Finds URLs checked > 7 days ago
├─ Re-analyzes each with SEO Agent
├─ If priority changed: regenerates content
├─ Clears old post URLs for re-posting
└─ Next week: FB/LI will repost these URLs
```

---

## 🎯 Key Advantages

1. **Fully Autonomous** - No human intervention needed
2. **Scalable** - Can add more accounts without code changes
3. **Smart** - Uses AI to understand content value
4. **Safe** - Respects rate limits and platform policies
5. **Recyclable** - Old valuable content gets reposted automatically
6. **Observable** - Full audit trail in Google Sheet
7. **Recoverable** - Automatic error detection and fixes
8. **Expandable** - Architecture ready for new platforms

---

**Status:** ✅ Production Ready for X, Facebook, LinkedIn
**Next Phase:** Expansion to micro blog platforms + PR distribution
**Maintenance:** Minimal (system self-healing, automated error recovery)

