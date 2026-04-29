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
  Guffiz: '?utm_source=Guffiz&utm_medium=Referral&utm_campaign=Automation',
  HackMD: '?utm_source=HackMD&utm_medium=Referral&utm_campaign=Automation',
  LinkedinPulse: '?utm_source=LinkedinPulse&utm_medium=Referral&utm_campaign=Automation',
  WordPress: '?utm_source=WordPress&utm_medium=Referral&utm_campaign=Automation',
  Blogger: '?utm_source=Blogger&utm_medium=Referral&utm_campaign=Automation',
  Penzu: '?utm_source=Penzu&utm_medium=Referral&utm_campaign=Automation',
  WriteupCafe: '?utm_source=WriteupCafe&utm_medium=Referral&utm_campaign=Automation',
};

/**
 * Add UTM parameters to all URLs in text/HTML content
 * Avoids adding if UTM already exists
 */
export function injectUTM(content: string, utmString: string): string {
  if (!content || !utmString) return content;

  const utmParams = utmString.replace(/^\?/, ''); // strip leading ?
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;

  return content.replace(urlRegex, (match) => {
    // Never touch image/media URLs
    if (match.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
      return match;
    }

    // For kenresearch.com URLs: always strip existing UTM and replace with correct platform UTM
    if (match.includes('kenresearch.com')) {
      const baseUrl = match
        .replace(/[?&]utm_source=[^&"'\s]*/g, '')
        .replace(/[?&]utm_medium=[^&"'\s]*/g, '')
        .replace(/[?&]utm_campaign=[^&"'\s]*/g, '')
        .replace(/[?&]utm_term=[^&"'\s]*/g, '')
        .replace(/[?&]utm_content=[^&"'\s]*/g, '')
        .replace(/\?$/, '')   // remove trailing ?
        .replace(/&$/, '');   // remove trailing &
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
 * Extract base URL (without UTM) for display
 */
export function getBaseUrl(url: string): string {
  const match = url.match(/^[^?]*/);
  return match ? match[0] : url;
}
