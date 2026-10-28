import assert from 'node:assert/strict';
import test from 'node:test';

import { createDingTalkClient, DingTalkError } from './dingtalk-client.js';

const REDIRECT = 'https://inbox.example.com/inbox/auth/dingtalk/callback';
const SECRET = 'client-secret-value';

test('authorization URL uses the client id and never the secret', () => {
  const client = createDingTalkClient({
    clientId: 'dingexampleclientid',
    clientSecret: SECRET,
    redirectUri: REDIRECT,
  });
  const url = new URL(client.buildAuthorizationUrl('state-value-0123456789'));

  assert.equal(url.origin, 'https://login.dingtalk.com');
  assert.equal(url.searchParams.get('client_id'), 'dingexampleclientid');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.toString().includes(SECRET), false);
});

test('exchanges a code for a profile and hides DingTalk error text', async () => {
  const calls: string[] = [];
  const client = createDingTalkClient({
    clientId: 'dingexampleclientid',
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith('/userAccessToken')) {
        const body = JSON.parse(String(init?.body)) as { clientSecret?: string };
        assert.equal(body.clientSecret, SECRET);
        return new Response(JSON.stringify({ accessToken: 'user-access-token' }), { status: 200 });
      }
      assert.equal((init?.headers as Record<string, string>)['x-acs-dingtalk-access-token'], 'user-access-token');
      return new Response(JSON.stringify({ unionId: 'union-user-1', nick: '阿宁' }), { status: 200 });
    },
  });

  assert.deepEqual(await client.exchangeCode('auth-code-1'), { unionId: 'union-user-1', name: '阿宁' });
  assert.deepEqual(calls, ['/v1.0/oauth2/userAccessToken', '/v1.0/contact/users/me']);

  const failing = createDingTalkClient({
    clientId: 'dingexampleclientid',
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'InvalidAuthentication',
      message: `leaked ${SECRET}`,
    }), { status: 401 }),
  });
  await assert.rejects(
    () => failing.exchangeCode('auth-code-1'),
    (error: unknown) => {
      assert.ok(error instanceof DingTalkError);
      assert.equal(error.code, 'InvalidAuthentication');
      assert.equal(error.message.includes(SECRET), false);
      return true;
    },
  );
});
