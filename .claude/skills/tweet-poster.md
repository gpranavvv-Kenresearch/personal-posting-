# Skill: Tweet Poster Agent

## Purpose
Post tweet using same Playwright page from login. No new browser.

## ✅ Working Selectors
```typescript
// Tweet compose box
await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
await page.click('[data-testid="tweetTextarea_0"]');

// Type tweet
await page.keyboard.type(tweetText, { delay: 80 });

// Post button (use all fallbacks)
const postButton = page.locator(`
  div[role="button"]:has(span:has-text("Post")),
  button:has(span:has-text("Post")),
  div[data-testid="tweetButtonInline"],
  div[data-testid="tweetButton"]
`).first();
await postButton.waitFor({ timeout: 10000 });
await postButton.click();

// Get tweet URL
await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded' });
const tweetUrl = await page.evaluate((handle) => {
  const links = Array.from(document.querySelectorAll(`a[href*="/${handle}/status/"]`));
  return links[0]?.href || `https://x.com/${handle}`;
}, handle);
```

## ✅ Always Do
- Use SAME page object from login — never create new browser
- waitForSelector before clicking tweet box
- Use postButton with multiple fallback selectors
- humanDelay after every action

## ❌ Never Do
- Never use Stagehand for posting
- Never create new Stagehand instance after login
- Never use page.fill() for typing
- Never skip waiting for post confirmation

## Output
```typescript
{ success: true, tweetUrl: string, tweetText: string, postedAt: Date }
``` 