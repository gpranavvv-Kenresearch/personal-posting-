/**
 * generateBlogAndImage.ts — manual CLI to run the ChatGPT blog + cover-image
 * generators and print the result as JSON (does not write to any sheet).
 * With --with-image, blog and image generate concurrently in two separate
 * Chrome windows (see blogGenAgent.ts / blogImageAgent.ts).
 *
 * Run with: node --import=tsx src/tools/generateBlogAndImage.ts \
 *   --title "India Cold Storage Market" \
 *   --url "https://www.kenresearch.com/industry-reports/india-cold-storage-market" \
 *   [--with-image] [--image-prompt 1|2] [--v2]
 *
 * --v2 uses buildMasterBlogPromptV2 (keyword-focused H2 headings, e.g.
 * "UK Zipper Market") instead of the default prompt — see blogGenAgent.ts.
 */

import 'dotenv/config';
import { generateBlogViaChatGpt } from '../agents/blogGenAgent.js';
import { generateBlogCoverImage } from '../agents/blogImageAgent.js';
import { runBlogSanityChecks } from '../agents/blogSanityAgent.js';
import { validateBrandAuthority } from '../agents/blogBrandValidator.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const title = arg('--title');
  const url = arg('--url');
  const withImage = process.argv.includes('--with-image');
  const imagePrompt = (arg('--image-prompt') === '2' ? '2' : '1') as '1' | '2';
  const promptVersion = process.argv.includes('--v2') ? 'v2' : 'v1';

  if (!title || !url) {
    console.error('Usage: node --import=tsx src/tools/generateBlogAndImage.ts --title "..." --url "..." [--with-image] [--image-prompt 1|2] [--v2]');
    process.exit(1);
  }

  let coverImageUrl = '';
  let blog: { title: string; description: string; html: string };

  if (withImage) {
    console.log(`\n🖼️📝 Generating cover image + blog (${promptVersion}) concurrently for: "${title}"...`);
    const [imgResult, blogResult] = await Promise.all([
      generateBlogCoverImage({ marketName: title, reportUrl: url, promptChoice: imagePrompt }).catch((e) => {
        console.log(`   ⚠️ Cover image failed: ${e.message}`);
        return '';
      }),
      generateBlogViaChatGpt({ title, url, promptVersion }),
    ]);
    coverImageUrl = imgResult;
    blog = blogResult;
  } else {
    console.log(`\n📝 Generating blog (${promptVersion}) for: "${title}"...`);
    blog = await generateBlogViaChatGpt({ title, url, promptVersion });
  }

  const sanity = runBlogSanityChecks(blog.html, { title });
  if (sanity.changes.length > 0) {
    console.log(`\n   [BLOG SANITY] Applied: ${sanity.changes.join(', ')}`);
  }

  const brandCheck = validateBrandAuthority(sanity.html, { title: blog.title || title });
  console.log(`\n   [BRAND CHECK] ${brandCheck.status} (score ${brandCheck.score}/10)`);
  if (brandCheck.issues.length > 0) {
    console.log(JSON.stringify({ status: brandCheck.status, issues: brandCheck.issues }, null, 2));
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({ ...blog, html: sanity.html, coverImageUrl }, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
