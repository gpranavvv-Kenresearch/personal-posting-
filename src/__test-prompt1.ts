import 'dotenv/config';
import { __debugGenerateWithPrompt } from './agents/contentAgentNew.js';

async function main() {
  const { prompt, output } = await __debugGenerateWithPrompt(1, 'li', {
    url: 'https://www.kenresearch.com/industry-reports/usa-wooden-fence-market',
    title: 'USA Wooden Fence Market',
  });
  console.log('===== PROMPT SENT =====');
  console.log(prompt);
  console.log('\n===== LLM OUTPUT =====');
  console.log(output);
  console.log('\n===== OUTPUT LENGTH =====', output.length, 'chars');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
