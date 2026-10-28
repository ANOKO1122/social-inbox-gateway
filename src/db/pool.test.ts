import assert from 'node:assert/strict';
import test from 'node:test';

import { createPool } from './pool.js';

test('pool error logging is whitelisted: no message, connection string or stack', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  const pool = createPool('postgresql://user:hunter2@127.0.0.1:1/never_connected');

  try {
    const error = Object.assign(new Error('terminating connection postgresql://user:hunter2@db/app'), {
      name: 'error',
      code: '57P01',
    });
    pool.emit('error', error, undefined as never);
  } finally {
    await pool.end();
  }

  const log = logged.join('\n');
  assert.match(log, /Unexpected PostgreSQL pool error/);
  assert.match(log, /error \(SQLSTATE 57P01\)/);
  assert.doesNotMatch(log, /hunter2/);
  assert.doesNotMatch(log, /postgresql:\/\//);
  assert.doesNotMatch(log, /terminating connection/);
  assert.doesNotMatch(log, /\n\s+at /);
});
