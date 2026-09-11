import type { FeedItem } from '../sheets/sheets.js';

const FEED_TITLE = 'Ken Research — Latest Market Reports';
const FEED_LINK = 'https://www.kenresearch.com';
const FEED_DESCRIPTION = 'Newly published Ken Research market research reports.';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** "YYYY-MM-DD" -> RFC-822 pubDate string RSS requires (assumes IST midday, since only the date is known). */
function toPubDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  if (isNaN(d.getTime())) return new Date().toUTCString();
  return d.toUTCString();
}

export function buildRssXml(items: FeedItem[]): string {
  const itemsXml = items.map(item => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.url)}</link>
      <guid isPermaLink="true">${escapeXml(item.url)}</guid>
      <pubDate>${toPubDate(item.date)}</pubDate>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${escapeXml(FEED_LINK)}</link>
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}
