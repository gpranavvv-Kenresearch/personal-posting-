/**
 * Test the LinkedIn post-writer prompt against the live ChatGPT browser session.
 *   npx tsx src/tools/testLinkedinPostWriter.ts "topic goes here" [goal] [length]
 *   goal:   comments (default) | reposts | likes | saves
 *   length: medium (default) | short | long
 */
import 'dotenv/config';
import { generateLinkedinPostViaChatGpt, LinkedinPostGoal, LinkedinPostLength } from '../agents/linkedinPostWriterAgent.js';
import { closeChatGptBrowser } from '../browser/chatgpt/login.js';

const topic = process.argv[2];
const goal = (process.argv[3] || 'comments') as LinkedinPostGoal;
const length = (process.argv[4] || 'medium') as LinkedinPostLength;

if (!topic) {
  console.error('Usage: npx tsx src/tools/testLinkedinPostWriter.ts "topic" [goal] [length]');
  process.exit(1);
}

(async () => {
  try {
    const { text, savedTo } = await generateLinkedinPostViaChatGpt({ topic, goal, length, maxAttempts: 3 });
    console.log('\n--- GENERATED POST ---\n');
    console.log(text);
    console.log(`\n--- (${text.length} chars, saved to ${savedTo}) ---`);
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closeChatGptBrowser();
  }
  process.exit(0);
})();
