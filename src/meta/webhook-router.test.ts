import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../app.js';

const config = {
  port: 4010,
  host: '127.0.0.1',
  databaseUrl: 'postgresql://user:password@localhost:5432/social_inbox',
  metaVerifyToken: 'verify-token',
  metaAppSecret: 'test-app-secret',
};

const noopStore = {
  async storeVerifiedWebhook() {
    return { rawInserted: true, normalizedInserted: 0 };
  },
};

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', config.metaAppSecret).update(rawBody).digest('hex')}`;
}

test('GET /webhooks/meta returns the original challenge for a valid subscription', async () => {
  const app = createApp({ config, eventStore: noopStore });

  const response = await request(app).get('/webhooks/meta').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': config.metaVerifyToken,
    'hub.challenge': '0012345',
  });

  assert.equal(response.status, 200);
  assert.equal(response.text, '0012345');
});

test('GET /webhooks/meta returns 403 when the verify token is wrong', async () => {
  const app = createApp({ config, eventStore: noopStore });

  const response = await request(app).get('/webhooks/meta').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong-token',
    'hub.challenge': 'challenge',
  });

  assert.equal(response.status, 403);
});

test('GET /webhooks/meta returns 403 when mode is not subscribe', async () => {
  const app = createApp({ config, eventStore: noopStore });

  const response = await request(app).get('/webhooks/meta').query({
    'hub.mode': 'unsubscribe',
    'hub.verify_token': config.metaVerifyToken,
    'hub.challenge': 'challenge',
  });

  assert.equal(response.status, 403);
});

test('POST /webhooks/meta returns 401 when the signature is missing', async () => {
  const app = createApp({ config, eventStore: noopStore });

  const response = await request(app)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .send('{"object":"page"}');

  assert.equal(response.status, 401);
});

test('POST /webhooks/meta returns 401 for a bad signature before parsing JSON', async () => {
  const app = createApp({ config, eventStore: noopStore });
  const malformedBody = '{"object":';

  const response = await request(app)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
    .send(malformedBody);

  assert.equal(response.status, 401);
});

test('POST /webhooks/meta passes verified JSON to the injected event store', async () => {
  const rawBody = '{"object":"page","entry":[]}';
  let handledPayload: unknown;
  const app = createApp({
    config,
    eventStore: {
      async storeVerifiedWebhook(input) {
        handledPayload = input.rawPayload;
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
  });

  const response = await request(app)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(rawBody))
    .send(rawBody);

  assert.equal(response.status, 200);
  assert.deepEqual(handledPayload, { object: 'page', entry: [] });
});

test('POST /webhooks/meta returns 400 for verified malformed JSON', async () => {
  const app = createApp({ config, eventStore: noopStore });
  const malformedBody = '{"object":';

  const response = await request(app)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(malformedBody))
    .send(malformedBody);

  assert.equal(response.status, 400);
});

function postSigned(app: ReturnType<typeof createApp>, body: string) {
  // Always a string: superagent would JSON-serialise a Buffer under a JSON
  // content type and the signature would no longer match the sent bytes.
  const signature = sign(body);

  return request(app)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature)
    .send(body);
}

test('POST /webhooks/meta returns 500 without leaking details when the event store throws', async (t) => {
  const errorLog = t.mock.method(console, 'error', () => undefined);
  const app = createApp({
    config,
    eventStore: {
      async storeVerifiedWebhook() {
        throw new Error('db exploded: secret-internal-detail');
      },
    },
  });

  const response = await postSigned(app, '{"object":"page"}');

  assert.equal(response.status, 500);
  assert.equal(response.text, 'Internal Server Error');
  assert.doesNotMatch(response.text, /secret-internal-detail/);
  assert.equal(errorLog.mock.callCount() > 0, true);
});

test('POST /webhooks/meta returns 500 when the event store throws synchronously', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const app = createApp({
    config,
    eventStore: {
      storeVerifiedWebhook() {
        throw new Error('sync failure');
      },
    },
  });

  const response = await postSigned(app, '{"object":"page"}');

  assert.equal(response.status, 500);
});

test('POST /webhooks/meta returns 413 with an empty body above 1mb and does not call the event store', async () => {
  let calls = 0;
  const app = createApp({
    config,
    eventStore: {
      async storeVerifiedWebhook() {
        calls += 1;
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
  });

  const response = await postSigned(app, 'a'.repeat(1024 * 1024 + 1));

  assert.equal(response.status, 413);
  assert.equal(response.text, '');
  assert.doesNotMatch(String(response.headers['content-type'] ?? ''), /html/);
  assert.equal(calls, 0);
});

test('POST /webhooks/meta accepts a body of exactly 1mb', async () => {
  let calls = 0;
  const app = createApp({
    config,
    eventStore: {
      async storeVerifiedWebhook() {
        calls += 1;
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
  });
  const prefix = '{"object":"page","pad":"';
  const suffix = '"}';
  const padding = 'a'.repeat(1024 * 1024 - prefix.length - suffix.length);
  const body = `${prefix}${padding}${suffix}`;
  assert.equal(Buffer.byteLength(body), 1024 * 1024);

  const response = await postSigned(app, body);

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

for (const [label, body] of [
  ['a number', '123'],
  ['an array', '[]'],
  ['null', 'null'],
  ['a string', '"text"'],
  ['a boolean', 'true'],
] as const) {
  test(`POST /webhooks/meta returns 400 for a verified payload that is ${label}`, async () => {
    let calls = 0;
    const app = createApp({
      config,
      eventStore: {
        async storeVerifiedWebhook() {
          calls += 1;
          return { rawInserted: true, normalizedInserted: 0 };
        },
      },
    });

    const response = await postSigned(app, body);

    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  });
}
