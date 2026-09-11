import { Page } from 'playwright';

export interface ArticlescadPostInput {
  title: string;
  body: string;          // HTML
  summary: string;
  categoryPrefix?: string;     // letters to type into category select (default "Bu")
  subcategoryPrefix?: string;  // letters to type into subcategory select (default "consu")
  keyword?: string;            // single keyword to type and Enter (default "Marketing")
}

export interface ArticlescadPostResult {
  success: boolean;
  url?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const STEP = 2500; // 2.5s between clicks

export async function postToArticlescad(page: Page, input: ArticlescadPostInput): Promise<ArticlescadPostResult> {
  try {
    const categoryPrefix    = input.categoryPrefix    || 'Bu';
    const subcategoryPrefix = input.subcategoryPrefix || 'consu';
    const keyword           = input.keyword           || 'Marketing';

    // 1. Dashboard
    console.log('   → Dashboard');
    await page.goto('https://articlescad.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(STEP);

    // 2. Submit New Article
    console.log('   → Submit New Article');
    await page.goto('https://articlescad.com/newarticle', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(STEP);

    // 3. Title
    console.log('   → Title');
    await page.click('#Title');
    await sleep(500);
    await page.fill('#Title', input.title);
    await sleep(STEP);

    // 4. Category — focus, type prefix, Enter
    console.log(`   → Category (${categoryPrefix})`);
    await page.click('#id');
    await sleep(500);
    await page.keyboard.type(categoryPrefix, { delay: 120 });
    await sleep(800);
    await page.keyboard.press('Enter');
    // Wait for ajax to repopulate subcategories
    await sleep(3000);

    // 5. Subcategory — focus, type prefix, Enter
    console.log(`   → Subcategory (${subcategoryPrefix})`);
    await page.click('#subcategories_id');
    await sleep(500);
    await page.keyboard.type(subcategoryPrefix, { delay: 120 });
    await sleep(800);
    await page.keyboard.press('Enter');
    await sleep(STEP);

    // 6. Summary
    console.log('   → Summary');
    await page.click('#summary');
    await sleep(500);
    await page.fill('#summary', input.summary);
    await sleep(STEP);

    // 7. Click Source button in CKEditor
    console.log('   → CKEditor Source');
    await page.click('a.cke_button__source');
    await sleep(STEP);

    // 8. Paste HTML body in source textarea
    console.log('   → Body HTML');
    const sourceArea = page.locator('textarea.cke_source').first();
    await sourceArea.click();
    await sleep(500);
    await sourceArea.fill(input.body);
    await sleep(STEP);

    // 9. Keywords — type and Enter
    console.log(`   → Keywords (${keyword})`);
    await page.click('#keywords');
    await sleep(500);
    await page.keyboard.type(keyword, { delay: 80 });
    await sleep(500);
    await page.keyboard.press('Enter');
    await sleep(STEP);

    // 10. Publish
    console.log('   → Publish');
    await page.click('button[name="btnUpdate"]');

    // 11. Wait for navigation and capture URL
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    } catch { /* ignore */ }
    await sleep(4000);

    const finalUrl = page.url();
    console.log(`   ✅ Published: ${finalUrl}`);
    return { success: true, url: finalUrl };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
