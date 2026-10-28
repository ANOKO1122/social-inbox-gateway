import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';

import { Pool } from 'pg';
import request from 'supertest';

import { createApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { buildEventKey } from '../events/event-key.js';
import {
  EventRepository,
  type StoreVerifiedWebhookInput,
} from '../events/event-repository.js';
import type { MetaWebhookPayload } from '../events/types.js';

const config = {
  port: 4010,
  host: '127.0.0.1',
  databaseUrl: 'postgresql://user:password@localhost:5432/social_inbox',
  metaVerifyToken: 'verify-token',
  metaAppSecret: 'integration-app-secret',
};

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', config.metaAppSecret).update(rawBody).digest('hex')}`;
}

function postSigned(app: ReturnType<typeof createApp>, rawBody: string) {
  // Always a string: superagent would JSON-serialise a Buffer under a JSON
  // content type and the signature would no longer match the sent bytes.
  return request(app)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(rawBody))
    .send(rawBody);
}

/** In-memory store implementing the same contract as EventRepository. */
class FakeEventStore {
  readonly calls: StoreVerifiedWebhookInput[] = [];
  private readonly rows = new Map<string, string>();

  async storeVerifiedWebhook(
    input: StoreVerifiedWebhookInput,
  ): Promise<{ rawInserted: boolean; normalizedInserted: number }> {
    this.calls.push(input);
    const existing = this.rows.get(input.eventKey);

    if (existing !== undefined) {
      return { rawInserted: false, normalizedInserted: 0 };
    }

    this.rows.set(input.eventKey, randomUUID());

    return { rawInserted: true, normalizedInserted: input.events.length };
  }

  get rowCount(): number {
    return this.rows.size;
  }
}

function silenceErrorLog(t: TestContext): string[] {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });

  return logged;
}

const pagePayload = {
  object: 'page',
  entry: [
    {
      id: 'page-1',
      messaging: [{ message: { mid: 'mid.1', text: 'hello' } }],
    },
  ],
};

describe('POST /webhooks/meta receive chain (fake store)', () => {
  it('stores a first delivery once and returns 200', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });

    const response = await postSigned(app, JSON.stringify(pagePayload));

    assert.equal(response.status, 200);
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0].platformObject, 'page');
    assert.equal(store.calls[0].eventKey, buildEventKey(pagePayload as MetaWebhookPayload));
    assert.deepEqual(store.calls[0].rawPayload, pagePayload);
  });

  it('returns 200 for a duplicate delivery without storing a second row', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const rawBody = JSON.stringify(pagePayload);

    const first = await postSigned(app, rawBody);
    const second = await postSigned(app, rawBody);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(store.calls.length, 2);
    assert.equal(store.rowCount, 1);
    assert.equal(store.calls[0].eventKey, store.calls[1].eventKey);
  });

  it('returns 401 for a bad signature before parsing and never stores', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });

    const response = await request(app)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
      .send('this is not json');

    assert.equal(response.status, 401);
    assert.equal(store.calls.length, 0);
  });

  it('returns 401 when the signature header is missing and never stores', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });

    const response = await request(app)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(pagePayload));

    assert.equal(response.status, 401);
    assert.equal(store.calls.length, 0);
  });

  it('returns 400 for a verified malformed JSON body and never stores', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });

    const response = await postSigned(app, '{"object":');

    assert.equal(response.status, 400);
    assert.equal(store.calls.length, 0);
  });

  for (const body of ['123', '[]', 'null']) {
    it(`returns 400 for a verified non-object payload ${body} and never stores`, async () => {
      const store = new FakeEventStore();
      const app = createApp({ config, eventStore: store });

      const response = await postSigned(app, body);

      assert.equal(response.status, 400);
      assert.equal(store.calls.length, 0);
    });
  }

  it('returns 413 with an empty body above 1mb and never stores', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });

    const response = await postSigned(app, 'a'.repeat(1024 * 1024 + 1));

    assert.equal(response.status, 413);
    assert.equal(response.text, '');
    assert.equal(store.calls.length, 0);
  });

  it('returns 400 for an absurdly deep (but valid) JSON object instead of failing with 500', async (t) => {
    silenceErrorLog(t);
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const depth = 100_000;
    const body = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;

    const response = await postSigned(app, body);

    assert.equal(response.status, 400);
    assert.equal(store.calls.length, 0);
  });

  it('accepts a payload nested within the depth limit and rejects one just beyond it', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const nested = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;

    const ok = await postSigned(app, nested(64));
    const tooDeep = await postSigned(app, nested(65));

    assert.equal(ok.status, 200);
    assert.equal(tooDeep.status, 400);
    assert.equal(store.calls.length, 1);
  });

  it('returns 500 without error details and keeps serving when the store throws', async (t) => {
    const logged = silenceErrorLog(t);
    let attempts = 0;
    const app = createApp({
      config,
      eventStore: {
        async storeVerifiedWebhook() {
          attempts += 1;
          throw Object.assign(
            new Error('connect ECONNREFUSED postgresql://user:hunter2@db/secret-detail'),
            { name: 'error', code: '08006', detail: 'hunter2', where: 'hunter2' },
          );
        },
      },
    });

    const response = await postSigned(app, JSON.stringify(pagePayload));

    assert.equal(response.status, 500);
    assert.doesNotMatch(response.text, /ECONNREFUSED|hunter2|secret-detail|at /);
    assert.equal(attempts, 1);

    // The process (and app) must keep serving after the failure.
    const health = await request(app).get('/health/live');
    assert.equal(health.status, 200);

    // Logs are whitelisted: stage, error type, SQLSTATE and event key only.
    const log = logged.join('\n');
    assert.match(log, /Failed to store Meta webhook/);
    assert.match(log, /error \(SQLSTATE 08006\)/);
    assert.match(log, new RegExp(buildEventKey(pagePayload as MetaWebhookPayload)));
    assert.doesNotMatch(log, /hunter2/);
    assert.doesNotMatch(log, /postgresql:\/\//);
    assert.doesNotMatch(log, /ECONNREFUSED|secret-detail/);
    assert.doesNotMatch(log, /\n\s+at /);
    assert.doesNotMatch(log, /hello|mid\.1|page-1/);
    assert.doesNotMatch(log, /sha256=/);
  });

  it('returns 500 when the repository cannot find the existing row after a conflict', async (t) => {
    silenceErrorLog(t);
    const emptyClient = {
      async query(): Promise<{ rows: Array<{ id: string }> }> {
        return { rows: [] };
      },
      async connect() {
        return {
          async query(): Promise<{ rows: Array<{ id: string }> }> {
            return { rows: [] };
          },
          release() {},
        };
      },
    };
    const repository = new EventRepository(emptyClient);
    const app = createApp({ config, eventStore: repository });

    const response = await postSigned(app, JSON.stringify(pagePayload));

    assert.equal(response.status, 500);
  });

  it('never answers 200 when persistence fails', async (t) => {
    silenceErrorLog(t);
    const app = createApp({
      config,
      eventStore: {
        async storeVerifiedWebhook() {
          throw new Error('disk full');
        },
      },
    });

    const response = await postSigned(app, JSON.stringify(pagePayload));

    assert.notEqual(response.status, 200);
  });

  it('strips NUL characters from stored strings and keys but builds the event key from the original payload', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [{ message: { mid: 'mid.\u0000nul', text: 'he\u0000llo', 'we\u0000ird': ['a\u0000b', 1] } }],
        },
      ],
    };
    const rawBody = JSON.stringify(payload);
    assert.match(rawBody, /\\u0000/);

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    assert.equal(store.calls.length, 1);
    assert.deepEqual(store.calls[0].rawPayload, {
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [{ message: { mid: 'mid.nul', text: 'hello', weird: ['ab', 1] } }],
        },
      ],
    });
    assert.equal(JSON.stringify(store.calls[0].rawPayload).includes('\\u0000'), false);

    const unsanitisedKey = buildEventKey(payload as MetaWebhookPayload);
    const sanitisedKey = buildEventKey(store.calls[0].rawPayload as MetaWebhookPayload);
    assert.notEqual(unsanitisedKey, sanitisedKey, 'fixture must make the two keys differ');
    assert.equal(store.calls[0].eventKey, unsanitisedKey);
  });

  it('replaces lone surrogates in the stored copy while the event key comes from the original payload', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const rawBody =
      '{"object":"page","entry":[{"messaging":[{"message":{"mid":"mid.s\\ud83d","text":"x\\ude00 \\ud83d\\ude00"}}]}]}';
    const original = JSON.parse(rawBody) as MetaWebhookPayload;

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    assert.deepEqual(store.calls[0].rawPayload, {
      object: 'page',
      entry: [{ messaging: [{ message: { mid: 'mid.s\ufffd', text: 'x\ufffd \u{1F600}' } }] }],
    });
    assert.equal(store.calls[0].eventKey, buildEventKey(original));
  });

  it('keeps retries of a NUL-bearing delivery idempotent', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const rawBody = JSON.stringify({
      object: 'page',
      entry: [{ messaging: [{ message: { mid: 'mid.\u0000x' } }] }],
    });

    await postSigned(app, rawBody);
    await postSigned(app, rawBody);

    assert.equal(store.rowCount, 1);
  });

  it('keeps an own "__proto__" key as plain data when cleaning NULs', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const rawBody = '{"object":"page","__proto__":{"polluted":"yes\\u0000"}}';

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    const stored = store.calls[0].rawPayload as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(stored), Object.prototype);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(JSON.stringify(stored), '{"object":"page","__proto__":{"polluted":"yes"}}');
  });

  it('stores a payload with an unknown object as platform_object "unknown"', async () => {
    const store = new FakeEventStore();
    const app = createApp({ config, eventStore: store });
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [] }] };

    const response = await postSigned(app, JSON.stringify(payload));

    assert.equal(response.status, 200);
    assert.equal(store.calls[0].platformObject, 'whatsapp_business_account');

    for (const body of ['{"entry":[]}', '{"object":""}', '{"object":42}', '{"object":null}', '{"object":"\\u0000"}']) {
      const other = await postSigned(app, body);
      assert.equal(other.status, 200);
      assert.equal(store.calls.at(-1)?.platformObject, 'unknown', body);
    }
  });

  it('requires an event store when creating the app', () => {
    assert.throws(
      // @ts-expect-error eventStore is deliberately a required dependency
      () => createApp({ config }),
      /eventStore/,
    );
  });

  it('passes one normalized Facebook comment from the fixture to the store', async () => {
    const rawBody = await readFile(new URL('../events/fixtures/facebook-comment.json', import.meta.url), 'utf8');
    const seen: StoreVerifiedWebhookInput[] = [];
    const app = createApp({
      config,
      eventStore: {
        async storeVerifiedWebhook(input) {
          seen.push(input);
          return { rawInserted: true, normalizedInserted: input.events.length };
        },
      },
    });

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].events.length, 1);
    assert.equal(seen[0].events[0].externalId, 'COMMENT_ID_1');
    assert.equal(seen[0].events[0].parentId, null);
    assert.equal(seen[0].events[0].text, 'Fake top-level comment');
  });

  it('stores an echo delivery with an empty normalized event list and returns 200', async () => {
    const rawBody = await readFile(
      new URL('../events/fixtures/facebook-message-echo.json', import.meta.url),
      'utf8',
    );
    const seen: StoreVerifiedWebhookInput[] = [];
    const app = createApp({
      config,
      eventStore: {
        async storeVerifiedWebhook(input) {
          seen.push(input);
          return { rawInserted: true, normalizedInserted: 0 };
        },
      },
    });

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].events, []);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = databaseUrl
  ? false
  : 'TEST_DATABASE_URL is not set; skipping PostgreSQL integration tests for the webhook receive chain';

describe('POST /webhooks/meta receive chain (PostgreSQL integration)', { skip: skipReason }, () => {
  // Throwaway schema so the suite never touches tables already in the database.
  const schema = `sig_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  before(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`CREATE SCHEMA ${schema}`);

    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      options: `-c search_path=${schema}`,
    });
    await runMigrations(pool);

    app = createApp({ config, eventStore: new EventRepository(pool) });
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

  it('persists exactly one row when the same signed request is posted twice', async () => {
    const rawBody = JSON.stringify(pagePayload);

    const first = await postSigned(app, rawBody);
    const second = await postSigned(app, rawBody);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const { rows } = await pool.query(
      'SELECT platform_object, event_key, raw_payload, status FROM webhook_events',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].platform_object, 'page');
    assert.equal(rows[0].event_key, buildEventKey(pagePayload as MetaWebhookPayload));
    assert.deepEqual(rows[0].raw_payload, pagePayload);
    assert.equal(rows[0].status, 'received');
  });

  it('persists exactly one row when the same signed request is delivered concurrently', async () => {
    const rawBody = JSON.stringify(pagePayload);
    const deliveries = 10;

    const responses = await Promise.all(
      Array.from({ length: deliveries }, () => postSigned(app, rawBody)),
    );

    assert.deepEqual(
      responses.map((response) => response.status),
      Array.from({ length: deliveries }, () => 200),
    );
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM webhook_events');
    assert.equal(rows[0].count, 1);
  });

  it('really stores a payload that contains NUL characters (cleaned) and dedupes its retry', async () => {
    const payload = {
      object: 'instagram',
      entry: [{ id: 'ig-1', messaging: [{ message: { mid: 'mid.\u0000ig', text: 'hi\u0000 there' } }] }],
    };
    const rawBody = JSON.stringify(payload);
    assert.match(rawBody, /\\u0000/);

    const first = await postSigned(app, rawBody);
    const retry = await postSigned(app, rawBody);

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);

    const { rows } = await pool.query('SELECT event_key, raw_payload FROM webhook_events');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_key, buildEventKey(payload as MetaWebhookPayload));
    assert.deepEqual(rows[0].raw_payload, {
      object: 'instagram',
      entry: [{ id: 'ig-1', messaging: [{ message: { mid: 'mid.ig', text: 'hi there' } }] }],
    });
  });

  describe('lone surrogates (rejected by jsonb) are cleaned and stored', () => {
    const body = (text: string): string =>
      `{"object":"page","entry":[{"id":"p","messaging":[{"message":{"mid":"mid.surrogate","text":"${text}"}}]}]}`;
    const storedText = async (): Promise<unknown> => {
      const { rows } = await pool.query('SELECT raw_payload FROM webhook_events');
      assert.equal(rows.length, 1);

      return rows[0].raw_payload.entry[0].messaging[0].message.text;
    };

    it('stores a lone high surrogate as U+FFFD', async () => {
      const response = await postSigned(app, body('a\\ud83d'));

      assert.equal(response.status, 200);
      assert.equal(await storedText(), 'a\ufffd');
    });

    it('stores a lone low surrogate as U+FFFD', async () => {
      const response = await postSigned(app, body('\\ude00a'));

      assert.equal(response.status, 200);
      assert.equal(await storedText(), '\ufffda');
    });

    it('stores a correctly paired emoji unchanged', async () => {
      const response = await postSigned(app, body('hi \\ud83d\\ude00'));

      assert.equal(response.status, 200);
      assert.equal(await storedText(), 'hi \u{1F600}');
    });

    it('stores a lone surrogate inside an object key', async () => {
      const raw = '{"object":"page","k\\ud83d":"v"}';

      const response = await postSigned(app, raw);

      assert.equal(response.status, 200);
      const { rows } = await pool.query('SELECT raw_payload FROM webhook_events');
      assert.deepEqual(rows[0].raw_payload, { object: 'page', 'k\ufffd': 'v' });
    });
  });

  it('returns 500 and stores nothing when the database fails', async (t) => {
    silenceErrorLog(t);
    const brokenPool = new Pool({ connectionString: databaseUrl, max: 1, options: '-c search_path=sig_missing_schema' });
    const brokenApp = createApp({ config, eventStore: new EventRepository(brokenPool) });

    try {
      const response = await postSigned(brokenApp, JSON.stringify(pagePayload));

      assert.equal(response.status, 500);
    } finally {
      await brokenPool.end();
    }

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM webhook_events');
    assert.equal(rows[0].count, 0);
  });

  it('persists one raw row and one normalized comment with the mapped columns', async () => {
    const rawBody = await readFile(new URL('../events/fixtures/facebook-comment.json', import.meta.url), 'utf8');

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    const raw = await pool.query('SELECT id FROM webhook_events');
    assert.equal(raw.rows.length, 1);

    const normalized = await pool.query(
      `SELECT webhook_event_id, platform, kind, channel_id, sender_id, external_id, parent_id, body, occurred_at
       FROM normalized_events`,
    );
    assert.equal(normalized.rows.length, 1);
    assert.equal(normalized.rows[0].webhook_event_id, raw.rows[0].id);
    assert.equal(normalized.rows[0].platform, 'facebook');
    assert.equal(normalized.rows[0].kind, 'comment');
    assert.equal(normalized.rows[0].channel_id, 'PAGE_ID_1');
    assert.equal(normalized.rows[0].sender_id, 'PSID_1');
    assert.equal(normalized.rows[0].external_id, 'COMMENT_ID_1');
    assert.equal(normalized.rows[0].parent_id, null);
    assert.equal(normalized.rows[0].body, 'Fake top-level comment');
    assert.equal(new Date(normalized.rows[0].occurred_at).toISOString(), '2025-10-09T08:53:21.000Z');
  });

  it('keeps one raw row and one normalized row when the same signed comment is posted twice', async () => {
    const rawBody = await readFile(new URL('../events/fixtures/facebook-comment.json', import.meta.url), 'utf8');

    const first = await postSigned(app, rawBody);
    const second = await postSigned(app, rawBody);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM webhook_events')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM normalized_events')).rows[0].count, 1);
  });

  it('keeps the first normalized row when the same comment arrives in a batch with a different event key', async () => {
    const rawBody = await readFile(new URL('../events/fixtures/facebook-comment.json', import.meta.url), 'utf8');
    const firstPayload = JSON.parse(rawBody) as MetaWebhookPayload;
    const secondPayload = JSON.parse(rawBody) as MetaWebhookPayload & {
      entry: Array<{ changes: unknown[] }>;
    };
    secondPayload.entry[0].changes.push({
      field: 'feed',
      value: {
        item: 'reaction',
        verb: 'add',
        comment_id: 'COMMENT_ID_1',
        from: { id: 'PSID_OTHER' },
      },
    });
    const secondBody = JSON.stringify(secondPayload);
    assert.notEqual(buildEventKey(firstPayload), buildEventKey(secondPayload));

    const first = await postSigned(app, rawBody);
    const second = await postSigned(app, secondBody);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const raw = await pool.query('SELECT id, event_key FROM webhook_events ORDER BY received_at, id');
    assert.equal(raw.rows.length, 2);
    const normalized = await pool.query('SELECT webhook_event_id FROM normalized_events');
    assert.equal(normalized.rows.length, 1);
    const firstRaw = raw.rows.find((row) => row.event_key === buildEventKey(firstPayload));
    assert.ok(firstRaw);
    assert.equal(normalized.rows[0].webhook_event_id, firstRaw.id);
  });

  it('stores a Facebook private message with kind message', async () => {
    const rawBody = await readFile(new URL('../events/fixtures/facebook-message.json', import.meta.url), 'utf8');

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    const { rows } = await pool.query('SELECT kind FROM normalized_events');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'message');
  });

  it('stores the raw echo payload and no normalized row', async () => {
    const rawBody = await readFile(new URL('../events/fixtures/facebook-message-echo.json', import.meta.url), 'utf8');

    const response = await postSigned(app, rawBody);

    assert.equal(response.status, 200);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM webhook_events')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM normalized_events')).rows[0].count, 0);
  });

  it('returns 200 when one request normalizes two events that share a business key', async () => {
    const payload = JSON.parse(
      await readFile(new URL('../events/fixtures/facebook-comment.json', import.meta.url), 'utf8'),
    ) as { entry: Array<{ changes: unknown[] }> };
    payload.entry[0].changes.push(structuredClone(payload.entry[0].changes[0]));

    const response = await postSigned(app, JSON.stringify(payload));

    assert.equal(response.status, 200);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM webhook_events')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM normalized_events')).rows[0].count, 1);
  });
});
