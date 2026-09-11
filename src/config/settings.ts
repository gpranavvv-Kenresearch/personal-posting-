import dotenv from 'dotenv';

dotenv.config();

export const settings = {
  openRouter: {
    keys: Array.from({ length: 10 }, (_, i) => process.env[`OPENROUTER_API_KEY_${i + 1}`] || '').filter(Boolean),
    model: 'anthropic/claude-haiku-4-5',
  },
  twitter: {
    username: process.env.X_USERNAME || '',
    password: process.env.X_PASSWORD || '',
    handle: process.env.X_HANDLE || '',
  },
  browser: {
    headless: true,
    args: ['--start-minimized'],
    viewport: { width: 1280, height: 800 },
    stealth: true,
  },
  limits: {
    maxTweetsPerDay: 5,
    maxLoginAttemptsPerDay: 3,
    minDelayBetweenPosts: 3600000, // 1 hour
    minDelayAfterLogin: 30000, // 30 seconds
  },
  paths: {
    sessionFile: './.sessions/x-session.json',
  },
  facebook: {
    email: process.env.FB_EMAIL || '',
    password: process.env.FB_PASSWORD || '',
    profileUrl: process.env.FB_PROFILE_URL || 'https://www.facebook.com/me',
    sessionDir: '.sessions/chrome-fb-profile',
  },
  linkedin: {
    email: process.env.LINKEDIN_EMAIL || '',
    password: process.env.LINKEDIN_PASSWORD || '',
    profileUrl: process.env.LINKEDIN_PROFILE_URL || 'https://www.linkedin.com/in/me/recent-activity/shares/',
    sessionDir: '.sessions/chrome-linkedin-profile',
  },
  serpApi: {
    keys: Array.from({ length: 10 }, (_, i) => process.env[`SERPAPI_KEY_${i + 1}`] || '').filter(Boolean),
  },
  tavily: {
    keys: Array.from({ length: 10 }, (_, i) => process.env[`TAVILY_API_KEY_${i + 1}`] || '').filter(Boolean),
  },
};

function validateOpenRouterKeys(): void {
  const hasKey = Array.from({ length: 10 }, (_, i) => process.env[`OPENROUTER_API_KEY_${i + 1}`]).some(Boolean);
  if (!hasKey) throw new Error('Missing OpenRouter API keys. Set at least OPENROUTER_API_KEY_1 in .env');
}

export function validateConfig(): void {
  validateOpenRouterKeys();
  const required = ['X_USERNAME', 'X_PASSWORD', 'X_HANDLE'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

export function validateFacebookConfig(): void {
  validateOpenRouterKeys();
  const required = ['FB_EMAIL', 'FB_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) throw new Error(`Missing env vars for Facebook: ${missing.join(', ')}`);
}

export function validateLinkedInConfig(): void {
  validateOpenRouterKeys();
  const required = ['LINKEDIN_EMAIL', 'LINKEDIN_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) throw new Error(`Missing env vars for LinkedIn: ${missing.join(', ')}`);
}

