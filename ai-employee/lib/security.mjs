import path from 'node:path';
import { projectRoot } from './config.mjs';

const sensitiveSegments = new Set([
  '.git', '.accounts', '.sessions', 'node_modules', 'credentials', 'secrets',
]);

export function resolveSafeProjectPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('A project-relative path is required');
  }
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(segment => sensitiveSegments.has(segment.toLowerCase()))) {
    throw new Error('Access to sensitive runtime or credential paths is blocked');
  }
  if (segments.some(segment => segment.toLowerCase() === '.env' || segment.toLowerCase().startsWith('.env.'))) {
    throw new Error('Access to environment files is blocked');
  }
  const absolute = path.resolve(projectRoot, normalized);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes the project root');
  }
  return { absolute, relative: relative.replaceAll('\\', '/') };
}

export function redactSecrets(input) {
  let text = String(input ?? '');
  text = text.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, '$1[REDACTED]');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED API KEY]');
  text = text.replace(/((?:api[_-]?key|token|secret|password|client[_-]?secret)\s*[=:]\s*["']?)[^\s,"'`]+/gi, '$1[REDACTED]');
  return text;
}

export function isSensitiveName(name) {
  const lower = name.toLowerCase();
  return lower === '.env' || lower.startsWith('.env.') || lower.includes('service-account') || lower.endsWith('.pem') || lower.endsWith('.key');
}
