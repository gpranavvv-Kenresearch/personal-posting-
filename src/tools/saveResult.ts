/**
 * saveResult.ts — CLI intervention tool for Claude
 *
 * Called by Claude CLI to write a post result (or skip/error) back to the sheet.
 * Uses the existing savePostingResult / saveUnifiedFbResult / saveUnifiedLinkedInResult from sheets.ts.
 *
 * Usage:
 *   npx tsx src/tools/saveResult.ts --row 42 --platform x --url "https://x.com/..." --status "Posted"
 *   npx tsx src/tools/saveResult.ts --row 42 --platform x --status "Skipped" --error "OTP required"
 *   npx tsx src/tools/saveResult.ts --row 42 --platform fb --status "Skipped" --error "CAPTCHA"
 *   npx tsx src/tools/saveResult.ts --row 42 --platform li --status "Skipped" --error "2FA required"
 *
 * Output:
 *   {"saved":true,"row":42,"platform":"x","status":"Posted"}
 *   {"saved":false,"error":"..."}
 */

import 'dotenv/config';
import {
  savePostingResult,
  saveUnifiedFbResult,
  saveUnifiedLinkedInResult,
} from '../sheets/sheets.js';

function out(data: object) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const rowStr   = get('--row');
  const platform = get('--platform')?.toLowerCase();
  const url      = get('--url') ?? '';
  const status   = get('--status') ?? 'Posted';
  const error    = get('--error') ?? '';

  if (!rowStr || !platform) {
    out({ saved: false, error: '--row and --platform are required' });
    process.exit(1);
  }

  const rowIndex = parseInt(rowStr, 10);
  if (isNaN(rowIndex)) {
    out({ saved: false, error: `Invalid row index: ${rowStr}` });
    process.exit(1);
  }

  try {
    if (platform === 'x' || platform === 'twitter') {
      await savePostingResult(
        { rowIndex },
        {
          xPostUrl: url,
          xStatus: status,
          xError: error || undefined,
        }
      );
    } else if (platform === 'fb' || platform === 'facebook') {
      await saveUnifiedFbResult(
        { rowIndex } as any,
        {
          post: '',
          postUrl: url,
          status,
          error: error || undefined,
        }
      );
    } else if (platform === 'li' || platform === 'linkedin') {
      await saveUnifiedLinkedInResult(
        { rowIndex } as any,
        {
          post: '',
          postUrl: url,
          status,
          error: error || undefined,
        }
      );
    } else {
      out({ saved: false, error: `Unknown platform: ${platform}. Use: x, fb, li` });
      process.exit(1);
    }

    out({ saved: true, row: rowIndex, platform, status });
  } catch (err: any) {
    out({ saved: false, error: err.message });
  }
}

main();
