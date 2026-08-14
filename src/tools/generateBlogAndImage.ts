/**
 * generateBlogAndImage.ts — manual CLI to run the ChatGPT blog + cover-image
 * generators and print the result as JSON (does not write to any sheet).
 * With --with-image, blog and image generate concurrently in two separate
 * Chrome windows (see blogGenAgent.ts / blogImageAgent.ts).
 *
 * Run with: node --import=tsx src/tools/generateBlogAndImage.ts \
 *   --title "India Cold Storage Market" \
 *   --url "https://www.kenresearch.com/industry-reports/india-cold-storage-market" \
 *   [--with-image] [--image-prompt 1|2]
 */

import 'dotenv/config';
import { generateBlogViaChatGpt } from '../agents/blogGenAgent.js';
import { generateBlogCoverImage } from '../agents/blogImageAgent.js';
import { runBlogSanityChecks } from '../agents/blogSanityAgent.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const title = arg('--title');
  const url = arg('--url');
  const withImage = process.argv.includes('--with-image');
  const imagePrompt = (arg('--image-prompt') === '2' ? '2' : '1') as '1' | '2';

  if (!title || !url) {
    console.error('Usage: node --import=tsx src/tools/generateBlogAndImage.ts --title "..." --url "..." [--with-image] [--image-prompt 1|2]');
    process.exit(1);
  }

  let coverImageUrl = '';
  let blog: { title: string; description: string; html: string };

  if (withImage) {
    console.log(`\n🖼️📝 Generating cover image + blog concurrently for: "${title}"...`);
    const [imgResult, blogResult] = await Promise.all([
      generateBlogCoverImage({ marketName: title, reportUrl: url, promptChoice: imagePrompt }).catch((e) => {
        console.log(`   ⚠️ Cover image failed: ${e.message}`);
        return '';
      }),
      generateBlogViaChatGpt({ title, url }),
    ]);
    coverImageUrl = imgResult;
    blog = blogResult;
  } else {
    console.log(`\n📝 Generating blog for: "${title}"...`);
    blog = await generateBlogViaChatGpt({ title, url });
  }

  const sanity = runBlogSanityChecks(blog.html, { title });
  if (sanity.changes.length > 0) {
    console.log(`\n   [BLOG SANITY] Applied: ${sanity.changes.join(', ')}`);
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({ ...blog, html: sanity.html, coverImageUrl }, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
