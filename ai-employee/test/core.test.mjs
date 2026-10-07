import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, cosineSimilarity, tokenize } from '../lib/text.mjs';
import { redactSecrets, resolveSafeProjectPath } from '../lib/security.mjs';
import { detectMajorRules, sumDailyCounters } from '../lib/detector.mjs';
import { policyFor } from '../lib/policy.mjs';

test('tokenize preserves identifiers and paths', () => {
  assert.deepEqual(tokenize('runXBatch src/index.ts'), ['runxbatch', 'src/index.ts']);
});

test('chunkText tracks source line numbers and overlap', () => {
  const result = chunkText(['one', 'two', 'three', 'four', 'five'].join('\n'), { maxChars: 10, overlapLines: 1 });
  assert.ok(result.length >= 2);
  assert.equal(result[0].startLine, 1);
  assert.ok(result[1].startLine <= result[0].endLine);
});

test('cosineSimilarity identifies equal vectors', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('redactSecrets removes common secret shapes', () => {
  const result = redactSecrets('OPENROUTER_API_KEY=sk-abcdefghijklmnop password=hunter2');
  assert.ok(!result.includes('abcdefghijklmnop'));
  assert.ok(!result.includes('hunter2'));
});

test('safe project paths block escape and credentials', () => {
  assert.throws(() => resolveSafeProjectPath('../outside.txt'));
  assert.throws(() => resolveSafeProjectPath('.accounts/accounts.json'));
  assert.throws(() => resolveSafeProjectPath('.env'));
  assert.doesNotThrow(() => resolveSafeProjectPath('src/index.ts'));
});

test('policy makes every state-changing action unavailable to the model', () => {
  assert.equal(policyFor('search_knowledge'), 'observe');
  assert.equal(policyFor('edit_code'), 'prohibited');
  assert.equal(policyFor('retry_batch'), 'prohibited');
  assert.equal(policyFor('unknown_action'), 'prohibited');
});

test('10:20 rule uses a fresh production heartbeat', () => {
  const now = new Date('2026-10-07T04:50:30.000Z'); // 10:20:30 IST
  assert.equal(detectMajorRules({ heartbeat: { ts: '2026-10-07T04:50:00.000Z' } }, now).length, 0);
  const stale = detectMajorRules({ heartbeat: { ts: '2026-10-07T04:40:00.000Z' } }, now);
  assert.equal(stale[0].type, 'flow_not_started');
  assert.equal(stale[0].severity, 'major');
});

test('stale heartbeat after startup is classified as daemon stoppage', () => {
  const now = new Date('2026-10-07T07:00:00.000Z'); // 12:30 IST
  const events = detectMajorRules({ heartbeat: { ts: '2026-10-07T04:50:00.000Z' } }, now);
  assert.equal(events[0].type, 'daemon_heartbeat_stale');
  assert.ok(!events.some(event => event.type === 'flow_not_started'));
});

test('18:30 rule sums all platforms and requires todays dated counter', () => {
  const now = new Date('2026-10-07T13:00:00.000Z'); // 18:30 IST
  assert.deepEqual(sumDailyCounters({ date: '2026-10-07', x: 300, fb: 200 }, '2026-10-07'), { total: 500, validForToday: true });
  assert.equal(detectMajorRules({ heartbeat: { ts: now.toISOString() }, counters: { date: '2026-10-07', x: 300, fb: 200 } }, now).length, 0);
  const below = detectMajorRules({ heartbeat: { ts: now.toISOString() }, counters: { date: '2026-10-07', x: 299, fb: 200 } }, now);
  assert.equal(below[0].type, 'daily_total_below_500');
  assert.equal(below[0].evidence.successfulPosts, 499);
});
