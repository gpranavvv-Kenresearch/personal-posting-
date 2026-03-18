import 'dotenv/config';
import { Stagehand } from '@browserbasehq/stagehand';

async function test() {
  console.log('API Key:', process.env.ANTHROPIC_API_KEY?.substring(0, 20) + '...');

  try {
    const sh = new Stagehand({
      env: 'LOCAL',
      modelName: 'claude-sonnet-4-20250514' as any,
      modelClientOptions: {
        apiKey: process.env.ANTHROPIC_API_KEY!,
      },
      headless: true,
    });

    console.log('Stagehand instance created');
    console.log('Calling init()...');

    await sh.init();

    console.log('Init completed successfully!');
    console.log('Act handler ready');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

test();
