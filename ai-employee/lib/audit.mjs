import fs from 'node:fs/promises';
import { auditFile, dataDir } from './config.mjs';
import { redactSecrets } from './security.mjs';

export async function appendAudit(event) {
  await fs.mkdir(dataDir, { recursive: true });
  const safe = JSON.parse(redactSecrets(JSON.stringify({ at: new Date().toISOString(), ...event })));
  await fs.appendFile(auditFile, `${JSON.stringify(safe)}\n`, 'utf8');
}
