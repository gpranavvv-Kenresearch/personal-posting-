/**
 * Regression tests for defects that only appear at module boundaries.
 *
 * Each of these was found by adversarial verification rather than by a failing
 * test, and each was silent: the code did something wrong without erroring.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { paragraphsOf, insertLink } from '../../src/intelligence/interlink/apply.js';
import { isCodeBlock, splitParagraphs } from '../../src/intelligence/interlink/propose.js';
import { parseComponents } from '../../src/intelligence/calibration.js';

const FENCED = [
  'Intro text about markets.',
  '',
  '```js',
  'const marketSize = 1;',
  '',                       // <- the blank line that used to tear the fence
  'const growth = 2;',
  '```',
  '',
  'Closing text.',
].join('\n');

describe('a fenced code block containing a blank line', () => {
  test('apply.paragraphsOf keeps the fence whole', () => {
    const ps = paragraphsOf(FENCED);
    assert.equal(ps.length, 3, 'intro, the whole fence, closing');
    const fence = ps.find(p => p.includes('growth'))!;
    assert.ok(fence.includes('```js'), 'the fragment must still carry its opening marker');
  });

  test('the fence is recognised as code, so insertion is refused', () => {
    const fence = paragraphsOf(FENCED).find(p => p.includes('growth'))!;
    assert.equal(isCodeBlock(fence), true);
    assert.equal(
      insertLink(fence, 'growth', 'https://kenresearch.com/x'), null,
      'a link must never be inserted into published source code',
    );
  });

  test('propose.splitParagraphs agrees with apply.paragraphsOf', () => {
    // The two splitters MUST agree, or a paragraph hash taken at proposal time
    // can never match at apply time.
    assert.equal(splitParagraphs(FENCED).length, paragraphsOf(FENCED).length);
  });

  test('tilde fences are handled too', () => {
    const doc = ['Text.', '', '~~~', 'a = 1', '', 'b = 2', '~~~', '', 'End.'].join('\n');
    assert.equal(paragraphsOf(doc).length, 3);
  });

  test('an unterminated fence does not swallow the rest of the document silently', () => {
    const doc = ['Text.', '', '```', 'a = 1', '', 'b = 2'].join('\n');
    const ps = paragraphsOf(doc);
    assert.ok(ps.length >= 2, 'the prose before the fence is still its own paragraph');
    assert.equal(isCodeBlock(ps[ps.length - 1]), true, 'the unterminated remainder is still code');
  });

  test('ordinary prose is unaffected', () => {
    assert.equal(paragraphsOf('Para one.\n\nPara two.\n\nPara three.').length, 3);
    assert.equal(splitParagraphs('Para one.\n\nPara two.').length, 2);
  });
});

describe('calibration recencyMultiplier: absent is not the same as zero', () => {
  const read = (obj: any) => parseComponents(JSON.stringify(obj)).recencyMultiplier;

  test('an explicit 0 survives the round trip', () => {
    // A score fully suppressed by recency is legitimate. Reading it back as 1
    // inflates the score above what was recorded and corrupts the correlation.
    assert.equal(read({ components: [], recencyMultiplier: 0 }), 0);
  });

  test('ordinary values survive', () => {
    assert.equal(read({ components: [], recencyMultiplier: 0.5 }), 0.5);
    assert.equal(read({ components: [], recencyMultiplier: 1 }), 1);
  });

  test('absent means unknown, which is 1 — not 0', () => {
    assert.equal(read({ components: [] }), 1);
  });

  test('NaN becomes null in JSON and must read as unknown, not as zero', () => {
    // Number(null) is 0, so a naive coercion turns "no information" into
    // "fully suppressed".
    assert.equal(read({ components: [], recencyMultiplier: NaN }), 1);
  });

  test('an impossible negative reads as unknown, not as zero', () => {
    assert.equal(read({ components: [], recencyMultiplier: -1 }), 1);
  });
});
