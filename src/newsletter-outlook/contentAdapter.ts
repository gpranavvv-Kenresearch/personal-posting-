/**
 * contentAdapter.ts — turns the pipeline's existing AI-generated blog content
 * into an email-ready subject + HTML body.
 *
 * PRD §6.1: "Content: Reuses the same AI-generated summary/finding content as
 * other channels, adapted to newsletter/email format." No new generation
 * step — this only wraps/reformats content already produced for the other
 * blog channels (New Logic sheet's "Blog Content" column).
 */

import { injectUTM, UTM_PARAMS } from '../utils/utm.js';

export interface NewsletterSourceRow {
  title: string;
  blogContent: string; // HTML, same column Medium/Blogger/HackMD read from
  targetUrl: string;    // canonical Ken Research report/article URL
}

export interface NewsletterEmail {
  subject: string;
  html: string;
}

const EMAIL_WRAPPER = (title: string, bodyHtml: string, ctaUrl: string) => `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <h1 style="font-size:22px;line-height:1.3;color:#111827;margin:0 0 16px 0;">${title}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;font-size:15px;line-height:1.6;color:#374151;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;">
                <a href="${ctaUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:14px;">Read the full report</a>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;background:#f9fafb;font-size:12px;color:#9ca3af;">
                Ken Research &mdash; Market Intelligence &amp; Advisory
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

/** Strips to the first N words for the email preview, keeping paragraph tags intact where possible. */
function truncateHtml(html: string, maxChars = 2500): string {
  if (html.length <= maxChars) return html;
  const cut = html.slice(0, maxChars);
  const lastClose = cut.lastIndexOf('</p>');
  return lastClose > 0 ? cut.slice(0, lastClose + 4) : cut + '…';
}

export function adaptToNewsletterEmail(row: NewsletterSourceRow): NewsletterEmail {
  const ctaUrl = injectUTM(row.targetUrl, UTM_PARAMS.Newsletter);
  const bodyWithUtm = injectUTM(truncateHtml(row.blogContent), UTM_PARAMS.Newsletter);

  return {
    subject: row.title,
    html: EMAIL_WRAPPER(row.title, bodyWithUtm, ctaUrl),
  };
}

/**
 * Wraps a ChatGPT-generated newsletter (subject + body HTML covering
 * multiple report URLs) into the same email template. Used by the
 * Newsletter Campaign tab pipeline (runNewsletterCampaignBatch.ts) — the
 * CTA button links to the first report URL; any other report URLs are
 * expected to already appear as inline links inside bodyHtml (the
 * generation prompt asks ChatGPT to include one per report).
 */
export function wrapGeneratedNewsletter(subject: string, bodyHtml: string, reportUrls: string[]): NewsletterEmail {
  const primaryUrl = reportUrls[0] ?? '';
  const ctaUrl = injectUTM(primaryUrl, UTM_PARAMS.Newsletter);
  const bodyWithUtm = injectUTM(bodyHtml, UTM_PARAMS.Newsletter);

  return {
    subject,
    html: EMAIL_WRAPPER(subject, bodyWithUtm, ctaUrl),
  };
}
