import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { config, dataDir, employeeRoot, importsDir } from './lib/config.mjs';
import { getOllamaStatus } from './lib/ollama.mjs';

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(importsDir, { recursive: true });
await fs.mkdir(path.join(employeeRoot, 'observer-data'), { recursive: true });

const privateConfigFile = path.join(employeeRoot, 'config.json');
try {
  await fs.access(privateConfigFile);
} catch {
  await fs.writeFile(privateConfigFile, JSON.stringify({
    host: '127.0.0.1',
    observerSecret: crypto.randomBytes(32).toString('hex'),
  }, null, 2));
  console.log('Created private ai-employee/config.json with a random observer secret.');
}

const status = await getOllamaStatus();
console.log('Ken Research AI Employee POC');
console.log(`Node: ${process.version}`);
console.log(`Ollama endpoint: ${config.ollamaUrl}`);
console.log(`Chat model: ${config.model}`);
console.log(`Embedding model: ${config.embedModel}`);

if (!status.available) {
  console.log('\nOllama is not reachable. Install the free Windows app from https://ollama.com/download/windows');
  console.log(`Then run: ollama pull ${config.model}`);
  console.log(`          ollama pull ${config.embedModel}`);
} else {
  console.log(`Installed Ollama models: ${status.models.join(', ') || '(none)'}`);
  if (!status.models.some(name => name === config.model || name.startsWith(`${config.model}:`))) console.log(`Missing chat model: ollama pull ${config.model}`);
  if (!status.models.some(name => name === config.embedModel || name.startsWith(`${config.embedModel}:`))) console.log(`Missing embedding model: ollama pull ${config.embedModel}`);
}

console.log('\nConversation imports: place ChatGPT/Claude JSON, Markdown, or text exports in ai-employee/imports/.');
console.log('Next: npm run employee:index');
console.log('Then: npm run employee:start');
