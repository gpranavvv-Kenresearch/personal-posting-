/**
 * test-content-agent.ts — Test Content Generation Agent
 *
 * Run: npx tsx tests/test-content-agent.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { runContentAgent } from '../src/agents/contentAgentNew.js';

async function testContentAgent() {
  console.log('✍️  Testing Content Generation Agent');
  console.log('='.repeat(50));
  console.log('');

  const testParams = {
    url: 'https://www.kenresearch.com/blog/ai-market-2024',
    title: 'AI Market Report 2024',
    seoRanking: 25,
    priority: 'P1' as const,
    marketValue: '$50B TAM',
  };

  try {
    console.log(`📍 Testing with:`);
    console.log(`   URL: ${testParams.url}`);
    console.log(`   Title: ${testParams.title}`);
    console.log(`   Priority: ${testParams.priority}`);
    console.log('');
    console.log('⏳ Generating content (this may take 30-60 seconds)...');
    console.log('');

    const result = await runContentAgent(testParams);

    console.log('✅ Content Generation Complete!');
    console.log('');
    console.log('Generated Content:');
    console.log('');

    // Tweet
    console.log('📱 TWEET (X):');
    console.log(`   ${result.tweet}`);
    console.log(`   Length: ${result.tweet.length}/280 chars`);
    if (result.tweet.length > 280) {
      console.log('   ❌ EXCEEDS 280 CHAR LIMIT!');
    } else {
      console.log('   ✅ Valid tweet length');
    }
    console.log('');

    // Facebook
    console.log('👥 FACEBOOK:');
    console.log(`   ${result.fbPost.substring(0, 150)}...`);
    console.log(`   Length: ${result.fbPost.length} chars`);
    console.log('');

    // LinkedIn
    console.log('💼 LINKEDIN:');
    console.log(`   ${result.liPost.substring(0, 150)}...`);
    console.log(`   Length: ${result.liPost.length} chars`);
    console.log('');

    // Blog
    console.log('📝 BLOG:');
    console.log(`   ${result.blog.substring(0, 150)}...`);
    console.log(`   Length: ${result.blog.length} chars`);
    console.log('');

    // Sanity issues
    if (result.sanityIssues.length > 0) {
      console.log('⚠️  Sanity Issues:');
      result.sanityIssues.forEach(issue => {
        console.log(`   - ${issue}`);
      });
      console.log('');
    } else {
      console.log('✅ No sanity issues detected');
      console.log('');
    }

    // Validate
    if (result.tweet.length > 280) {
      console.log('❌ Tweet exceeds length limit');
      process.exit(1);
    }

    if (!result.tweet || !result.fbPost || !result.liPost) {
      console.log('❌ Missing content');
      process.exit(1);
    }

    console.log('✅ All content generated successfully!');
    console.log('');
    console.log('='.repeat(50));
    console.log('Test completed successfully.');

  } catch (err: any) {
    console.error('❌ Error:', err.message);
    console.error('');
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

testContentAgent();
