/**
 * runNewsletterCampaignBatch.ts — the manual-input newsletter pipeline:
 *
 *   1. You add a row to the "Newsletter" sheet tab: 3-4 Report URLs +
 *      Prospect Emails (comma/newline-separated).
 *   2. generateStep(): rows with URLs but no Generated Content yet get sent
 *      through ChatGPT (chatgptGenerator.ts), and the result is written back
 *      to Generated Subject / Generated Content.
 *   3. sendStep(): rows with Generated Content but no Status yet get emailed
 *      to that row's Prospect Emails via Outlook (sender.ts), and the result
 *      (Status/Error/Recipients Sent/Sent At) is written back.
 *
 * Two separate steps (not one pass) so a slow ~5 min ChatGPT generation
 * doesn't block sending rows that are already generated and ready, and so a
 * generated newsletter can be reviewed in the sheet before it's sent if you
 * want to run generateStep() and sendStep() on separate schedules.
 */

import {
  getNewsletterCampaignRowsNeedingGeneration,
  saveNewsletterCampaignGeneratedContent,
  getNewsletterCampaignRowsReadyToSend,
  saveNewsletterCampaignSendResult,
  createNewsletterCampaignTabIfMissing,
} from '../sheets/sheets.js';
import { generateNewsletterViaChatGpt, closeChatGptBrowser } from './chatgptGenerator.js';
import { wrapGeneratedNewsletter } from './contentAdapter.js';
import { sendNewsletterEmail } from './sender.js';
import { parseProspectEmails } from './subscribers.js';

export interface GenerateStepSummary {
  attempted: number;
  generated: number;
  failed: number;
}

export async function generateStep(limit: number = 3): Promise<GenerateStepSummary> {
  await createNewsletterCampaignTabIfMissing();
  const rows = await getNewsletterCampaignRowsNeedingGeneration(limit);
  const summary: GenerateStepSummary = { attempted: 0, generated: 0, failed: 0 };

  try {
    for (const row of rows) {
      summary.attempted++;
      try {
        const { subject, bodyHtml } = await generateNewsletterViaChatGpt(row.reportUrls);
        await saveNewsletterCampaignGeneratedContent(row.rowIndex, { subject, content: bodyHtml });
        summary.generated++;
      } catch (err: any) {
        console.error(`   [newsletter:campaign] ❌ row ${row.rowIndex} generation failed: ${err.message}`);
        summary.failed++;
      }
    }
  } finally {
    // Close the ChatGPT browser once per batch, not per row — same session
    // reused across rows within this run.
    await closeChatGptBrowser().catch(() => {});
  }

  console.log(`   [newsletter:campaign] Generate step: ${summary.generated} generated, ${summary.failed} failed, out of ${rows.length} rows checked.`);
  return summary;
}

export interface SendStepSummary {
  attempted: number;
  sent: number;
  failed: number;
  skippedNoEmails: number;
}

export async function sendStep(limit: number = 5): Promise<SendStepSummary> {
  await createNewsletterCampaignTabIfMissing();
  const rows = await getNewsletterCampaignRowsReadyToSend(limit);
  const summary: SendStepSummary = { attempted: 0, sent: 0, failed: 0, skippedNoEmails: 0 };

  for (const row of rows) {
    const recipients = parseProspectEmails(row.prospectEmailsRaw);
    if (recipients.length === 0) {
      summary.skippedNoEmails++;
      continue;
    }

    summary.attempted++;
    const email = wrapGeneratedNewsletter(
      row.generatedSubject || 'Ken Research Update',
      row.generatedContent,
      row.reportUrls,
    );
    const result = await sendNewsletterEmail(email, recipients);

    await saveNewsletterCampaignSendResult(row.rowIndex, {
      status: result.success ? 'posted' : (result.recipientsSent > 0 ? 'partial' : 'failed'),
      error: result.error,
      batch: `Batch ${new Date().toISOString().split('T')[0]}`,
      recipientsSent: result.recipientsSent,
    });

    if (result.success) summary.sent++;
    else summary.failed++;
  }

  console.log(`   [newsletter:campaign] Send step: ${summary.sent} sent, ${summary.failed} failed, ${summary.skippedNoEmails} skipped (no valid emails), out of ${rows.length} rows checked.`);
  return summary;
}

export async function runNewsletterCampaignBatch(): Promise<{ generate: GenerateStepSummary; send: SendStepSummary }> {
  const generate = await generateStep();
  const send = await sendStep();
  return { generate, send };
}
