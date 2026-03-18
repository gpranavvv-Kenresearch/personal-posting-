# Skill: Browser Login Agent

## Purpose
Log into X.com using stealth Playwright. Return Page object to orchestrator.

## ✅ Working Approach
Use chromium.launchPersistentContext — saves session so login only needed once.

## Code Pattern
```typescript
const context = await chromium.launchPersistentContext('.sessions/chrome-profile', {
  channel: 'chrome',
  headless: false,
  slowMo: 120,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = await context.newPage();
await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

// Check already logged in
if (page.url().includes('/home')) return page;

// Type username
await page.waitForSelector('input[autocomplete="username"]', { timeout: 30000 });
await page.keyboard.type(process.env.X_USERNAME!, { delay: 120 });
await page.click('[role="button"]:has-text("Next")');

// Type password
await page.waitForSelector('input[name="password"]', { timeout: 30000 });
await page.keyboard.type(process.env.X_PASSWORD!, { delay: 120 });
await page.click('[role="button"]:has-text("Log in")');
```

## ✅ Always Do
- Use channel:'chrome' for real Chrome
- Use launchPersistentContext to save session
- Check if already logged in before typing credentials
- Use keyboard.type() with delay — never page.fill()
- waitForSelector before every interaction

## ❌ Never Do
- Never use Stagehand for login
- Never use page.fill() — causes target closed error
- Never use networkidle — times out on X.com
- Never open a second browser after login

## Error Handling
- Selector timeout → increase timeout to 30000
- Already logged in → skip login, return page directly
- Security check → type username again in ocfEnterTextTextInput