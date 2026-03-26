import * as dotenv from 'dotenv';
dotenv.config();

import { executeBrowserTool } from './src/tools/browserTools.js';

async function testPostTweet() {
  console.log('🔍 DEBUG: Testing tweet posting directly');
  console.log('='.repeat(60));
  console.log('');

  const testTweet = '🎯 Debug test ' + new Date().toLocaleTimeString() + ' #Test';
  const account = 'Naman280771';

  try {
    console.log('Step 1: Logging in to X...');
    const loginResult = await executeBrowserTool('login_x', {
      accountHandle: account,
    });
    console.log('Login result:', JSON.stringify(loginResult, null, 2));
    console.log('');

    console.log('Step 2: Posting tweet...');
    const postResult = await executeBrowserTool('post_tweet', {
      tweetText: testTweet,
      accountHandle: account,
    });
    console.log('Post result:', JSON.stringify(postResult, null, 2));
    console.log('');

    if (postResult.success) {
      console.log('✅ SUCCESS!');
      console.log('Tweet URL:', postResult.tweetUrl);
    } else {
      console.log('❌ Failed:', postResult.error);
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error('Stack:', err.stack);
  }
}

testPostTweet();
