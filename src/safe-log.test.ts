import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeError, logSafeError } from './safe-log.js';

class DatabaseError extends Error {
  code?: string;
  detail?: string;
  where?: string;

  constructor(message: string) {
    super(message);
    this.name = 'error';
  }
}

describe('describeError', () => {
  it('reports only the error name and a valid SQLSTATE code', () => {
    const error = new DatabaseError('connect failed postgresql://user:hunter2@db/app');
    error.code = '23505';
    error.detail = 'Key (event_key)=(secret) already exists';
    error.where = 'SQL statement with hunter2';

    const text = describeError(error);

    assert.equal(text, 'error (SQLSTATE 23505)');
    assert.doesNotMatch(text, /hunter2|postgresql:\/\/|secret|connect failed/);
  });

  it('omits the code when it is not a 5-character alphanumeric SQLSTATE', () => {
    for (const code of ['ECONNREFUSED', '1234', '1234!', 'abc de', 42, undefined, '23505\nforged']) {
      const error = new DatabaseError('boom');
      (error as { code?: unknown }).code = code;

      assert.equal(describeError(error), 'error', String(code));
    }
  });

  it('accepts alphanumeric SQLSTATE codes such as 22P05', () => {
    const error = new DatabaseError('x');
    error.code = '22P05';

    assert.equal(describeError(error), 'error (SQLSTATE 22P05)');
  });

  it('falls back to UnknownError for names that are not safe identifiers', () => {
    for (const name of ['has space', 'postgresql://user:hunter2@db', 'a\nb', '', 'x'.repeat(65), '名前']) {
      const error = new Error('boom');
      error.name = name;

      assert.equal(describeError(error), 'UnknownError', JSON.stringify(name));
    }

    const longButAllowed = new Error('boom');
    longButAllowed.name = 'x'.repeat(64);
    assert.equal(describeError(longButAllowed), 'x'.repeat(64));
  });

  it('uses UnknownError for non-Error values and never stringifies them', () => {
    assert.equal(describeError('postgresql://user:hunter2@db'), 'UnknownError');
    assert.equal(describeError({ name: 'Fake', code: '23505', message: 'hunter2' }), 'UnknownError');
    assert.equal(describeError(null), 'UnknownError');
    assert.equal(describeError(undefined), 'UnknownError');
  });

  it('keeps the name of Error subclasses', () => {
    assert.equal(describeError(new TypeError('hunter2')), 'TypeError');
  });
});

describe('logSafeError', () => {
  it('writes the stage, error type, SQLSTATE and event key, never the message or stack', (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const error = new DatabaseError('connect postgresql://user:hunter2@db/secret-db failed');
    error.code = '08006';

    logSafeError('Failed to store Meta webhook', error, 'abc123');

    assert.equal(logged.length, 1);
    assert.equal(logged[0], 'Failed to store Meta webhook (event_key abc123): error (SQLSTATE 08006)');
    assert.doesNotMatch(logged[0], /hunter2|postgresql:\/\/|secret-db|\n\s+at /);
  });

  it('omits the event key when none is known', (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    logSafeError('Unexpected PostgreSQL pool error', new Error('x'));

    assert.deepEqual(logged, ['Unexpected PostgreSQL pool error: Error']);
  });
});
