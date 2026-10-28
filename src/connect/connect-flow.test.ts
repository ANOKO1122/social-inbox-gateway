import assert from 'node:assert/strict';
import test from 'node:test';

import { completeAuthorization, type AuthorizationStore, type SaveAuthorization } from './connect-flow.js';
import type { FacebookPageAccount, MetaOauthClient } from './oauth-client.js';
import { REQUIRED_SCOPES } from './scopes.js';

const PAGE_TOKEN = 'page-token-value-0123456789';
const LONG_TOKEN = 'long-user-token-0123456789';

function oauth(pages: FacebookPageAccount[], subscribe: MetaOauthClient['subscribePage']): MetaOauthClient {
  return {
    buildAuthorizationUrl() {
      return 'https://www.facebook.com/v26.0/dialog/oauth';
    },
    async exchangeCode() {
      return 'short-user-token-0123456789';
    },
    async exchangeLongLived(token) {
      assert.equal(token, 'short-user-token-0123456789');
      return { accessToken: LONG_TOKEN, expiresIn: 5_184_000 };
    },
    async fetchUserId() {
      return '800000000000001';
    },
    async fetchGrantedScopes() {
      return [...REQUIRED_SCOPES];
    },
    async listPages() {
      return pages;
    },
    subscribePage: subscribe,
  };
}

function store(): AuthorizationStore & { saved: SaveAuthorization[] } {
  const saved: SaveAuthorization[] = [];
  return {
    saved,
    async save(input) {
      saved.push(input);
    },
    async summary() {
      return { grants: [], channels: [] };
    },
  };
}

test('saves the long-lived user token and subscribes the page and its Instagram account', async () => {
  const subscribed: string[] = [];
  const saved = store();
  const now = new Date('2026-10-14T07:00:00.000Z');

  await completeAuthorization(oauth([{
    id: '8000000000000002',
    name: 'Example Page',
    accessToken: PAGE_TOKEN,
    instagram: { id: '80000000000000009', username: 'example_page' },
  }], async (pageId, pageToken) => {
    subscribed.push(`${pageId}:${pageToken}`);
    return { ok: true };
  }), saved, 'code-value', now);

  assert.deepEqual(subscribed, [`8000000000000002:${PAGE_TOKEN}`]);
  assert.equal(saved.saved.length, 1);
  assert.equal(saved.saved[0]?.userToken, LONG_TOKEN);
  assert.equal(saved.saved[0]?.userTokenExpiresAt.toISOString(), '2026-12-13T07:00:00.000Z');
  assert.deepEqual(saved.saved[0]?.channels.map((channel) => channel.kind), ['facebook_page', 'instagram']);
  assert.equal(saved.saved[0]?.channels[1]?.accessToken, PAGE_TOKEN);
  assert.equal(saved.saved[0]?.channels[0]?.subscribed, true);
});

test('keeps the page when subscription fails and does not hide the error code', async () => {
  const saved = store();

  await completeAuthorization(oauth([{
    id: '8000000000000002',
    name: 'Example Page',
    accessToken: PAGE_TOKEN,
    instagram: null,
  }], async () => ({ ok: false, code: 'graph_200' })), saved, 'code-value');

  assert.equal(saved.saved[0]?.channels[0]?.subscribed, false);
  assert.equal(saved.saved[0]?.channels[0]?.subscriptionError, 'graph_200');
});
