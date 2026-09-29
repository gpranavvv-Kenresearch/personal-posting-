/**
 * runNewsletterBatch.ts — orchestrator for the Outlook newsletter channel.
 *
 * Pulls New Logic rows that already have "Blog Content" (the same content
 * other blog channels post from) but no "Newsletter Status" yet, adapts that
 * content to an email, sends it to the active subscriber list via Outlook/
 * Microsoft Graph, and writes the result back to the sheet — same shape as
 * every other continuous-posting batch runner in this repo.
 *
 * Not yet wired into scheduler-new.ts's cron table (PRD §8 open item 4) —
 * call runNewsletterBatch() directly (see src/tools/testNewsletterOutlook.ts)
 * until the newsletter is ready to go live on a schedule.
 */

import {
  getRowsForContinuousNewsletterPosting,
  saveUnifiedNewsletterResult,
  ensureNewsletterColumns,
} from '../sheets/sheets.js';
import { adaptToNewsletterEmail } from './contentAdapter.js';
import { sendNewsletterEmail } from './sender.js';
import { getNewsletterSubscribers } from './subscribers.js';

export interface NewsletterBatchSummary {
  attempted: number;
  sent: number;
  failed: number;
  skippedNoContent: number;
}

export async function runNewsletterBatch(limit: number = 5): Promise<NewsletterBatchSummary> {
  await ensureNewsletterColumns();

  const subscribers = getNewsletterSubscribers();
  const rows = await getRowsForContinuousNewsletterPosting(limit);

  const summary: NewsletterBatchSummary = { attempted: 0, sent: 0, failed: 0, skippedNoContent: 0 };

  for (const row of rows) {
    if (!row.blogContent || !row.title || !row.targetUrl) {
      summary.skippedNoContent++;
      continue;
    }

    summary.attempted++;
    const email = adaptToNewsletterEmail({
      title: row.title,
      blogContent: row.blogContent,
      targetUrl: row.targetUrl,
    });

    const result = await sendNewsletterEmail(email, subscribers);

    await saveUnifiedNewsletterResult(row, {
      status: result.success ? 'posted' : (result.recipientsSent > 0 ? 'partial' : 'failed'),
      error: result.error,
      batch: `Batch ${new Date().toISOString().split('T')[0]}`,
      recipientsSent: result.recipientsSent,
    });

    if (result.success) summary.sent++;
    else summary.failed++;
  }

  console.log(`   [Newsletter] Batch complete: ${summary.sent} sent, ${summary.failed} failed, ${summary.skippedNoContent} skipped (no content), out of ${rows.length} rows checked.`);
  return summary;
}
