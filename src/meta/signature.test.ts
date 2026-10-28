import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyMetaSignature } from './signature.js';

const appSecret = 'test-app-secret';
const rawBody = Buffer.from('{"object":"page"}');

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}

test('accepts a valid sha256 signature', () => {
  assert.equal(verifyMetaSignature(rawBody, sign(rawBody), appSecret), true);
});

test('rejects an incorrect signature', () => {
  const signedDifferentBody = sign(Buffer.from('{"object":"instagram"}'));

  assert.equal(verifyMetaSignature(rawBody, signedDifferentBody, appSecret), false);
});

test('rejects a missing signature', () => {
  assert.equal(verifyMetaSignature(rawBody, undefined, appSecret), false);
});

test('rejects a signature with a different digest length without throwing', () => {
  assert.doesNotThrow(() => {
    assert.equal(verifyMetaSignature(rawBody, 'sha256=00', appSecret), false);
  });
});

test('rejects signatures outside the sha256 hex format', () => {
  assert.equal(verifyMetaSignature(rawBody, sign(rawBody).toUpperCase(), appSecret), false);
  assert.equal(verifyMetaSignature(rawBody, `sha1=${'0'.repeat(40)}`, appSecret), false);
  assert.equal(verifyMetaSignature(rawBody, `sha256=${'g'.repeat(64)}`, appSecret), false);
});
