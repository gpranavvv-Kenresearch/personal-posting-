# Testing Guide — Coordinator-Based Agent System

## 🔧 Prerequisites

### 1. Environment Variables
Verify `.env` file has:
```
ANTHROPIC_API_KEY=sk-ant-...
SERPAPI_KEY=...
TAVILY_API_KEY=...
X_USERNAME=...
X_PASSWORD=...
GOOGLE_SERVICE_ACCOUNT_JSON={...}
```

### 2. Check Node & Dependencies
```bash
node --version          # Should be >= 18
npm list @anthropic-ai/sdk  # Should be installed
npm list playwright     # Should be installed
```

### 3. Check Accounts Configured
```bash
npx tsx src/config/accounts.ts list
# Should show at least 1 active X account
```

---

## 📋 TESTING PHASES

### Phase 1: Individual Tools Testing

#### Test 1a: SerpAPI Tool
```bash
cat > test-serp.ts << 'EOF'
import { executeSeoTool } from './src/tools/seoTools.js';

const result = await executeSeoTool('search_google', {
  query: 'site:kenresearch.com market research 2024'
});

console.log('SERP Result:', JSON.stringify(result, null, 2));
EOF

npx tsx test-serp.ts
```

**Expected Output:**
```json
{
  "ranking": 1,
  "indexed": true,
  "organic_results": [...]
}
```

#### Test 1b: Content Tools
```bash
cat > test-content.ts << 'EOF'
import { executeContentTool } from './src/tools/contentTools.js';

const result = await executeContentTool('generate_tweet', {
  targetUrl: 'https://example.com/report',
  title: 'Global Market Report 2024'
});

console.log('Tweet:', result.tweet);
EOF

npx tsx test-content.ts
```

**Expected Output:**
```
Tweet: Market report text with emoji, URL, hashtags (≤280 chars)
```

---

### Phase 2: Individual Agents Testing

#### Test 2a: SEO Agent
```bash
cat > test-seo-agent.ts << 'EOF'
import { runSeoAnalysis } from './src/agents/seoAgentNew.js';

const result = await runSeoAnalysis(
  'https://example.com/tech-market-2024',
  'Technology Market Forecast 2024'
);

console.log('SEO Analysis Result:');
console.log(`  Priority: ${result.priority}`);
console.log(`  Ranking: ${result.seoRanking}`);
console.log(`  Indexed: ${result.indexStatus}`);
console.log(`  Platforms: ${result.platforms.join(', ')}`);
EOF

npx tsx test-seo-agent.ts
```

**Expected Output:**
```
SEO Analysis Result:
  Priority: P1
  Ranking: 15
  Indexed: indexed
  Platforms: x, facebook, linkedin
```

#### Test 2b: Content Agent
```bash
cat > test-content-agent.ts << 'EOF'
import { runContentAgent } from './src/agents/contentAgentNew.js';

const result = await runContentAgent({
  url: 'https://example.com/report',
  title: 'Market Report',
  seoRanking: 25,
  priority: 'P1'
});

console.log('Generated Content:');
console.log('Tweet:', result.tweet.substring(0, 100) + '...');
console.log('FB Post:', result.fbPost.substring(0, 100) + '...');
console.log('LI Post:', result.liPost.substring(0, 100) + '...');
EOF

npx tsx test-content-agent.ts
```

**Expected Output:**
```
Generated Content:
Tweet: 🔍 Market research reveals ... #MarketResearch...
FB Post: Interesting finding: Market research shows ...
LI Post: #MarketInsights | The latest market analysis...
```

#### Test 2c: X Agent (Manual Test)
```bash
cat > test-x-agent.ts << 'EOF'
import { runXAgent } from './src/agents/xAgentNew.js';

const result = await runXAgent({
  tweetText: '🔍 Test tweet from new agent system #Testing',
  accountHandle: 'vansh'  // Replace with your account
});

console.log('X Agent Result:');
console.log(`  Success: ${result.success}`);
console.log(`  Tweet URL: ${result.tweetUrl}`);
console.log(`  Error: ${result.error}`);
EOF

npx tsx test-x-agent.ts
```

⚠️ **WARNING**: This will POST A TWEET. Use a test account or dry-run first.

---

### Phase 3: Coordinator Testing

#### Test 3a: Dry-Run (No Actual Posts)
```bash
# Set to a time OUTSIDE posting window to see logs without posting
# Current time check happens in masterCoordinator.ts

cat > test-coordinator-dry.ts << 'EOF'
import { runMasterCoordinator } from './src/coordinator/masterCoordinator.js';

console.log('Running coordinator dry-run...');
console.log('(Will check time, capacity, cooldowns but not post)');

await runMasterCoordinator();
EOF

npx tsx test-coordinator-dry.ts
```

**Expected Output:**
```
[COORDINATOR] Checking batch schedule...
  X: 0/195 | FB: 0/75 | LI: 0/45
[COORDINATOR] Outside posting window (11 AM - 6 PM IST)
```

#### Test 3b: Full Daemon Test
```bash
# Only run during 11 AM - 6 PM IST!
npm run dev

# Or manually trigger scheduler
npx tsx src/scheduler-new.ts
```

**Expected Output:**
```
🤖 Coordinator-Based Scheduler Started
⚡ Coordinator runs every 30 minutes during 11 AM - 6 PM IST window

  [COORDINATOR] Check → every 30 minutes (11 AM - 6 PM IST)
  [RESET]       Daily  → 00:00 IST

⏳ Waiting for 11 AM IST window...
```

---

## 🧪 Integration Testing

### Full End-to-End Test (Safe Version)

Create a test file that uses test data:

```bash
cat > test-full-integration.ts << 'EOF'
import { runSeoAnalysis } from './src/agents/seoAgentNew.js';
import { runContentAgent } from './src/agents/contentAgentNew.js';
import { runXAgent } from './src/agents/xAgentNew.js';

async function testFullFlow() {
  console.log('=== FULL INTEGRATION TEST ===\n');

  // Step 1: SEO Analysis
  console.log('[1/3] Running SEO Analysis...');
  const seoResult = await runSeoAnalysis(
    'https://example.com/market-report-2024',
    'Global Market Analysis 2024'
  );
  console.log(`✅ Priority: ${seoResult.priority}, Ranking: ${seoResult.seoRanking}`);

  // Step 2: Content Generation
  console.log('\n[2/3] Generating Content...');
  const contentResult = await runContentAgent({
    url: 'https://example.com/market-report-2024',
    title: 'Global Market Analysis 2024',
    seoRanking: seoResult.seoRanking,
    priority: seoResult.priority
  });
  console.log(`✅ Tweet: ${contentResult.tweet.substring(0, 80)}...`);
  console.log(`✅ FB Post: ${contentResult.fbPost.substring(0, 80)}...`);
  console.log(`✅ LI Post: ${contentResult.liPost.substring(0, 80)}...`);

  // Step 3: X Agent (DRY RUN - don't actually post)
  console.log('\n[3/3] X Agent (would post to: vansh)');
  console.log(`✅ Tweet ready: ${contentResult.tweet}`);
  console.log('⚠️  DRY RUN - not actually posting');

  console.log('\n=== TEST COMPLETE ===');
}

testFullFlow().catch(console.error);
EOF

npx tsx test-full-integration.ts
```

---

## 📊 Monitoring Tests

### Check Logs
```bash
# View error logs
cat logs/errors.json | jq .

# View change logs (if self-healing happens)
cat logs/changes.json | jq .

# View coordinator state
cat .sessions/coordinator-state.json | jq .

# View daily counts
cat .sessions/daily-counts.json | jq .
```

### Check Sheet Updates
```bash
# After running a test, check:
# 1. Google Sheet "insta" tab
# 2. Look for columns: seoRanking, priority, tweetPost
# 3. Verify data is populated
```

---

## 🚨 Troubleshooting Common Issues

### Issue 1: "Not logged in. Call login_x first."
**Cause**: Browser session not initialized
**Fix**:
- Verify `.sessions/chrome-profile` exists and has valid cookies
- Run: `npm run dev -- login-x`

### Issue 2: "ANTHROPIC_API_KEY is wrong"
**Cause**: Invalid or missing API key
**Fix**:
```bash
echo $ANTHROPIC_API_KEY  # Should output: sk-ant-...
# If empty, update .env and re-source it
```

### Issue 3: "Unknown tool: search_google"
**Cause**: Tools not exported correctly
**Fix**:
```bash
# Verify imports in agents
grep "import.*seoTools" src/agents/seoAgentNew.ts
```

### Issue 4: "Max retries exceeded"
**Cause**: Claude loop hit tool call limit
**Fix**:
- Increase `MAX_TOOL_CALLS` in agent file
- Check Claude response for errors
- Verify tools are returning valid JSON

### Issue 5: "Target closed" (browser error)
**Cause**: Page object cleared prematurely
**Fix**:
- Check that page state vars in browserTools.ts are not being cleared unexpectedly
- Verify finally blocks aren't closing browser too early

---

## ✅ Test Checklist

Run these in order and verify each:

- [ ] **Phase 1a**: SerpAPI tool returns ranking data
- [ ] **Phase 1b**: Content tool generates tweet under 280 chars
- [ ] **Phase 2a**: SEO Agent assigns priority (P1/P2/P3)
- [ ] **Phase 2b**: Content Agent generates 4 distinct posts
- [ ] **Phase 2c**: X Agent (DRY RUN) - don't post yet
- [ ] **Phase 3a**: Coordinator dry-run checks time/capacity
- [ ] **Phase 3b**: Scheduler daemon starts and logs every 30 min
- [ ] **Integration**: Full flow completes without errors
- [ ] **Sheet**: Google Sheet columns updated correctly
- [ ] **Error Logs**: logs/errors.json shows no critical errors

---

## 🎯 Next Steps After Testing

1. **If all tests pass**:
   - Update `src/sheets/sheets.ts` with new columns + functions
   - Implement `getRowsForFb()` and `getRowsForLi()` in coordinator
   - Run full daemon: `npm run dev`

2. **If tests fail**:
   - Check error logs
   - Debug specific agent in isolation
   - Verify API keys and browser sessions

3. **Once confident**:
   - Delete old agent files (supervisor.ts, etc.)
   - Deploy to production
   - Monitor logs continuously

---

## 🔍 Advanced Monitoring

### Real-Time Log Tailing
```bash
# Watch for any errors in real-time
tail -f logs/errors.json | jq '.'

# Watch coordinator state changes
watch -n 30 'cat .sessions/coordinator-state.json | jq .'
```

### Performance Metrics
```bash
# Count successful posts
cat logs/errors.json | grep -c "success.*true"

# Count failures
cat logs/errors.json | grep -c "success.*false"

# Average post time (from timestamps)
cat logs/errors.json | jq '.[].timestamp' | head -20
```

---

**Ready to test? Start with Phase 1a and work your way up!**
