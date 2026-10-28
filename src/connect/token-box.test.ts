import assert from 'node:assert/strict';
import test from 'node:test';

import { decryptToken, encryptToken } from './token-box.js';

const key = Buffer.alloc(32, 9);

test('round-trips a token and uses a fresh iv each time', () => {
  const first = encryptToken(key, 'page-token-value');
  const second = encryptToken(key, 'page-token-value');

  assert.notEqual(first, second);
  assert.equal(first.includes('page-token-value'), false);
  assert.equal(decryptToken(key, first), 'page-token-value');
  assert.equal(decryptToken(key, second), 'page-token-value');
});

test('rejects a tampered ciphertext', () => {
  const stored = encryptToken(key, 'page-token-value');
  const parts = stored.split('.');
  const flipped = Buffer.from(parts[3], 'base64url');
  flipped[0] ^= 0xff;
  parts[3] = flipped.toString('base64url');

  assert.throws(() => decryptToken(key, parts.join('.')), /token box/);
});

test('rejects a different key', () => {
  const stored = encryptToken(key, 'page-token-value');

  assert.throws(() => decryptToken(Buffer.alloc(32, 8), stored), /token box/);
});
