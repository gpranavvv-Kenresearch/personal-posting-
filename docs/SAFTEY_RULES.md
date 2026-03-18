# Safety Rules — X Posting Agent

## Daily Limits
| Action         | Limit  |
|----------------|--------|
| Tweets posted  | 5/day  |
| Login attempts | 3/day  |

## Timing
- humanDelay() between EVERY browser action
- Min 30 seconds between login and first post
- Never post more than once per hour

## Hard Stops — halt immediately if X shows:
- "Verify your identity"
- "Account suspended"
- "Posting too fast"
- Any CAPTCHA

## humanDelay
```typescript
export function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}
```

## Anti-Detection Checklist
- [ ] Stealth plugin enabled
- [ ] headless: false for first login
- [ ] Session cookies restored every run
- [ ] Realistic viewport 1280x800
- [ ] humanDelay between all actions