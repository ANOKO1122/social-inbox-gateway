import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectFlowError, createMetaOauthClient, PAGE_SUBSCRIBED_FIELDS } from './oauth-client.js';
import { LOGIN_SCOPES } from './scopes.js';

const APP_ID = '800000000000006';
const APP_SECRET = 'app-secret-value';
const REDIRECT = 'https://inbox.example.com/inbox/connect/facebook/callback';
const USER_TOKEN = 'user-token-value-0123456789';
const PAGE_TOKEN = 'page-token-value-0123456789';

function client(fetchImpl: typeof fetch) {
  return createMetaOauthClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    redirectUri: REDIRECT,
    graphVersion: 'v26.0',
    fetchImpl,
  });
}

test('authorization URL asks for the inbox scopes and never carries the app secret', () => {
  const url = new URL(client(fetch).buildAuthorizationUrl('state-value-0123456789'));

  assert.equal(url.origin, 'https://www.facebook.com');
  assert.equal(url.pathname, '/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), APP_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), LOGIN_SCOPES.join(','));
  assert.equal(url.toString().includes(APP_SECRET), false);
});

test('exchanges the code and the long-lived token without putting the secret in an error', async () => {
  const calls: string[] = [];
  const oauth = client(async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams.get('grant_type') ?? 'code'}`);
    if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
      return new Response(JSON.stringify({ access_token: `long-${USER_TOKEN}`, expires_in: 5_184_000 }), { status: 200 });
    }
    assert.equal(url.searchParams.get('client_secret'), APP_SECRET);
    return new Response(JSON.stringify({ access_token: USER_TOKEN, expires_in: 3600 }), { status: 200 });
  });

  assert.equal(await oauth.exchangeCode('code-value'), USER_TOKEN);
  const longLived = await oauth.exchangeLongLived(USER_TOKEN);
  assert.equal(longLived.accessToken, `long-${USER_TOKEN}`);
  assert.equal(longLived.expiresIn, 5_184_000);
  assert.deepEqual(calls, ['/v26.0/oauth/access_token?code', '/v26.0/oauth/access_token?fb_exchange_token']);
});

test('keeps the access token when Meta omits the expiry or sends an unusual lifetime', async () => {
  const hour = client(async () => new Response(JSON.stringify({
    access_token: USER_TOKEN,
    expires_in: 3600,
  }), { status: 200 }));
  assert.deepEqual(await hour.exchangeLongLived(USER_TOKEN), { accessToken: USER_TOKEN, expiresIn: 3600 });

  const missing = client(async () => new Response(JSON.stringify({
    access_token: USER_TOKEN,
  }), { status: 200 }));
  assert.deepEqual(await missing.exchangeLongLived(USER_TOKEN), { accessToken: USER_TOKEN, expiresIn: 5_184_000 });

  const asText = client(async () => new Response(JSON.stringify({
    access_token: USER_TOKEN,
    expires_in: '5183944',
  }), { status: 200 }));
  assert.equal((await asText.exchangeLongLived(USER_TOKEN)).expiresIn, 5_183_944);
});

test('keeps only the numeric Graph error code when the body echoes a token', async () => {
  const oauth = client(async () => new Response(JSON.stringify({
    error: { message: `bad ${PAGE_TOKEN}`, code: 190, type: 'OAuthException' },
  }), { status: 400 }));

  await assert.rejects(
    () => oauth.fetchUserId(USER_TOKEN),
    (error: unknown) => {
      assert.ok(error instanceof ConnectFlowError);
      assert.equal(error.code, 'graph_190');
      assert.equal(error.message.includes(PAGE_TOKEN), false);
      return true;
    },
  );
});

test('lists pages and does not follow a paging URL on another host', async () => {
  const fetched: string[] = [];
  const oauth = client(async (input) => {
    const url = new URL(String(input));
    fetched.push(url.hostname + url.pathname);
    assert.equal(url.searchParams.has('access_token'), false);
    if (url.searchParams.get('after') === 'cursor-2') {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [{
        id: '8000000000000002',
        name: 'Example Page',
        access_token: PAGE_TOKEN,
        instagram_business_account: { id: '80000000000000009', username: 'example_page' },
      }],
      paging: {
        next: `https://evil.example/steal?access_token=${PAGE_TOKEN}`,
        cursors: { after: 'cursor-2' },
      },
    }), { status: 200 });
  });

  const pages = await oauth.listPages(USER_TOKEN);

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.instagram?.username, 'example_page');
  assert.deepEqual(fetched, ['graph.facebook.com/v26.0/me/accounts', 'graph.facebook.com/v26.0/me/accounts']);
});

test('subscribes feed and messages with the page token in the header', async () => {
  let seen = '';
  const oauth = client(async (input, init) => {
    const url = new URL(String(input));
    seen = `${url.pathname} ${String(init?.body)} ${(init?.headers as Record<string, string>).Authorization}`;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });

  const result = await oauth.subscribePage('8000000000000002', PAGE_TOKEN);

  assert.deepEqual(result, { ok: true });
  assert.match(seen, /\/8000000000000002\/subscribed_apps/);
  assert.match(seen, new RegExp(encodeURIComponent(PAGE_SUBSCRIBED_FIELDS)));
  assert.match(seen, new RegExp(`Bearer ${PAGE_TOKEN}`));
  assert.equal(seen.includes('access_token='), false);
});


test('lists all 55 pages across full batches and stops when next is absent', async () => {
  let requests = 0;
  const oauth = client(async (input) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get('after') ?? '0');
    requests += 1;
    const count = Math.min(25, 55 - offset);
    return new Response(JSON.stringify({
      data: Array.from({ length: count }, (_, i) => ({
        id: String(100000 + offset + i), name: `Page ${offset + i}`, access_token: PAGE_TOKEN,
      })),
      paging: {
        ...(offset + count < 55 ? { next: 'https://graph.facebook.com/next' } : {}),
        cursors: { after: String(offset + count) },
      },
    }));
  });
  const pages = await oauth.listPages(USER_TOKEN);
  assert.equal(pages.length, 55);
  assert.equal(pages.at(-1)?.id, '100054');
  assert.equal(requests, 3);
});

test('rejects a repeated cursor instead of returning an incomplete list', async () => {
  const oauth = client(async () => new Response(JSON.stringify({
    data: [{ id: '100000', name: 'Page', access_token: PAGE_TOKEN }],
    paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'same-cursor' } },
  })));
  await assert.rejects(oauth.listPages(USER_TOKEN), /invalid_graph_pagination/);
});

test('rejects missing cursor when another page exists', async () => {
  const oauth = client(async () => new Response(JSON.stringify({
    data: [], paging: { next: 'https://graph.facebook.com/next' },
  })));
  await assert.rejects(oauth.listPages(USER_TOKEN), /invalid_graph_pagination/);
});

test('fails on a later page error instead of returning the first page', async () => {
  let requests = 0;
  const oauth = client(async () => {
    if (++requests > 1) return new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 });
    return new Response(JSON.stringify({
      data: [{ id: '100000', name: 'Page', access_token: PAGE_TOKEN }],
      paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'cursor-2' } },
    }));
  });
  await assert.rejects(oauth.listPages(USER_TOKEN), /graph_190/);
});

test('fails at the request safety limit instead of saving a partial list', async () => {
  let requests = 0;
  const oauth = client(async () => new Response(JSON.stringify({
    data: [],
    paging: { next: 'https://graph.facebook.com/next', cursors: { after: String(++requests) } },
  })));
  await assert.rejects(oauth.listPages(USER_TOKEN), /graph_pagination_limit/);
  assert.equal(requests, 100);
});
