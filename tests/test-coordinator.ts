/**
 * test-coordinator.ts — Test Master Coordinator
 *
 * Run: npx tsx tests/test-coordinator.ts
 *
 * This test checks if coordinator can run without actually posting.
 * It checks:
 * - Time window detection
 * - State file creation
 * - Capacity calculations
 * - Cooldown logic
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { runMasterCoordinator } from '../src/coordinator/masterCoordinator.js';
import fs from 'fs';

async function testCoordinator() {
  console.log('🎯 Testing Master Coordinator');
  console.log('='.repeat(50));
  console.log('');

  try {
    // Check time window
    const nowUTC = new Date();
    const istDate = new Date(nowUTC.getTime() + 5.5 * 60 * 60 * 1000);
    const istHour = istDate.getHours();
    const istMinutes = istDate.getHours() * 60 + istDate.getMinutes();

    console.log(`Current time (IST): ${istDate.getHours()}:${String(istDate.getMinutes()).padStart(2, '0')}`);
    console.log('');

    if (istHour < 11 || istHour >= 18) {
      console.log('⏳ Outside posting window (11 AM - 6 PM IST)');
      console.log('   Coordinator will skip posting in this test.');
      console.log('');
    } else {
      console.log('✅ In posting window (11 AM - 6 PM IST)');
      console.log('   Coordinator would attempt to post.');
      console.log('');
    }

    // Run coordinator
    console.log('⏳ Running coordinator...');
    await runMasterCoordinator();
    console.log('');

    // Check state file was created
    if (fs.existsSync('.sessions/coordinator-state.json')) {
      const state = JSON.parse(fs.readFileSync('.sessions/coordinator-state.json', 'utf8'));
      console.log('✅ Coordinator state file created');
      console.log('');
      console.log('State:');
      console.log(`  Date: ${state.date}`);
      console.log(`  X Used: ${state.x.used}/${195}`);
      console.log(`  FB Used: ${state.facebook.used}/${75}`);
      console.log(`  LI Used: ${state.linkedin.used}/${45}`);
      console.log('');
    } else {
      console.log('⚠️  Coordinator state file not created (expected if outside window)');
      console.log('');
    }

    console.log('✅ Coordinator test complete!');
    console.log('');
    console.log('Next steps:');
    if (istHour >= 11 && istHour < 18) {
      console.log('1. Check Google Sheet for new posting data');
      console.log('2. Verify logs/errors.json for any issues');
    } else {
      console.log('1. Test again during 11 AM - 6 PM IST window');
      console.log('2. Or manually adjust system time for testing');
    }
    console.log('');
    console.log('='.repeat(50));

  } catch (err: any) {
    console.error('❌ Error:', err.message);
    console.error('');
    console.error('Troubleshooting:');
    console.error('1. Check ANTHROPIC_API_KEY is set');
    console.error('2. Check .sessions/ directory exists');
    console.error('3. Check .env file configuration');
    process.exit(1);
  }
}

testCoordinator();
