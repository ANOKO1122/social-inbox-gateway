import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { EventRepository, type Queryable } from './event-repository.js';
import type { NormalizedEvent } from './types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = databaseUrl
  ? false
  : 'TEST_DATABASE_URL is not set; skipping PostgreSQL integration tests for EventRepository';

describe('EventRepository (unit, injected Queryable)', () => {
  it('returns inserted=true with the new id when the insert returns a row', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db: Queryable = {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [{ id: 'new-id' }] };
      },
    };

    const result = await new EventRepository(db).insertRawEvent({
      platformObject: 'page',
      eventKey: 'key-1',
      rawPayload: { object: 'page', entry: [] },
    });

    assert.deepEqual(result, { inserted: true, id: 'new-id' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /ON CONFLICT \(event_key\) DO NOTHING/);
    assert.match(calls[0].text, /RETURNING id/);
    assert.deepEqual(calls[0].values, [
      'page',
      'key-1',
      JSON.stringify({ object: 'page', entry: [] }),
    ]);
  });

  it('looks up the existing id and returns inserted=false on conflict', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db: Queryable = {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: calls.length === 1 ? [] : [{ id: 'existing-id' }] };
      },
    };

    const result = await new EventRepository(db).insertRawEvent({
      platformObject: 'page',
      eventKey: 'key-1',
      rawPayload: {},
    });

    assert.deepEqual(result, { inserted: false, id: 'existing-id' });
    assert.equal(calls.length, 2);
    assert.match(calls[1].text, /SELECT id FROM webhook_events WHERE event_key = \$1/);
    assert.deepEqual(calls[1].values, ['key-1']);
  });

  it('throws when a conflict happened but the existing row cannot be found', async () => {
    const db: Queryable = {
      async query() {
        return { rows: [] };
      },
    };

    await assert.rejects(
      new EventRepository(db).insertRawEvent({
        platformObject: 'page',
        eventKey: 'key-1',
        rawPayload: {},
      }),
      /key-1/,
    );
  });

  it('serialises array payloads as JSON instead of a PostgreSQL array', async () => {
    let captured: unknown[] = [];
    const db: Queryable = {
      async query(_text, values) {
        captured = values;
        return { rows: [{ id: 'id-1' }] };
      },
    };

    await new EventRepository(db).insertRawEvent({
      platformObject: 'page',
      eventKey: 'key-1',
      rawPayload: [1, 2, 3],
    });

    assert.equal(captured[2], '[1,2,3]');
  });
});

const commentEvent: NormalizedEvent = {
  platform: 'facebook',
  kind: 'comment',
  channelId: 'PAGE_ID_1',
  senderId: 'PSID_1',
  externalId: 'COMMENT_ID_1',
  parentId: null,
  text: 'Fake top-level comment',
  occurredAt: '2025-10-09T08:53:21.000Z',
};

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

function queryLabel(text: string): string {
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
    return text;
  }

  if (text.includes('INSERT INTO webhook_events')) {
    return 'insert-raw';
  }

  if (text.includes('SELECT id FROM webhook_events')) {
    return 'select-raw';
  }

  if (text.includes('INSERT INTO normalized_events')) {
    return 'insert-normalized';
  }

  if (text.includes('INSERT INTO rule_runs')) {
    return 'enqueue-rules';
  }

  return text;
}

function recordingConnectable(options?: {
  onNormalized?: (index: number) => { rows: Array<{ id: string }> };
  rawInsertRows?: Array<{ id: string }>;
  failBegin?: boolean;
  failCommit?: boolean;
  failRollback?: boolean;
}) {
  const queries: RecordedQuery[] = [];
  const labels: string[] = [];
  let released = false;
  let releaseArgument: Error | boolean | undefined;
  const db = {
    async query(): Promise<{ rows: Array<{ id: string }> }> {
      throw new Error('pool.query must not be used by storeVerifiedWebhook');
    },
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          queries.push({ text, values });
          labels.push(queryLabel(text));

          if (text === 'BEGIN' && options?.failBegin) {
            throw new Error('begin failed');
          }

          if (text === 'COMMIT' && options?.failCommit) {
            throw new Error('commit failed');
          }

          if (text === 'ROLLBACK' && options?.failRollback) {
            throw new Error('rollback failed');
          }

          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [] };
          }

          if (text.includes('INSERT INTO webhook_events')) {
            return { rows: options?.rawInsertRows ?? [{ id: 'raw-id' }] };
          }

          if (text.includes('SELECT id FROM webhook_events')) {
            return { rows: [{ id: 'existing-raw-id' }] };
          }

          if (text.includes('INSERT INTO normalized_events')) {
            const index = queries.filter((query) => query.text.includes('INSERT INTO normalized_events')).length;

            if (options?.onNormalized) {
              return options.onNormalized(index);
            }

            return { rows: [{ id: `norm-${index}` }] };
          }

          return { rows: [] };
        },
        release(err?: Error | boolean) {
          released = true;
          releaseArgument = err;
          labels.push('release');
        },
      };
    },
  };

  return {
    db,
    queries,
    labels,
    wasReleased: () => released,
    releaseArgument: () => releaseArgument,
  };
}

describe('EventRepository.storeVerifiedWebhook (unit, injected client)', () => {
  const input = {
    platformObject: 'page',
    eventKey: 'key-1',
    rawPayload: { object: 'page', entry: [] },
    events: [commentEvent],
  };

  it('writes the raw row and each normalized row in one transaction, then commits and releases', async () => {
    const recorded = recordingConnectable();

    const result = await new EventRepository(recorded.db).storeVerifiedWebhook(input);

    assert.deepEqual(result, { rawInserted: true, normalizedInserted: 1 });
    assert.deepEqual(recorded.labels, ['BEGIN', 'insert-raw', 'insert-normalized', 'enqueue-rules', 'COMMIT', 'release']);
    assert.deepEqual(recorded.queries[1].values, [
      'page',
      'key-1',
      JSON.stringify({ object: 'page', entry: [] }),
    ]);
    assert.deepEqual(recorded.queries[2].values, [
      'raw-id',
      'facebook',
      'comment',
      'PAGE_ID_1',
      'PSID_1',
      'COMMENT_ID_1',
      null,
      'Fake top-level comment',
      '2025-10-09T08:53:21.000Z',
    ]);
    assert.deepEqual(recorded.queries[3].values, ['norm-1']);
  });

  it('inserts nothing normalized and still commits when the event list is empty', async () => {
    const recorded = recordingConnectable();

    const result = await new EventRepository(recorded.db).storeVerifiedWebhook({
      ...input,
      events: [],
    });

    assert.deepEqual(result, { rawInserted: true, normalizedInserted: 0 });
    assert.deepEqual(recorded.labels, ['BEGIN', 'insert-raw', 'COMMIT', 'release']);
  });

  it('uses ON CONFLICT DO NOTHING for the business key and counts only inserted rows', async () => {
    const recorded = recordingConnectable({
      onNormalized: (index) => ({ rows: index === 1 ? [{ id: 'norm-1' }] : [] }),
    });
    const duplicate = { ...commentEvent };

    const result = await new EventRepository(recorded.db).storeVerifiedWebhook({
      ...input,
      events: [commentEvent, duplicate],
    });

    assert.deepEqual(result, { rawInserted: true, normalizedInserted: 1 });
    const normalizedSql = recorded.queries
      .filter((query) => query.text.includes('INSERT INTO normalized_events'))
      .map((query) => query.text);
    assert.equal(normalizedSql.length, 2);
    assert.match(normalizedSql[0], /ON CONFLICT/);
    assert.match(normalizedSql[0], /DO NOTHING/);
    assert.deepEqual(recorded.labels, [
      'BEGIN',
      'insert-raw',
      'insert-normalized',
      'enqueue-rules',
      'insert-normalized',
      'COMMIT',
      'release',
    ]);
  });

  it('reuses the existing raw id after an event_key conflict and does not treat that as an error', async () => {
    const recorded = recordingConnectable({ rawInsertRows: [] });

    const result = await new EventRepository(recorded.db).storeVerifiedWebhook(input);

    assert.deepEqual(result, { rawInserted: false, normalizedInserted: 1 });
    assert.equal(recorded.queries[3].values?.[0], 'existing-raw-id');
    assert.deepEqual(recorded.labels, [
      'BEGIN',
      'insert-raw',
      'select-raw',
      'insert-normalized',
      'enqueue-rules',
      'COMMIT',
      'release',
    ]);
  });

  it('rolls back, skips commit, rethrows, and releases when a normalized insert fails', async () => {
    const recorded = recordingConnectable({
      onNormalized: () => {
        throw new Error('normalized insert failed');
      },
    });

    await assert.rejects(
      new EventRepository(recorded.db).storeVerifiedWebhook(input),
      /normalized insert failed/,
    );
    assert.equal(recorded.labels.includes('COMMIT'), false);
    assert.equal(recorded.labels.includes('ROLLBACK'), true);
    assert.equal(recorded.labels.at(-1), 'release');
    assert.equal(recorded.wasReleased(), true);
  });

  it('releases the client when BEGIN fails', async () => {
    const recorded = recordingConnectable({ failBegin: true });

    await assert.rejects(
      new EventRepository(recorded.db).storeVerifiedWebhook(input),
      /begin failed/,
    );
    assert.equal(recorded.wasReleased(), true);
    assert.equal(recorded.labels.includes('COMMIT'), false);
  });

  it('releases with the rollback error when ROLLBACK fails, and still throws the original error', async () => {
    const recorded = recordingConnectable({
      failRollback: true,
      onNormalized: () => {
        throw new Error('normalized insert failed');
      },
    });

    await assert.rejects(
      new EventRepository(recorded.db).storeVerifiedWebhook(input),
      /normalized insert failed/,
    );
    const releasedWith = recorded.releaseArgument();
    assert.ok(releasedWith instanceof Error);
    assert.equal(releasedWith.message, 'rollback failed');
  });

  it('rolls back and releases when COMMIT fails', async () => {
    const recorded = recordingConnectable({ failCommit: true });

    await assert.rejects(
      new EventRepository(recorded.db).storeVerifiedWebhook(input),
      /commit failed/,
    );
    assert.equal(recorded.labels.includes('ROLLBACK'), true);
    assert.equal(recorded.labels.at(-1), 'release');
  });
});

describe('EventRepository (PostgreSQL integration)', { skip: skipReason }, () => {
  // Everything runs inside a throwaway schema so this suite can never touch
  // tables that already exist in the target database.
  const schema = `sig_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let repository: EventRepository;

  before(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`CREATE SCHEMA ${schema}`);

    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      options: `-c search_path=${schema}`,
    });
    const migration = await readFile(
      new URL('../db/migrations/001_initial.sql', import.meta.url),
      'utf8',
    );
    await pool.query(migration);

    repository = new EventRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE webhook_events');
  });

  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('inserts a new event and reports inserted=true', async () => {
    const rawPayload = { object: 'page', entry: [{ id: 'p1', unknown_field: { nested: true } }] };

    const result = await repository.insertRawEvent({
      platformObject: 'page',
      eventKey: 'key-first',
      rawPayload,
    });

    assert.equal(result.inserted, true);
    assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const { rows } = await pool.query(
      'SELECT platform_object, event_key, raw_payload, status, received_at FROM webhook_events WHERE id = $1',
      [result.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].platform_object, 'page');
    assert.equal(rows[0].event_key, 'key-first');
    assert.deepEqual(rows[0].raw_payload, rawPayload);
    assert.equal(rows[0].status, 'received');
    assert.ok(rows[0].received_at instanceof Date);
  });

  it('returns inserted=false with the same id for a duplicate event_key and keeps one row', async () => {
    const first = await repository.insertRawEvent({
      platformObject: 'page',
      eventKey: 'key-dup',
      rawPayload: { attempt: 1 },
    });
    const second = await repository.insertRawEvent({
      platformObject: 'page',
      eventKey: 'key-dup',
      rawPayload: { attempt: 2 },
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.id, first.id);

    const { rows } = await pool.query('SELECT id, raw_payload FROM webhook_events');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, first.id);
    assert.deepEqual(rows[0].raw_payload, { attempt: 1 });
  });

  it('stores different event_keys as separate rows', async () => {
    const a = await repository.insertRawEvent({ platformObject: 'page', eventKey: 'key-a', rawPayload: {} });
    const b = await repository.insertRawEvent({ platformObject: 'page', eventKey: 'key-b', rawPayload: {} });

    assert.equal(a.inserted, true);
    assert.equal(b.inserted, true);
    assert.notEqual(a.id, b.id);

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM webhook_events');
    assert.equal(rows[0].count, 2);
  });

  it('is idempotent under concurrent inserts of the same event_key', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.insertRawEvent({ platformObject: 'page', eventKey: 'key-race', rawPayload: { n: 1 } }),
      ),
    );

    assert.equal(results.filter((result) => result.inserted).length, 1);
    assert.equal(new Set(results.map((result) => result.id)).size, 1);

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM webhook_events');
    assert.equal(rows[0].count, 1);
  });

  it('stores array payloads as JSONB', async () => {
    const result = await repository.insertRawEvent({
      platformObject: 'page',
      eventKey: 'key-array',
      rawPayload: [1, { a: 2 }],
    });

    const { rows } = await pool.query('SELECT raw_payload FROM webhook_events WHERE id = $1', [result.id]);
    assert.deepEqual(rows[0].raw_payload, [1, { a: 2 }]);
  });
});

describe('EventRepository.storeVerifiedWebhook (PostgreSQL integration)', { skip: skipReason }, () => {
  const schema = `sig_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let repository: EventRepository;

  before(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`CREATE SCHEMA ${schema}`);

    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      options: `-c search_path=${schema}`,
    });
    await runMigrations(pool);
    repository = new EventRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE webhook_events CASCADE');
  });

  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('rolls back the raw row when kind is outside the check constraint', async () => {
    await assert.rejects(
      repository.storeVerifiedWebhook({
        platformObject: 'page',
        eventKey: 'bad-kind',
        rawPayload: { object: 'page' },
        events: [{ ...commentEvent, kind: 'nope' as NormalizedEvent['kind'] }],
      }),
    );

    const raw = await pool.query('SELECT id FROM webhook_events WHERE event_key = $1', ['bad-kind']);
    assert.equal(raw.rows.length, 0);
    const normalized = await pool.query('SELECT count(*)::int AS count FROM normalized_events');
    assert.equal(normalized.rows[0].count, 0);
  });

  it('keeps one normalized row when concurrent calls share a business key but not an event key', async () => {
    const event = { ...commentEvent, externalId: 'SHARED_EXTERNAL' };
    const results = await Promise.all([
      repository.storeVerifiedWebhook({
        platformObject: 'page',
        eventKey: 'batch-a',
        rawPayload: { n: 'a' },
        events: [event],
      }),
      repository.storeVerifiedWebhook({
        platformObject: 'page',
        eventKey: 'batch-b',
        rawPayload: { n: 'b' },
        events: [event],
      }),
    ]);

    assert.equal(results.every((result) => result.rawInserted), true);
    assert.equal(results.reduce((sum, result) => sum + result.normalizedInserted, 0), 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM webhook_events')).rows[0].count, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM normalized_events')).rows[0].count, 1);
  });
});

interface ScriptedQuery {
  text: string;
  values?: unknown[];
}

function scriptedConnectable(
  onQuery: (text: string, values: unknown[] | undefined, queries: ScriptedQuery[]) => { rows: Array<Record<string, unknown>> },
) {
  const queries: ScriptedQuery[] = [];
  let released = false;
  const db = {
    async query(): Promise<{ rows: Array<{ id: string }> }> {
      throw new Error('pool.query must not be used inside claimReply or completeReply');
    },
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          queries.push({ text, values });
          return onQuery(text, values, queries);
        },
        release() {
          released = true;
        },
      };
    },
  };

  return { db, queries, wasReleased: () => released };
}

describe('EventRepository.claimReply (unit, injected client)', () => {
  it('commits a new pending row before returning and never calls Graph', async () => {
    const recorded = scriptedConnectable((text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO outbound_replies')) {
        return { rows: [{ id: 'reply-1' }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await new EventRepository(recorded.db).claimReply({
      normalizedEventId: 'event-1',
      idempotencyKey: 'idem-key-1',
    });

    assert.deepEqual(result, { outcome: 'claimed', replyId: 'reply-1' });
    assert.deepEqual(recorded.queries.map((query) => query.text === 'BEGIN' || query.text === 'COMMIT' || query.text === 'ROLLBACK'
      ? query.text
      : 'sql'), ['BEGIN', 'sql', 'COMMIT']);
    assert.equal(recorded.wasReleased(), true);
    assert.equal(recorded.queries.some((query) => /graph\.facebook\.com|Bearer|fetch/i.test(query.text)), false);
  });

  it('takes over a stale pending row only when it has no platform message id', async () => {
    const recorded = scriptedConnectable((text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO outbound_replies')) {
        return { rows: [] };
      }
      if (text.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 'reply-1',
            normalized_event_id: 'event-1',
            status: 'pending',
            platform_message_id: null,
            error_code: null,
            error_type: null,
          }],
        };
      }
      if (text.includes('UPDATE outbound_replies')) {
        return { rows: [{ id: 'reply-1' }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await new EventRepository(recorded.db).claimReply({
      normalizedEventId: 'event-1',
      idempotencyKey: 'idem-key-1',
    });

    assert.deepEqual(result, { outcome: 'claimed', replyId: 'reply-1' });
    const takeover = recorded.queries.find((query) => query.text.includes('UPDATE outbound_replies'));
    assert.ok(takeover);
    assert.match(takeover.text, /status = 'pending'/);
    assert.match(takeover.text, /platform_message_id IS NULL/);
    assert.match(takeover.text, /updated_at < now\(\) - interval '2 minutes'/);
    assert.equal(recorded.queries.at(-1)?.text, 'COMMIT');
  });

  it('marks a pending row sent when a platform message id was already stored', async () => {
    const recorded = scriptedConnectable((text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO outbound_replies')) {
        return { rows: [] };
      }
      if (text.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 'reply-1',
            normalized_event_id: 'event-1',
            status: 'pending',
            platform_message_id: 'mid-already',
            error_code: null,
            error_type: null,
          }],
        };
      }
      if (text.includes('UPDATE outbound_replies')) {
        return { rows: [{ id: 'reply-1' }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await new EventRepository(recorded.db).claimReply({
      normalizedEventId: 'event-1',
      idempotencyKey: 'idem-key-1',
    });

    assert.deepEqual(result, { outcome: 'sent', platformMessageId: 'mid-already' });
    const update = recorded.queries.find((query) => query.text.includes('UPDATE outbound_replies'));
    assert.ok(update);
    assert.match(update.text, /status = 'sent'/);
    assert.equal(update.text.includes('mid-already'), false);
  });

  it('does not write an unsafe error message when completing a failure', async () => {
    const recorded = scriptedConnectable((text) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('UPDATE outbound_replies')) {
        return { rows: [{ id: 'reply-1' }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    await new EventRepository(recorded.db).completeReply({
      replyId: 'reply-1',
      status: 'failed',
      errorCode: 'leaked message with spaces',
      errorType: 'Not A Type',
    });

    const update = recorded.queries.find((query) => query.text.includes('UPDATE outbound_replies'));
    assert.ok(update);
    assert.deepEqual(update.values, ['reply-1', 'failed', null, 'unspecified_error', null]);
    assert.equal(JSON.stringify(update.values).includes('leaked'), false);
    assert.equal(recorded.queries.at(-1)?.text, 'COMMIT');
    assert.equal(recorded.wasReleased(), true);
  });
});

describe('EventRepository outbound replies (PostgreSQL integration)', { skip: skipReason }, () => {
  const schema = `sig_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let repository: EventRepository;

  async function insertNormalizedEvent(): Promise<string> {
    const raw = await pool.query(
      `INSERT INTO webhook_events (platform_object, event_key, raw_payload)
       VALUES ('page', $1, '{}'::jsonb)
       RETURNING id`,
      [`raw-${randomUUID()}`],
    );
    const normalized = await pool.query(
      `INSERT INTO normalized_events (
         webhook_event_id, platform, kind, channel_id, sender_id, external_id, parent_id, body, occurred_at
       ) VALUES ($1, 'facebook', 'comment', 'PAGE_ID_1', 'PSID_1', $2, NULL, 'hello', '2025-10-09T08:53:21.000Z')
       RETURNING id`,
      [raw.rows[0].id, `ext-${randomUUID()}`],
    );
    return normalized.rows[0].id as string;
  }

  before(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      options: `-c search_path=${schema}`,
    });
    await runMigrations(pool);
    repository = new EventRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE webhook_events CASCADE');
  });

  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('claims a new idempotency key as pending', async () => {
    const eventId = await insertNormalizedEvent();

    const claim = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-first-1' });

    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') {
      return;
    }
    const row = await pool.query(
      'SELECT status, platform_message_id, normalized_event_id FROM outbound_replies WHERE id = $1',
      [claim.replyId],
    );
    assert.equal(row.rows[0].status, 'pending');
    assert.equal(row.rows[0].platform_message_id, null);
    assert.equal(row.rows[0].normalized_event_id, eventId);
  });

  it('replays a sent reply without inserting another row', async () => {
    const eventId = await insertNormalizedEvent();
    const claim = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-sent-1' });
    assert.ok(claim.outcome === 'claimed');

    await repository.completeReply({
      replyId: claim.replyId,
      status: 'sent',
      platformMessageId: 'mid-original',
    });
    const again = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-sent-1' });

    assert.deepEqual(again, { outcome: 'sent', platformMessageId: 'mid-original' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM outbound_replies')).rows[0].count, 1);
  });

  it('replays a failed reply with the original safe error code', async () => {
    const eventId = await insertNormalizedEvent();
    const claim = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-failed-1' });
    assert.ok(claim.outcome === 'claimed');

    await repository.completeReply({
      replyId: claim.replyId,
      status: 'failed',
      errorCode: '190',
      errorType: 'OAuthException',
    });
    const again = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-failed-1' });

    assert.deepEqual(again, { outcome: 'failed', errorCode: '190', errorType: 'OAuthException' });
  });

  it('returns in_progress when the same key is still pending inside two minutes', async () => {
    const eventId = await insertNormalizedEvent();
    const first = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-busy-1' });
    const second = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-busy-1' });

    assert.equal(first.outcome, 'claimed');
    assert.deepEqual(second, { outcome: 'in_progress' });
    await pool.query(
      `UPDATE outbound_replies SET updated_at = now() - interval '90 seconds' WHERE idempotency_key = 'claim-busy-1'`,
    );
    const stillBusy = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-busy-1' });
    assert.deepEqual(stillBusy, { outcome: 'in_progress' });
  });

  it('takes over a pending row older than two minutes when no platform message id exists', async () => {
    const eventId = await insertNormalizedEvent();
    const first = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-stale-1' });
    assert.ok(first.outcome === 'claimed');
    await pool.query(
      `UPDATE outbound_replies SET updated_at = now() - interval '3 minutes' WHERE id = $1`,
      [first.replyId],
    );

    const takeover = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-stale-1' });

    assert.deepEqual(takeover, { outcome: 'claimed', replyId: first.replyId });
    const fresh = await pool.query(
      `SELECT updated_at > now() - interval '1 minute' AS fresh, status, platform_message_id
       FROM outbound_replies WHERE id = $1`,
      [first.replyId],
    );
    assert.equal(fresh.rows[0].fresh, true);
    assert.equal(fresh.rows[0].status, 'pending');
    assert.equal(fresh.rows[0].platform_message_id, null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM outbound_replies')).rows[0].count, 1);

    const third = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-stale-1' });
    assert.deepEqual(third, { outcome: 'in_progress' });
  });

  it('marks a pending row with a platform message id as sent and returns that id', async () => {
    const eventId = await insertNormalizedEvent();
    const first = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-kept-1' });
    assert.ok(first.outcome === 'claimed');
    await pool.query(
      `UPDATE outbound_replies SET platform_message_id = 'mid-kept', updated_at = now() - interval '3 minutes' WHERE id = $1`,
      [first.replyId],
    );

    const result = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-kept-1' });

    assert.deepEqual(result, { outcome: 'sent', platformMessageId: 'mid-kept' });
    const row = await pool.query('SELECT status FROM outbound_replies WHERE id = $1', [first.replyId]);
    assert.equal(row.rows[0].status, 'sent');
  });

  it('stores a safe fallback instead of an unsafe Graph error message', async () => {
    const eventId = await insertNormalizedEvent();
    const claim = await repository.claimReply({ normalizedEventId: eventId, idempotencyKey: 'claim-unsafe-1' });
    assert.ok(claim.outcome === 'claimed');

    await repository.completeReply({
      replyId: claim.replyId,
      status: 'failed',
      errorCode: 'leaked message with spaces',
      errorType: 'Not A Type',
    });

    const row = await pool.query(
      'SELECT status, error_code, error_type, platform_message_id FROM outbound_replies WHERE id = $1',
      [claim.replyId],
    );
    assert.equal(row.rows[0].status, 'failed');
    assert.equal(row.rows[0].error_code, 'unspecified_error');
    assert.equal(row.rows[0].error_type, null);
    assert.equal(row.rows[0].platform_message_id, null);
    assert.equal(JSON.stringify(row.rows).includes('leaked'), false);
  });

  it('rejects the same idempotency key for a different normalized event', async () => {
    const eventA = await insertNormalizedEvent();
    const eventB = await insertNormalizedEvent();
    const claim = await repository.claimReply({ normalizedEventId: eventA, idempotencyKey: 'claim-cross-1' });
    assert.equal(claim.outcome, 'claimed');

    const other = await repository.claimReply({ normalizedEventId: eventB, idempotencyKey: 'claim-cross-1' });

    assert.deepEqual(other, { outcome: 'conflict' });
  });

  it('lets only one of several concurrent claims insert the pending row', async () => {
    const eventId = await insertNormalizedEvent();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.claimReply({
        normalizedEventId: eventId,
        idempotencyKey: 'claim-race-1',
      })),
    );

    assert.equal(results.filter((result) => result.outcome === 'claimed').length, 1);
    assert.equal(results.filter((result) => result.outcome === 'in_progress').length, 7);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM outbound_replies')).rows[0].count, 1);
  });

  it('rolls back the claim when the normalized event does not exist', async () => {
    await assert.rejects(
      repository.claimReply({ normalizedEventId: randomUUID(), idempotencyKey: 'claim-missing-1' }),
    );
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM outbound_replies')).rows[0].count, 0);
  });

  it('loads a normalized event by id and returns null when it is missing', async () => {
    const eventId = await insertNormalizedEvent();
    const stored = await pool.query('SELECT external_id FROM normalized_events WHERE id = $1', [eventId]);

    assert.deepEqual(await repository.findNormalizedEventById(eventId), {
      id: eventId,
      platform: 'facebook',
      kind: 'comment',
      channelId: 'PAGE_ID_1',
      senderId: 'PSID_1',
      externalId: stored.rows[0].external_id,
    });
    assert.equal(await repository.findNormalizedEventById(randomUUID()), null);
  });
});
