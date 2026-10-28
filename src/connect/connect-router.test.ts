import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../app.js';
import type { AppConfig, ConnectSettings } from '../config.js';
import type { SaveAuthorization } from './connect-flow.js';
import type { MetaOauthClient } from './oauth-client.js';
import { REQUIRED_SCOPES } from './scopes.js';
import { openPayload, signingKey, STATE_COOKIE } from './session.js';

const PASSWORD = 'connect-password-1';
const TOKEN_KEY = Buffer.alloc(32, 4);
const PAGE_TOKEN = 'page-token-secret-value';
const USER_TOKEN = 'long-user-token-secret';

function settings(): ConnectSettings {
  return {
    appId: '800000000000006',
    redirectUri: 'https://inbox.example.com/inbox/connect/facebook/callback',
    mountPath: '/inbox/connect',
    cookiePath: '/inbox/connect',
    tokenKey: TOKEN_KEY,
    password: PASSWORD,
  };
}

function config(connect?: ConnectSettings): AppConfig {
  return {
    port: 4010,
    host: '127.0.0.1',
    databaseUrl: 'postgresql://user:password@localhost:5432/social_inbox',
    metaVerifyToken: 'verify-token',
    metaAppSecret: 'app-secret-value',
    metaGraphVersion: 'v26.0',
    connect,
  };
}

function harness(
  oauthOverrides: Partial<MetaOauthClient> = {},
  options: { adminGuard?: () => Promise<boolean> } = {},
) {
  const saved: SaveAuthorization[] = [];
  const oauth: MetaOauthClient = {
    buildAuthorizationUrl(state) {
      return `https://www.facebook.com/v26.0/dialog/oauth?state=${encodeURIComponent(state)}`;
    },
    async exchangeCode() {
      return 'short-user-token-0123456789';
    },
    async exchangeLongLived() {
      return { accessToken: USER_TOKEN, expiresIn: 5_184_000 };
    },
    async fetchUserId() {
      return '800000000000001';
    },
    async fetchGrantedScopes() {
      return [...REQUIRED_SCOPES];
    },
    async listPages() {
      return [{
        id: '8000000000000002',
        name: 'Example Page',
        accessToken: PAGE_TOKEN,
        instagram: { id: '80000000000000009', username: 'example_page' },
      }];
    },
    async subscribePage() {
      return { ok: true };
    },
    ...oauthOverrides,
  };
  const app = createApp({
    config: config(settings()),
    eventStore: {
      async storeVerifiedWebhook() {
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
    connect: {
      oauth,
      channels: {
        async save(input) {
          saved.push(input);
        },
        async summary() {
          const last = saved.at(-1);
          if (!last) {
            return { grants: [], channels: [] };
          }
          return {
            grants: [{
              facebookUserId: last.facebookUserId,
              expiresAt: last.userTokenExpiresAt,
              scopes: last.scopes,
            }],
            channels: last.channels.map((channel) => ({
              kind: channel.kind,
              externalId: channel.externalId,
              name: channel.name,
              pageId: channel.pageId,
              subscribed: channel.subscribed,
              subscriptionError: channel.subscriptionError,
            })),
          };
        },
        async tokenForChannel() {
          return undefined;
        },
      },
      adminGuard: options.adminGuard,
    },
  });

  return { app, saved };
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.find((header) => header.startsWith(`${name}=`));
  if (!match) {
    return undefined;
  }
  return decodeURIComponent(match.slice(name.length + 1).split(';', 1)[0] ?? '');
}

test('does not mount the connect page when connect settings are absent', async () => {
  const app = createApp({
    config: config(),
    eventStore: {
      async storeVerifiedWebhook() {
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
  });

  const response = await request(app).get('/inbox/connect');

  assert.equal(response.status, 404);
});

test('refuses to start a configured connect page without its dependencies', () => {
  assert.throws(
    () => createApp({
      config: config(settings()),
      eventStore: {
        async storeVerifiedWebhook() {
          return { rawInserted: true, normalizedInserted: 0 };
        },
      },
    }),
    /connect dependencies/,
  );
});

test('login page shows the callback and scopes, and a wrong password sets no cookie', async () => {
  const { app } = harness();

  const page = await request(app).get('/inbox/connect');
  assert.equal(page.status, 200);
  assert.match(page.text, /inbox\.example\.com\/inbox\/connect\/facebook\/callback/);
  assert.match(page.text, /pages_manage_metadata/);
  assert.equal(page.text.includes(PASSWORD), false);
  assert.equal(page.text.includes('app-secret-value'), false);
  assert.equal(page.headers['set-cookie'], undefined);

  const denied = await request(app).post('/inbox/connect/login').type('form').send({ password: 'wrong-password-value' });
  assert.equal(denied.status, 401);
  assert.match(denied.text, /口令不正确/);
  assert.equal(denied.headers['set-cookie'], undefined);
});

function cookiePair(setCookie: string | string[] | undefined, name: string): string | undefined {
  const value = cookieValue(setCookie, name);
  return value === undefined ? undefined : `${name}=${encodeURIComponent(value)}`;
}

test('a logged-in admin can authorize, and the page never shows the tokens', async () => {
  const { app, saved } = harness();

  const login = await request(app).post('/inbox/connect/login').type('form').send({ password: PASSWORD }).redirects(0);
  assert.equal(login.status, 303);
  assert.match(String(login.headers['set-cookie']), /HttpOnly/);
  assert.match(String(login.headers['set-cookie']), /Secure/);
  assert.match(String(login.headers['set-cookie']), /Path=\/inbox\/connect/);
  const session = cookiePair(login.headers['set-cookie'], 'sig_connect');
  assert.ok(session);

  const start = await request(app).get('/inbox/connect/facebook/start').set('Cookie', session).redirects(0);
  assert.equal(start.status, 303);
  assert.match(String(start.headers.location), /^https:\/\/www\.facebook\.com\/v26\.0\/dialog\/oauth\?/);
  const stateToken = cookieValue(start.headers['set-cookie'], STATE_COOKIE);
  assert.ok(stateToken);
  const state = openPayload(signingKey(TOKEN_KEY), stateToken, Math.floor(Date.now() / 1000));
  assert.equal(state?.kind, 'state');
  if (state?.kind !== 'state') {
    return;
  }
  const statePair = cookiePair(start.headers['set-cookie'], STATE_COOKIE);
  assert.ok(statePair);

  const callback = await request(app)
    .get(`/inbox/connect/facebook/callback?code=code-value&state=${encodeURIComponent(state.nonce)}`)
    .set('Cookie', `${session}; ${statePair}`)
    .redirects(0);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location, '/inbox/connect?connected=1');
  assert.equal(String(callback.headers.location).includes(PAGE_TOKEN), false);
  assert.equal(saved[0]?.userToken, USER_TOKEN);
  assert.equal(saved[0]?.channels[0]?.subscribed, true);

  const done = await request(app).get('/inbox/connect?connected=1').set('Cookie', session);
  assert.match(done.text, /Example Page/);
  assert.match(done.text, /已订阅 feed、messages/);
  assert.equal(done.text.includes(PAGE_TOKEN), false);
  assert.equal(done.text.includes(USER_TOKEN), false);
});

test('callback without the state cookie does not exchange the code', async () => {
  let exchanged = 0;
  const { app } = harness({
    async exchangeCode() {
      exchanged += 1;
      return 'short-user-token-0123456789';
    },
  });
  const login = await request(app).post('/inbox/connect/login').type('form').send({ password: PASSWORD }).redirects(0);
  const session = cookiePair(login.headers['set-cookie'], 'sig_connect');
  assert.ok(session);

  const callback = await request(app)
    .get('/inbox/connect/facebook/callback?code=code-value&state=forged-state-value')
    .set('Cookie', session)
    .redirects(0);

  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location, '/inbox/connect?error=state_mismatch');
  assert.equal(exchanged, 0);
});

test('an admin can leave the connect page for the workbench', async () => {
  const { app } = harness({}, { adminGuard: async () => true });
  const page = await request(app).get('/inbox/connect');
  assert.equal(page.status, 200);
  assert.match(page.text, /href="\/inbox\/workbench"/);
  assert.match(page.text, />收件</);
  assert.equal(page.text.includes('>退出<'), false);
});
