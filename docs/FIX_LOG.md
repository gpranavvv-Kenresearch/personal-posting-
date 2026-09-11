# Fix Log

## 2026-08-10 — Google Sites direct batch read the wrong tab

- Cause: `getRowsForContinuousGoogleSitePosting()` was hardcoded to the `Blogs` tab, while the active cron workflow and Google Sites result columns use `New Logic`.
- Fix: Changed the direct Google Sites row picker to read `New Logic!A:ZZ` and map returned rows as `newLogic`, ensuring results are written back to the same tab.

## 2026-08-10 — Medium/Google Sites touched the Name column

- Cause: Group4/Group4b used the shared group claimer's default behavior, which assigned accounts to both `Name` and `New Name`. Error/retry paths also contained fallbacks to `row.name`.
- Fix: Added a column-specific account assignment mode, configured Group4/Group4b to write only `New Name`, and removed all Medium/Google Sites fallbacks to `Name`.

## 2026-08-10 — Medium/Google Sites result destination was caller-dependent

- Cause: Result writers selected a tab from `row.sheetType`; direct Medium and retry flows could still create `blog` rows, allowing results to be written outside `New Logic`.
- Fix: Medium and Google Sites pickers, result writers, and retry-row lookup now explicitly use `New Logic` regardless of caller metadata.

## 2026-08-11 — Tumblr login registry missing

- Cause: Tumblr login requires `.accounts/accounts-tumblr.json`, but the file did not exist, so every nickname lookup failed before Chrome could open.
- Fix: Added the 15-account Tumblr registry with nickname-specific persistent session directories and no stored credentials, enabling manual login for each profile.
