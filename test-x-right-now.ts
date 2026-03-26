import * as dotenv from 'dotenv';
dotenv.config();

import { runXAgent } from './src/agents/xAgentNew.js';

async function testNow() {
  console.log('🚀 X POSTING TEST - Running RIGHT NOW');
  console.log('='.repeat(60));
  console.log('');

  const testTweet = '🎯 X Agent Test ' + new Date().toLocaleTimeString() + ' #TestPost';
  const account = 'Naman280771'; // CHANGE THIS to your test account

  console.log('📝 Test Tweet:', testTweet);
  console.log('👤 Account:', account);
  console.log('⏱️  Time:', new Date().toLocaleString());
  console.log('');
  console.log('⏳ POSTING NOW...');
  console.log('');

  try {
    const result = await runXAgent({
      tweetText: testTweet,
      accountHandle: account,
    });

    console.log('');
    console.log('='.repeat(60));
    console.log('RESULT:');
    console.log('');

    if (result.success) {
      console.log('✅✅✅ SUCCESS! Tweet Posted! ✅✅✅');
      console.log('');
      console.log('🔗 Tweet URL:', result.tweetUrl);
      console.log('');
      console.log('Go check X.com right now to see your tweet!');
    } else {
      console.log('❌ Failed to post');
      console.log('Error:', result.error);
    }

    console.log('');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('❌ ERROR:', err.message);
    process.exit(1);
  }
}

testNow();
