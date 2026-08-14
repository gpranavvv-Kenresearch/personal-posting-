/**
 * UTM parameter utilities for tracking traffic sources
 */

export const UTM_PARAMS = {
  X: '?utm_source=X&utm_medium=Referral&utm_campaign=Automation',
  Facebook: '?utm_source=Facebook&utm_medium=Referral&utm_campaign=Automation',
  LinkedIn: '?utm_source=Linkedin&utm_medium=Referral&utm_campaign=Automation',
  Medium: '?utm_source=Medium&utm_medium=Referral&utm_campaign=Automation',
  Linkmate: '?utm_source=Linkmate&utm_medium=Referral&utm_campaign=Automation',
  GoogleSite: '?utm_source=GoogleSites&utm_medium=Referral&utm_campaign=Automation',
  Devto: '?utm_source=Devto&utm_medium=Referral&utm_campaign=Automation',
  Calisthenics: '?utm_source=Calisthenics&utm_medium=Referral&utm_campaign=Automation',
  Substack: '?utm_source=Substack&utm_medium=Referral&utm_campaign=Automation',
  HackMD: '?utm_source=HackMD&utm_medium=Referral&utm_campaign=Automation',
  LinkedinPulse: '?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation',
  WordPress: '?utm_source=WordPress&utm_medium=Referral&utm_campaign=Automation',
  Blogger: '?utm_source=Blogger&utm_medium=Referral&utm_campaign=Automation',
  Patreon: '?utm_source=Patreon&utm_medium=Referral&utm_campaign=Automation',
  Notion: '?utm_source=Notion&utm_medium=Referral&utm_campaign=Automation',
  Note: '?utm_source=Note&utm_medium=Referral&utm_campaign=Automation',
  Naver: '?utm_source=Naver&utm_medium=Referral&utm_campaign=Automation',
  Velog: '?utm_source=Velog&utm_medium=Referral&utm_campaign=Automation',
  Coda: '?utm_source=Coda&utm_medium=Referral&utm_campaign=Automation',
  Ameba: '?utm_source=Ameba&utm_medium=Referral&utm_campaign=Automation',
  Paragraph: '?utm_source=Paragraph&utm_medium=Referral&utm_campaign=Automation',
  SlideShare: '?utm_source=SlideShare&utm_medium=Referral&utm_campaign=Automation',
  SpeakerDeck: '?utm_source=SpeakerDeck&utm_medium=Referral&utm_campaign=Automation',
  Issuu: '?utm_source=Issuu&utm_medium=Referral&utm_campaign=Automation',
  PDF: '?utm_source=PPT/PDF&utm_medium=Referral&utm_campaign=Automation',
  Tumblr: '?utm_source=Tumblr&utm_medium=Referral&utm_campaign=Automation',
  Instapaper: '?utm_source=Instapaper&utm_medium=Referral&utm_campaign=Automation',
  Raindrop: '?utm_source=Raindrop&utm_medium=Referral&utm_campaign=Automation',
  PdfHost: '?utm_source=PdfHost&utm_medium=Referral&utm_campaign=Automation',
  Yumpu: '?utm_source=Yumpu&utm_medium=Referral&utm_campaign=Automation',
  Mastodon: '?utm_source=Mastodon&utm_medium=Referral&utm_campaign=Automation',
  Pearltrees: '?utm_source=Pearltrees&utm_medium=Referral&utm_campaign=Automation',
  Hatena: '?utm_source=Hatena&utm_medium=Referral&utm_campaign=Automation',
  FlipHTML5: '?utm_source=FlipHTML5&utm_medium=Referral&utm_campaign=Automation',
  FourShared: '?utm_source=4shared&utm_medium=Referral&utm_campaign=Automation',
};

/**
 * Add UTM parameters to all URLs in text/HTML content
 * Avoids adding if UTM already exists
 */
export function injectUTM(content: string, utmString: string): string {
  if (!content || !utmString) return content;

  const utmParams = utmString.replace(/^\?/, ''); // strip leading ?
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g;

  return content.replace(urlRegex, (match) => {
    // Never touch image/media URLs
    if (match.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
      return match;
    }

    // For kenresearch.com URLs: always strip existing UTM and replace with correct platform UTM
    if (match.includes('kenresearch.com')) {
      const baseUrl = match
        // Strip both raw "&" and HTML-entity "&amp;" separators — ChatGPT-authored
        // hrefs sometimes emit &amp; between params, which a plain "&" match misses.
        .replace(/[?&](?:amp;)?utm_source=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_medium=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_campaign=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_term=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_content=[^&"'\s]*/gi, '')
        .replace(/\?$/, '')   // remove trailing ?
        .replace(/&(?:amp;)?$/, ''); // remove trailing & or &amp;
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}${utmParams}`;
    }

    // For all other URLs: only add UTM if none already present
    if (match.includes('utm_')) {
      return match;
    }
    const separator = match.includes('?') ? '&' : '?';
    return `${match}${separator}${utmParams}`;
  });
}

/**
 * Ensures targetUrl appears in content so UTM injection has something to tag.
 * If targetUrl is missing from content, appends a "Read the full report" link.
 * Always call this BEFORE injectUTM.
 */
export function ensureTargetUrl(content: string, targetUrl?: string): string {
  if (!targetUrl || !targetUrl.includes('kenresearch.com')) return content;
  const base = targetUrl.split('?')[0];
  if (content.includes(base)) return content;
  return content + `\n\n<p><a href="${targetUrl}">Read the full report on Ken Research</a></p>`;
}

/**
 * Extract base URL (without UTM) for display
 */
export function getBaseUrl(url: string): string {
  const match = url.match(/^[^?]*/);
  return match ? match[0] : url;
}
