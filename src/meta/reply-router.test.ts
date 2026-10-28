import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../app.js';
import type { AppConfig } from '../config.js';
import type { ClaimReplyInput, ClaimReplyResult, CompleteReplyInput } from '../events/event-repository.js';
import type { GraphReplyClient, GraphReplyInput, GraphReplyResult } from './reply-client.js';

const INTERNAL_TOKEN = 'internal-token-value';
const PAGE_TOKEN = 'page-access-token-SECRET';
const IG_TOKEN = 'ig-access-token-SECRET';
const EVENT_ID = '11111111-1111-4111-8111-111111111111';

interface ReplyEventRecord {
  id: string;
  platform: 'facebook' | 'instagram';
  kind: 'comment' | 'message';
  channelId: string;
  senderId: string;
  externalId: string;
}

const facebookComment: ReplyEventRecord = {
  id: EVENT_ID,
  platform: 'facebook',
  kind: 'comment',
  channelId: 'PAGE_ID_1',
  senderId: 'PSID_1',
  externalId: 'COMMENT_ID_1',
};

interface HarnessOptions {
  internalApiToken?: string;
  channelTokens?: Record<string, string>;
  event?: ReplyEventRecord | null;
  claim?: (input: ClaimReplyInput) => Promise<ClaimReplyResult>;
  send?: (input: GraphReplyInput) => Promise<GraphReplyResult>;
  complete?: (input: CompleteReplyInput) => Promise<void>;
  channelTokenResolver?: { tokenForChannel(channelId: string): Promise<string | undefined> };
}

function harness(options: HarnessOptions = {}) {
  const lookups: string[] = [];
  const claims: ClaimReplyInput[] = [];
  const sends: GraphReplyInput[] = [];
  const completions: CompleteReplyInput[] = [];
  const order: string[] = [];
  const config: AppConfig = {
    port: 4010,
    host: '127.0.0.1',
    databaseUrl: 'postgresql://user:password@localhost:5432/social_inbox',
    metaVerifyToken: 'verify-token',
    metaAppSecret: 'app-secret',
    metaGraphVersion: 'v23.0',
    metaChannelTokens: options.channelTokens ?? {
      PAGE_ID_1: PAGE_TOKEN,
      IG_ACCOUNT_1: IG_TOKEN,
    },
    internalApiToken: options.internalApiToken,
  };
  const app = createApp({
    config,
    eventStore: {
      async storeVerifiedWebhook() {
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
    replyEvents: {
      async findNormalizedEventById(id: string) {
        lookups.push(id);
        return options.event === undefined ? facebookComment : options.event;
      },
    },
    channelTokenResolver: options.channelTokenResolver,
    replyStore: {
      async claimReply(input: ClaimReplyInput) {
        order.push('claim');
        claims.push(input);
        return options.claim
          ? options.claim(input)
          : { outcome: 'claimed', replyId: 'reply-1' };
      },
      async completeReply(input: CompleteReplyInput) {
        order.push('complete');
        completions.push(input);
        await options.complete?.(input);
      },
    },
    replyClient: {
      async send(input: GraphReplyInput) {
        order.push('send');
        sends.push(input);
        return options.send ? options.send(input) : { ok: true, platformMessageId: 'mid-1' };
      },
    } satisfies GraphReplyClient,
  });

  return { app, config, lookups, claims, sends, completions, order };
}

function postReply(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown> | string,
  token = INTERNAL_TOKEN,
) {
  const req = request(app)
    .post(`/api/events/${EVENT_ID}/replies`)
    .set('Content-Type', 'application/json');
  if (token) {
    req.set('Authorization', `Bearer ${token}`);
  }
  return req.send(body);
}

test('reply route is unauthorized when INTERNAL_API_TOKEN is unset, and the webhook still verifies', async () => {
  const { app, config, lookups, sends } = harness();

  const webhook = await request(app).get('/webhooks/meta').query({
    'hub.mode': 'subscribe',
    'hub.verify_token': config.metaVerifyToken,
    'hub.challenge': 'challenge-1',
  });
  assert.equal(webhook.status, 200);
  assert.equal(webhook.text, 'challenge-1');

  const reply = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' }, 'anything');
  assert.equal(reply.status, 401);
  assert.deepEqual(reply.body, { error: 'unauthorized' });
  assert.equal(JSON.stringify(reply.body).includes('anything'), false);
  assert.equal(lookups.length, 0);
  assert.equal(sends.length, 0);
});

test('rejects a wrong token of the same length and of a different length', async () => {
  const { app, sends } = harness({ internalApiToken: INTERNAL_TOKEN });

  const sameLength = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' }, 'internal-token-WRONG');
  assert.equal(sameLength.status, 401);
  assert.equal(JSON.stringify(sameLength.body).includes(INTERNAL_TOKEN), false);

  const otherLength = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' }, 'short');
  assert.equal(otherLength.status, 401);
  assert.equal(sends.length, 0);
});

test('returns 404 when the normalized event does not exist', async () => {
  const { app, sends, claims } = harness({ internalApiToken: INTERNAL_TOKEN, event: null });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'not_found' });
  assert.equal(sends.length, 0);
  assert.equal(claims.length, 0);
});

test('rejects an invalid idempotency key before looking up the event', async () => {
  const { app, lookups, sends } = harness({ internalApiToken: INTERNAL_TOKEN });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'short' });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'idempotency_key_invalid' });
  assert.equal(lookups.length, 0);
  assert.equal(sends.length, 0);
});

test('rejects blank or oversized text before claiming the key', async () => {
  const { app, claims, sends } = harness({ internalApiToken: INTERNAL_TOKEN });

  const blank = await postReply(app, { text: '   ', idempotencyKey: 'idem-key-1' });
  assert.equal(blank.status, 400);
  assert.deepEqual(blank.body, { error: 'text_invalid' });

  const oversized = await postReply(app, { text: 'a'.repeat(8001), idempotencyKey: 'idem-key-1' });
  assert.equal(oversized.status, 400);
  assert.deepEqual(oversized.body, { error: 'text_invalid' });
  assert.equal(claims.length, 0);
  assert.equal(sends.length, 0);
});

test('rejects an object id that must not be placed in a Graph path', async () => {
  const { app, claims, sends } = harness({
    internalApiToken: INTERNAL_TOKEN,
    event: { ...facebookComment, externalId: '../COMMENT' },
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'invalid_object_id' });
  assert.equal(claims.length, 0);
  assert.equal(sends.length, 0);
});

test('does not call Graph when the channel has no token', async () => {
  const { app, claims, sends } = harness({
    internalApiToken: INTERNAL_TOKEN,
    channelTokens: {},
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 422);
  assert.deepEqual(response.body, { error: 'missing_channel_token' });
  assert.equal(claims.length, 0);
  assert.equal(sends.length, 0);
});

test('uses the stored channel token when the environment map has no entry', async () => {
  let lookedUp = '';
  const { app, sends } = harness({
    internalApiToken: INTERNAL_TOKEN,
    channelTokens: {},
    channelTokenResolver: {
      async tokenForChannel(channelId) {
        lookedUp = channelId;
        return 'stored-page-token';
      },
    },
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 200);
  assert.equal(lookedUp, 'PAGE_ID_1');
  assert.equal(sends[0]?.accessToken, 'stored-page-token');
});

test('does not ask the store when the environment map already has the channel token', async () => {
  let lookups = 0;
  const { app, sends } = harness({
    internalApiToken: INTERNAL_TOKEN,
    channelTokenResolver: {
      async tokenForChannel() {
        lookups += 1;
        return 'stored-page-token';
      },
    },
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 200);
  assert.equal(lookups, 0);
  assert.equal(sends[0]?.accessToken, PAGE_TOKEN);
});

for (const [name, event, text, token] of [
  ['Facebook comment', facebookComment, 'thanks', PAGE_TOKEN],
  ['Facebook message', { ...facebookComment, kind: 'message', externalId: 'MID_1' }, 'dm', PAGE_TOKEN],
  ['Instagram comment', {
    ...facebookComment,
    platform: 'instagram',
    channelId: 'IG_ACCOUNT_1',
    senderId: 'IGSID_1',
    externalId: 'IG_COMMENT_1',
  }, 'ig thanks', IG_TOKEN],
  ['Instagram message', {
    ...facebookComment,
    platform: 'instagram',
    kind: 'message',
    channelId: 'IG_ACCOUNT_1',
    senderId: 'IGSID_1',
    externalId: 'IG_MID_1',
  }, 'ig dm', IG_TOKEN],
] as const) {
  test(`sends one ${name} using ids from the stored event`, async () => {
    const { app, sends, claims, completions, order } = harness({
      internalApiToken: INTERNAL_TOKEN,
      event,
    });

    const response = await postReply(app, {
      text,
      idempotencyKey: 'idem-key-1',
      channelId: 'BODY_CHANNEL',
      senderId: 'BODY_SENDER',
      externalId: 'BODY_EXTERNAL',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { platformMessageId: 'mid-1' });
    assert.equal(JSON.stringify(response.body).includes(token), false);
    assert.deepEqual(order, ['claim', 'send', 'complete']);
    assert.deepEqual(claims[0], { normalizedEventId: EVENT_ID, idempotencyKey: 'idem-key-1' });
    assert.deepEqual(sends[0], {
      platform: event.platform,
      kind: event.kind,
      channelId: event.channelId,
      senderId: event.senderId,
      externalId: event.externalId,
      text,
      accessToken: token,
    });
    assert.deepEqual(completions[0], {
      replyId: 'reply-1',
      status: 'sent',
      platformMessageId: 'mid-1',
    });
  });
}

test('replays a sent idempotency key without calling Graph', async () => {
  const { app, sends } = harness({
    internalApiToken: INTERNAL_TOKEN,
    claim: async () => ({ outcome: 'sent', platformMessageId: 'mid-old' }),
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { platformMessageId: 'mid-old' });
  assert.equal(sends.length, 0);
});

test('replays a failed idempotency key without calling Graph', async () => {
  const { app, sends } = harness({
    internalApiToken: INTERNAL_TOKEN,
    claim: async () => ({ outcome: 'failed', errorCode: '190', errorType: 'OAuthException' }),
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { error: '190', type: 'OAuthException' });
  assert.equal(sends.length, 0);
});

test('returns 409 while a reply with the same key is still pending', async () => {
  const { app, sends, completions } = harness({
    internalApiToken: INTERNAL_TOKEN,
    claim: async () => ({ outcome: 'in_progress' }),
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: 'reply_in_progress' });
  assert.equal(sends.length, 0);
  assert.equal(completions.length, 0);
});

test('stores a Graph failure without returning the Graph message or token', async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    const { app, completions } = harness({
      internalApiToken: INTERNAL_TOKEN,
      send: async () => ({ ok: false, code: '190', type: 'OAuthException' }),
    });

    const response = await postReply(app, { text: 'secret reply text', idempotencyKey: 'idem-key-1' });

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: '190', type: 'OAuthException' });
    assert.equal(JSON.stringify(response.body).includes(PAGE_TOKEN), false);
    assert.equal(JSON.stringify(response.body).includes('secret reply text'), false);
    assert.deepEqual(completions[0], {
      replyId: 'reply-1',
      status: 'failed',
      errorCode: '190',
      errorType: 'OAuthException',
    });
    const logged = logs.join('\n');
    assert.equal(logged.includes(PAGE_TOKEN), false);
    assert.equal(logged.includes('secret reply text'), false);
  } finally {
    console.error = original;
  }
});

test('returns 409 when the idempotency key belongs to another event', async () => {
  const { app, sends } = harness({
    internalApiToken: INTERNAL_TOKEN,
    claim: async () => ({ outcome: 'conflict' }),
  });

  const response = await postReply(app, { text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: 'idempotency_conflict' });
  assert.equal(sends.length, 0);
});

test('does not echo an invalid JSON body', async () => {
  const { app } = harness({ internalApiToken: INTERNAL_TOKEN });

  const response = await request(app)
    .post(`/api/events/${EVENT_ID}/replies`)
    .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
    .set('Content-Type', 'application/json')
    .send('{"text":"secret-fragment"');

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'invalid_json' });
  assert.equal(JSON.stringify(response.body).includes('secret-fragment'), false);
});

test('a signed webhook post still reaches the store when the reply token is unset', async () => {
  const stored: string[] = [];
  const app = createApp({
    config: {
      port: 4010,
      host: '127.0.0.1',
      databaseUrl: 'postgresql://user:password@localhost:5432/social_inbox',
      metaVerifyToken: 'verify-token',
      metaAppSecret: 'app-secret',
    },
    eventStore: {
      async storeVerifiedWebhook(input) {
        stored.push(input.eventKey);
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
  });
  const rawBody = JSON.stringify({ object: 'page', entry: [] });
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(rawBody).digest('hex')}`;

  const webhook = await request(app)
    .post('/webhooks/meta')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature)
    .send(rawBody);
  const reply = await request(app)
    .post(`/api/events/${EVENT_ID}/replies`)
    .set('Content-Type', 'application/json')
    .send({ text: 'hello', idempotencyKey: 'idem-key-1' });

  assert.equal(webhook.status, 200);
  assert.equal(stored.length, 1);
  assert.equal(reply.status, 401);
});
