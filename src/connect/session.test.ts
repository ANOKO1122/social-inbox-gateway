import assert from 'node:assert/strict';
import test from 'node:test';

import { openPayload, sealPayload, signingKey } from './session.js';

const key = signingKey(Buffer.alloc(32, 3));
const now = 1_700_000_000;

test('opens a session cookie before it expires', () => {
  const token = sealPayload(key, { kind: 'session', exp: now + 10 });

  assert.deepEqual(openPayload(key, token, now), { kind: 'session', exp: now + 10 });
});

test('rejects an expired, swapped, or tampered cookie', () => {
  const token = sealPayload(key, { kind: 'session', exp: now + 10 });

  assert.equal(openPayload(key, token, now + 10), undefined);
  assert.equal(openPayload(signingKey(Buffer.alloc(32, 4)), token, now), undefined);
  assert.equal(openPayload(key, `${token}x`, now), undefined);

  const state = sealPayload(key, { kind: 'state', exp: now + 10, nonce: 'nonce-value' });
  const opened = openPayload(key, state, now);
  assert.equal(opened?.kind, 'state');
  assert.notEqual(opened?.kind, 'session');
});
