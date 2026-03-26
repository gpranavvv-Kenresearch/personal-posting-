/**
 * test-seo-agent.ts — Test SEO Agent
 *
 * Run: npx tsx tests/test-seo-agent.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { runSeoAnalysis } from '../src/agents/seoAgentNew.js';

async function testSeoAgent() {
  console.log('🔍 Testing SEO Agent');
  console.log('='.repeat(50));
  console.log('');

  const testUrl = 'https://www.kenresearch.com/blog/technology-market-trends-2024';
  const testTitle = 'Technology Market Trends 2024';

  try {
    console.log(`📍 Testing URL: ${testUrl}`);
    console.log(`📌 Title: ${testTitle}`);
    console.log('');
    console.log('⏳ Running SEO analysis (this may take 10-30 seconds)...');
    console.log('');

    const result = await runSeoAnalysis(testUrl, testTitle);

    console.log('✅ SEO Analysis Complete!');
    console.log('');
    console.log('Results:');
    console.log(`  📊 Ranking Page: ${result.rankPage}`);
    console.log(`  🔗 Indexed: ${result.indexStatus}`);
    console.log(`  ⭐ Priority: ${result.priority}`);
    console.log(`  📱 Platforms: ${result.platforms.join(', ')}`);
    console.log(`  🔑 Keywords: ${result.keywords.slice(0, 3).join(', ')}`);
    console.log('');

    // Validate results
    const validPriorities = ['P1', 'P2', 'P3'];
    if (!validPriorities.includes(result.priority)) {
      console.log('❌ Invalid priority:', result.priority);
      process.exit(1);
    }

    if (result.platforms.length === 0) {
      console.log('❌ No platforms selected');
      process.exit(1);
    }

    console.log('✅ All validations passed!');
    console.log('');
    console.log('='.repeat(50));
    console.log('Test completed successfully.');

  } catch (err: any) {
    console.error('❌ Error:', err.message);
    console.error('');
    console.error('Troubleshooting:');
    console.error('1. Check ANTHROPIC_API_KEY is set: echo $ANTHROPIC_API_KEY');
    console.error('2. Check SerpAPI/Tavily keys are set');
    console.error('3. Verify internet connection');
    process.exit(1);
  }
}

testSeoAgent();
