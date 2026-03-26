/**
 * popupGuard.ts — Detect and remove popups on X.com
 * Monitors page for common popups and attempts to close them
 */

import { Page } from 'playwright';
import { humanDelay } from './stagehand.js';

export interface PopupGuardConfig {
  checkInterval?: number; // ms between checks (default 1000)
  maxAttempts?: number; // max removal attempts (default 5)
}

/**
 * Start popup guard monitoring on a page
 * @param page Playwright page object
 * @param config Configuration options
 * @returns Function to stop the guard
 */
export function startPopupGuard(page: Page, config: PopupGuardConfig = {}): () => void {
  const checkInterval = config.checkInterval || 1000;
  const maxAttempts = config.maxAttempts || 5;
  let isRunning = true;

  // Start background monitoring
  const monitorPopups = async () => {
    let attempts = 0;
    while (isRunning && attempts < maxAttempts) {
      try {
        await clearPopups(page);
        await humanDelay(checkInterval, checkInterval + 100);
        attempts++;
      } catch (err) {
        // Silently ignore errors
      }
    }
  };

  // Fire and forget
  monitorPopups().catch(() => {});

  // Return stop function
  return () => {
    isRunning = false;
  };
}

/**
 * Clear all detected popups from page
 * @param page Playwright page object
 */
export async function clearPopups(page: Page): Promise<void> {
  try {
    // Common popup selectors on X.com
    const popupSelectors = [
      '[role="dialog"]',
      '[data-testid="modal"]',
      '[role="alertdialog"]',
      'div[class*="modal"]',
      'div[class*="Modal"]',
      '[data-testid="Dialogs_default"]',
    ];

    for (const selector of popupSelectors) {
      try {
        const popups = await page.locator(selector).all();
        for (const popup of popups) {
          const isVisible = await popup.isVisible().catch(() => false);
          if (isVisible) {
            // Try to find close button
            const closeButton = popup.locator('button[aria-label="Close"]');
            if (await closeButton.isVisible().catch(() => false)) {
              await closeButton.click();
              await humanDelay(500, 1000);
            }
          }
        }
      } catch (err) {
        // Continue to next selector
      }
    }

    // Close any visible modals by pressing Escape
    try {
      await page.keyboard.press('Escape');
      await humanDelay(300, 500);
    } catch (err) {
      // Silently ignore
    }
  } catch (err) {
    // Silently ignore popup clearing errors
  }
}

/**
 * Check if page has visible popups
 * @param page Playwright page object
 * @returns true if popups detected
 */
export async function hasVisiblePopups(page: Page): Promise<boolean> {
  try {
    const popupSelectors = [
      '[role="dialog"]',
      '[data-testid="modal"]',
      '[role="alertdialog"]',
    ];

    for (const selector of popupSelectors) {
      const popups = await page.locator(selector).all();
      for (const popup of popups) {
        const isVisible = await popup.isVisible().catch(() => false);
        if (isVisible) return true;
      }
    }

    return false;
  } catch (err) {
    return false;
  }
}
