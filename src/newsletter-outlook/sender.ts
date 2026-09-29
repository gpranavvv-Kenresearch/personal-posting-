/**
 * sender.ts — sends the newsletter via Microsoft Graph's sendMail API
 * (POST /users/{senderMailbox}/sendMail). Pure API call, no browser.
 */

import { getOutlookConfig, graphRequest } from './graphClient.js';
import type { NewsletterEmail } from './contentAdapter.js';
import type { NewsletterSubscriber } from './subscribers.js';

const MAX_RECIPIENTS_PER_MESSAGE = 50; // conservative chunk size, well under Graph's limit

export interface NewsletterSendResult {
  success: boolean;
  recipientsSent: number;
  recipientsFailed: number;
  error?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function sendOneMessage(email: NewsletterEmail, recipients: NewsletterSubscriber[]): Promise<void> {
  const { senderMailbox } = getOutlookConfig();

  // BCC everyone in the chunk so subscribers never see each other's addresses.
  await graphRequest('POST', `/users/${encodeURIComponent(senderMailbox)}/sendMail`, {
    message: {
      subject: email.subject,
      body: { contentType: 'HTML', content: email.html },
      toRecipients: [{ emailAddress: { address: senderMailbox } }],
      bccRecipients: recipients.map(r => ({ emailAddress: { address: r.email, name: r.name } })),
    },
    saveToSentItems: true,
  });
}

export async function sendNewsletterEmail(
  email: NewsletterEmail,
  recipients: NewsletterSubscriber[],
): Promise<NewsletterSendResult> {
  if (recipients.length === 0) {
    return { success: false, recipientsSent: 0, recipientsFailed: 0, error: 'No active subscribers to send to' };
  }

  const batches = chunk(recipients, MAX_RECIPIENTS_PER_MESSAGE);
  let sent = 0;
  let failed = 0;
  let lastError: string | undefined;

  for (const batch of batches) {
    try {
      console.log(`   [Newsletter] Sending "${email.subject.slice(0, 60)}..." to ${batch.length} recipients via Outlook`);
      await sendOneMessage(email, batch);
      sent += batch.length;
    } catch (err: any) {
      console.error(`   [Newsletter] ❌ batch of ${batch.length} failed: ${err.message}`);
      failed += batch.length;
      lastError = err.message;
    }
  }

  return {
    success: failed === 0,
    recipientsSent: sent,
    recipientsFailed: failed,
    error: lastError,
  };
}
