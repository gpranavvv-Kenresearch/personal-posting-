#!/usr/bin/env node

/**
 * Test runner that explicitly loads .env from project root
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
const envPath = path.join(__dirname, '.env');
console.log(`📁 Loading .env from: ${envPath}`);
console.log(`✅ File exists: ${fs.existsSync(envPath)}`);

const result = dotenv.config({ path: envPath });
console.log(`📋 dotenv.config() result:`, result.error ? `ERROR: ${result.error.message}` : 'Success');
console.log(`🔑 ANTHROPIC_API_KEY:`, process.env.ANTHROPIC_API_KEY ? `SET (length: ${process.env.ANTHROPIC_API_KEY.length})` : 'NOT SET');
console.log('');

// Now import and run the actual test
const testName = process.argv[2] || 'seo';
console.log(`🧪 Running test: ${testName}`);
console.log('');

if (testName === 'seo') {
  const { default: testSeoAgent } = await import('./tests/test-seo-agent.js');
} else if (testName === 'content') {
  const { default: testContentAgent } = await import('./tests/test-content-agent.js');
} else if (testName === 'coordinator') {
  const { default: testCoordinator } = await import('./tests/test-coordinator.js');
} else {
  console.error(`Unknown test: ${testName}`);
  process.exit(1);
}
