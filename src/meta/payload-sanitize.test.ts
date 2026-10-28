import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exceedsMaxDepth, sanitizeForJsonb } from './payload-sanitize.js';

const HIGH = '\ud83d';
const LOW = '\ude00';
const GRIN = '\u{1F600}';

describe('sanitizeForJsonb', () => {
  it('removes NUL characters from string values and keys', () => {
    assert.deepEqual(sanitizeForJsonb({ 'k\u0000ey': ['a\u0000b', 1, null, true] }), {
      key: ['ab', 1, null, true],
    });
  });

  it('replaces a lone high surrogate with U+FFFD', () => {
    assert.equal(sanitizeForJsonb(`a${HIGH}b`), 'a\ufffdb');
    assert.equal(sanitizeForJsonb(`a${HIGH}`), 'a\ufffd');
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    assert.equal(sanitizeForJsonb(`${LOW}a`), '\ufffda');
    assert.equal(sanitizeForJsonb(`a${LOW}`), 'a\ufffd');
  });

  it('keeps a correctly paired surrogate (emoji) untouched', () => {
    assert.equal(sanitizeForJsonb(`hi ${GRIN}!`), `hi ${GRIN}!`);
    assert.equal(sanitizeForJsonb(`${HIGH}${LOW}`), GRIN);
  });

  it('only replaces the lone half when a pair is adjacent to a stray unit', () => {
    assert.equal(sanitizeForJsonb(`${HIGH}${HIGH}${LOW}`), `\ufffd${GRIN}`);
    assert.equal(sanitizeForJsonb(`${HIGH}${LOW}${LOW}`), `${GRIN}\ufffd`);
  });

  it('cleans lone surrogates in object keys as well as values', () => {
    assert.deepEqual(sanitizeForJsonb({ [`k${HIGH}`]: `v${LOW}`, [`ok${GRIN}`]: GRIN }), {
      'k\ufffd': 'v\ufffd',
      [`ok${GRIN}`]: GRIN,
    });
  });

  it('handles NUL and lone surrogates in the same string', () => {
    assert.equal(sanitizeForJsonb(`a\u0000${HIGH}b\u0000${LOW}${GRIN}`), `a\ufffdb\ufffd${GRIN}`);
  });

  it('cleans nested arrays and objects and leaves clean input equal', () => {
    const clean = { object: 'page', entry: [{ id: '1', n: 2, nested: { t: `x ${GRIN}` } }] };

    assert.deepEqual(sanitizeForJsonb(clean), clean);
    assert.deepEqual(sanitizeForJsonb({ a: [{ b: `z${HIGH}` }] }), { a: [{ b: 'z\ufffd' }] });
  });

  it('does not mutate its input', () => {
    const input = { [`k${HIGH}`]: [`v\u0000${LOW}`] };

    sanitizeForJsonb(input);

    assert.deepEqual(input, { [`k${HIGH}`]: [`v\u0000${LOW}`] });
  });
});

describe('exceedsMaxDepth', () => {
  it('accepts shallow values and rejects values nested beyond the limit', () => {
    assert.equal(exceedsMaxDepth({ a: [1, { b: 2 }] }), false);
    assert.equal(exceedsMaxDepth({ a: { b: { c: 1 } } }, 3), false);
    assert.equal(exceedsMaxDepth({ a: { b: { c: { d: 1 } } } }, 3), true);
  });
});
