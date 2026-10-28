import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelRepository, type ChannelDb } from './channel-repository.js';
import type { SaveAuthorization } from './connect-flow.js';
import { PAGE_SUBSCRIBED_FIELDS } from './oauth-client.js';
import { decryptToken } from './token-box.js';

const key = Buffer.alloc(32, 6);

function authorization(): SaveAuthorization {
  return {
    facebookUserId: '800000000000001',
    userToken: 'long-user-token-0123456789',
    userTokenExpiresAt: new Date('2026-12-13T07:00:00.000Z'),
    scopes: ['pages_show_list', 'pages_manage_metadata'],
    channels: [
      {
        kind: 'facebook_page',
        externalId: '8000000000000002',
        name: 'Example Page',
        pageId: '8000000000000002',
        accessToken: 'page-token-value-0123456789',
        subscribed: true,
        subscriptionError: null,
      },
      {
        kind: 'instagram',
        externalId: '80000000000000009',
        name: 'example_page',
        pageId: '8000000000000002',
        accessToken: 'page-token-value-0123456789',
        subscribed: false,
        subscriptionError: 'graph_200',
      },
    ],
  };
}

test('stores ciphertext and can read the page token back by channel id', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let pageToken = '';
  const db: ChannelDb = {
    async query(text, values) {
      queries.push({ text, values });
      return {
        rows: [{ encrypted_access_token: pageToken }],
      };
    },
    async connect() {
      return {
        async query(text, values) {
          queries.push({ text, values });
          if (text.includes('INSERT INTO meta_user_grants')) {
            return { rows: [{ id: 'grant-1' }] };
          }
          if (text.includes('INSERT INTO meta_channels') && pageToken === '') {
            pageToken = String(values?.[5]);
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const repository = new ChannelRepository(db, key);
  await repository.save(authorization());

  const userInsert = queries.find((query) => query.text.includes('INSERT INTO meta_user_grants'));
  assert.ok(userInsert);
  assert.equal(userInsert.values?.[1] === 'long-user-token-0123456789', false);
  assert.equal(decryptToken(key, String(userInsert.values?.[1])), 'long-user-token-0123456789');

  const channelInsert = queries.find((query) => query.text.includes('INSERT INTO meta_channels'));
  assert.ok(channelInsert);
  assert.equal(decryptToken(key, String(channelInsert.values?.[5])), 'page-token-value-0123456789');
  assert.equal(String(channelInsert.values).includes('page-token-value-0123456789'), false);

  assert.equal(await repository.tokenForChannel('8000000000000002'), 'page-token-value-0123456789');
  assert.equal(await repository.tokenForChannel('PAGE_ID_1'), undefined);
});

test('summary selects no token columns', async () => {
  const db: ChannelDb = {
    async query(text) {
      assert.equal(text.includes('encrypted'), false);
      return {
        rows: [{
          facebook_user_id: '800000000000001',
          user_token_expires_at: new Date('2026-12-13T07:00:00.000Z'),
          scopes: 'pages_show_list',
          kind: 'facebook_page',
          external_id: '8000000000000002',
          name: 'Example Page<script>',
          page_id: '8000000000000002',
          subscribed_fields: PAGE_SUBSCRIBED_FIELDS,
          subscription_error: null,
        }],
      };
    },
    async connect() {
      throw new Error('summary does not open a transaction');
    },
  };

  const summary = await new ChannelRepository(db, key).summary();

  assert.equal(summary.channels[0]?.name, 'Example Page<script>');
  assert.equal(summary.channels[0]?.subscribed, true);
  assert.equal(JSON.stringify(summary).includes('token'), false);
});

test('rejects a channel id that is not numeric before opening a transaction', async () => {
  let connected = false;
  const db: ChannelDb = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      connected = true;
      throw new Error('should not connect');
    },
  };
  const input = authorization();
  input.channels[0] = { ...input.channels[0], externalId: 'not-a-page', accessToken: 'page-token-value-0123456789' };

  await assert.rejects(
    () => new ChannelRepository(db, key).save(input),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'invalid_authorization');
      assert.equal(error.message.includes('page-token'), false);
      return true;
    },
  );
  assert.equal(connected, false);
});
