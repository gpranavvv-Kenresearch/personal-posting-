#!/usr/bin/env node

import * as dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

// Load .env manually
const envPath = path.resolve('.env');
console.log(`Looking for .env at: ${envPath}`);
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('ANTHROPIC_API_KEY=')) {
      const key = line.split('=')[1].trim();
      process.env.ANTHROPIC_API_KEY = key;
      console.log('✅ .env loaded');
      break;
    }
  }
} else {
  console.log('❌ .env not found at', envPath);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log('❌ ANTHROPIC_API_KEY not set in .env');
  process.exit(1);
}

console.log(`✅ ANTHROPIC_API_KEY: ${apiKey.slice(0, 20)}...`);
console.log('');

const client = new Anthropic({ apiKey });

const modelsToTest = [
  'claude-3-5-sonnet-20241022',
  'claude-opus-4-1',
  'claude-3-opus-20250219',
  'claude-3-5-sonnet-20250514',
];

console.log('🔍 Testing available models...\n');

for (const model of modelsToTest) {
  try {
    console.log(`Testing ${model}...`);
    const response = await client.messages.create({
      model,
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: 'test'
      }]
    });
    console.log(`✅ ${model} WORKS\n`);
    process.exit(0);
  } catch (err) {
    const errorMsg = err.error?.message || err.message || String(err);
    console.log(`❌ ${model}: ${errorMsg}\n`);
  }
}

console.log('⚠️  No models available. Check API key and subscription.');
process.exit(1);
