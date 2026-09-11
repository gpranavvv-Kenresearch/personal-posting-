/**
 * Plain-text cleanup for social platforms that do not render markdown.
 */
export function stripMarkdownBold(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/gs, '$1')
    .replace(/\*\*/g, '');
}

export function preparePlainSocialPost(text: string): string {
  return stripMarkdownBold(text).trim();
}
