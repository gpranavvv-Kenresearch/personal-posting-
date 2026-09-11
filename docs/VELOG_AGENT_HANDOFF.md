# Velog Platform Handoff

## Status: Working end-to-end (confirmed 2026-08-20)

Login and posting were both tested live against velog.io with the `pranav`
account and succeeded — a real post was published and the URL was captured.
This document transfers everything needed to run, extend, or debug this
integration on another machine.

## What exists

| Piece | File | State |
|---|---|---|
| Login (session-based, manual first login) | `src/browser/velog/login.ts` | Working |
| Posting (7-step click flow) | `src/browser/velog/poster.ts` | Working — confirmed live |
| One-off manual test script | `src/tools/testVelog.ts` | Working |
| Browser-tool wiring | `src/tools/browserTools.ts` (`login_velog` / `post_velog`) | Wired |
| Batch runner | `src/coordinator/masterCoordinator.ts` → `runVelogBatch()` | Wired, calls `recordPost('velog')` |
| Retry-row support | `masterCoordinator.ts` → `case 'velog':` in row-mode dispatcher | Wired |
| Daily posting-count report | `PLATFORM_LABELS` / `ZERO_COUNTERS` in `masterCoordinator.ts` | Already includes `velog` |
| Cron schedule | `src/scheduler-new.ts` | **NOT scheduled** — no cron entry exists yet |
| Accounts | `.accounts/accounts-velog.json` | **Only 1 account** (`pranav`, session-based, no stored password) |

## How Velog login works (no password stored)

Velog login is GitHub OAuth (or whatever `velog.io/login` presents) — there
is no email/password autofill. The account record only needs a `nickname`;
login is completed manually once per account, then the Playwright
persistent-context session (cookies) is reused for every future run.

`.accounts/accounts-velog.json` currently contains:
```json
[
  {
    "nickname": "pranav",
    "email": "manual-login",
    "sessionDir": ".sessions/velog/pranav",
    "active": true
  }
]
```

To onboard a new account, add an entry the same way (any `email` placeholder
works — it's not used to autofill anything), then run:

```powershell
$env:HEADLESS="false"; npx tsx src/browser/velog/login.ts --nickname <name>
```

A visible Chrome window opens using a persistent profile at
`.sessions/velog/<name>`. Log in manually (GitHub OAuth), then press **Enter**
in the terminal when done. The script does a best-effort visual check but
**never blocks on it** — it trusts the Enter keypress and saves the session
either way, because the logged-in-page selectors aren't fully confirmed
(see Known gaps below). Session cookies persist to disk continuously as part
of the real Chrome profile, so even a hard failure after login doesn't lose
the session.

## How posting works — the confirmed 7-step flow

`postToVelog(page, title, htmlContent)` in `poster.ts`:

1. Click **"새 글 작성"** ("Write new post") in the header.
2. Focus the title field — `<textarea placeholder="제목을 입력하세요">` — and
   type the title. (An earlier attempt targeted an `<input placeholder="태그를
   입력하세요">`, which is the **tags** field, not title — that was a mislabel
   caught during live testing. The button-based `.click()` also didn't
   reliably move focus onto this textarea; the working fix calls
   `element.focus()` directly via `page.evaluate`, then types at the page
   level.)
3. Click the Quill toolbar's **`.ql-code-block`** button to switch the editor
   into a raw code block, so pasted HTML isn't mangled by rich-text
   auto-formatting.
4. Click into the CodeMirror line (`.CodeMirror-line` / `.CodeMirror-placeholder`),
   `Ctrl+A`, then `page.keyboard.insertText(htmlContent)` to paste the HTML as-is.
5. Click **"출간하기"** ("Publish") to open the confirmation modal.
6. Wait ~3s, then click the modal's own **"출간하기"** button
   (`button[data-testid="publish"]` — this one has a stable test-id, unlike
   most other selectors here).
7. Read `page.url()` as the published post's URL.

### Click strategy — read this before changing selectors

Standard Playwright `locator.click()` (even with `force: true`) kept failing
with **"Element is outside of the viewport"**, even when the element visually
appeared onscreen in screenshots. Root cause: the persistent Chrome profile
can restore in a minimized/tiny window state left over from an earlier
headless run, and CDP's `Browser.setWindowBounds` cannot reliably jump
directly from `minimized` to `maximized` in one call — it has to pass through
`normal` first (see `ensureWindowVisible()`).

Beyond that, this file deliberately avoids Playwright's built-in
click-actionability waiting (per explicit instruction from the account owner)
and instead:
- Uses `clickBySelector()`, which finds the first genuinely **visible** match
  for a selector (selectors here often match more than one DOM node — e.g. a
  hidden mobile-nav duplicate of the same button) and calls the **native DOM
  `.click()`** directly on it via `element.evaluate(el => el.click())`. This
  sidesteps coordinate/occlusion/viewport checks entirely — a coordinate-based
  `page.mouse.click(x, y)` was tried first and silently missed because of a
  hidden duplicate button.
- The one exception is the title textarea (step 2): a native `.click()`
  didn't reliably move keyboard focus there in an automated context, so that
  step explicitly calls `element.focus()` instead of clicking.
- Every step is followed by a **fixed `sleep()`**, not a `waitFor`/retry loop.

If you need to touch this file again, keep this pattern rather than
reintroducing `locator.click()`/`waitFor` — it's what got this from
completely broken to working end-to-end.

## How to test

```powershell
$env:HEADLESS="false"; npx tsx src/tools/testVelog.ts pranav
```

Logs in (should be instant if the session already exists), screenshots the
post-login page (`velog-after-login.png`), then runs the full 7-step publish
flow with a sample market-report post. On success it prints the published
URL. On failure it saves `velog-error.png` and prints the exact step that
failed — read the console log for which of the 7 steps it reached.

## Known gaps — read before assuming more is done than is

- **Not in cron.** `src/scheduler-new.ts` has no Velog entry at all. The
  batch runner (`runVelogBatch`) works and is fully wired into
  `masterCoordinator.ts`, but nothing calls it on a schedule yet. Add a
  `cron.schedule(...)` line following the pattern of the other `:05`/`:35`
  offset platforms once you're ready to put it in production rotation.
- **Only one account is logged in** (`pranav`). Every other seat in
  `.accounts/accounts-velog.json` needs the same manual login flow before a
  15-account batch can actually use 15 accounts.
- **`isLoggedIn()` selectors in `login.ts` are best-effort, not proven.**
  They check for `text=Write a new post`, `a[href="/write"]`,
  `[class*="UserProfile"]`, `img[class*="avatar" i]` — none of these were
  confirmed against the live English-locale homepage the way the Korean
  posting selectors were. This is why `loginToVelog()` never blocks on the
  check and always trusts the operator's Enter keypress. If you tighten this
  later, verify live first.
- **The title textarea's real title didn't get end-to-end visual
  confirmation of the published post's rendered title** — only that the
  publish flow completed and a URL was returned. Spot-check a real published
  post's title before trusting this at scale.
- **UTM injection** (`UTM_PARAMS.Velog` from `src/utils/utm.ts`) is applied
  to `htmlContent` before pasting — not independently re-verified against a
  live published post.

## Files to transfer

```
src/browser/velog/login.ts
src/browser/velog/poster.ts
src/tools/testVelog.ts
docs/VELOG_AGENT_HANDOFF.md   (this file)
```

Also relevant but shared with every other platform (no Velog-specific
changes needed there beyond what's already in this repo):
```
src/tools/browserTools.ts        (login_velog / post_velog tool defs)
src/coordinator/masterCoordinator.ts  (runVelogBatch, recordPost wiring)
src/utils/utm.ts                 (UTM_PARAMS.Velog)
src/utils/killChrome.ts
```

Do **not** transfer `.sessions/velog/pranav` unless the receiving machine's
policy explicitly allows moving live session cookies — prefer a fresh manual
login on the new machine (2–3 minutes, no credentials required beyond
whatever GitHub/Velog account the operator already owns).

## Receiving-agent prompt

> You're taking ownership of the Velog posting integration for Ken Research.
> Read `docs/VELOG_AGENT_HANDOFF.md` in full before changing anything —
> especially the "Click strategy" section, which explains why this file
> deliberately avoids Playwright's normal `locator.click()`/`waitFor` pattern.
> Posting was confirmed working live on 2026-08-20 with one account
> (`pranav`); do not assume more accounts are logged in or that Velog is in
> the cron schedule — neither is true yet. Test with
> `npx tsx src/tools/testVelog.ts <nickname>` (set `HEADLESS=false` first)
> before making any further changes, and re-verify the same way after.
