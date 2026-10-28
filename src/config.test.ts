import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from './config.js';

const validEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/social_inbox',
  META_VERIFY_TOKEN: 'verify-token',
  META_APP_SECRET: 'app-secret',
};

test('uses port 4010 when PORT is absent', () => {
  const config = loadConfig(validEnv);

  assert.equal(config.port, 4010);
});

for (const invalidPort of ['not-a-number', '0', '1.5', '65536']) {
  test(`rejects invalid PORT value ${invalidPort}`, () => {
    assert.throws(
      () => loadConfig({ ...validEnv, PORT: invalidPort }),
      /PORT/,
    );
  });
}

for (const variable of [
  'DATABASE_URL',
  'META_VERIFY_TOKEN',
  'META_APP_SECRET',
] as const) {
  test(`reports ${variable} when it is missing`, () => {
    const env = { ...validEnv };
    delete env[variable];

    assert.throws(() => loadConfig(env), new RegExp(variable));
  });
}

test('binds to 127.0.0.1 when HOST is absent', () => {
  assert.equal(loadConfig(validEnv).host, '127.0.0.1');
});

for (const validHost of ['127.0.0.1', '0.0.0.0', '192.168.1.10', '::1', '::', '2001:db8::1', '::ffff:127.0.0.1', 'localhost']) {
  test(`accepts HOST value ${validHost}`, () => {
    assert.equal(loadConfig({ ...validEnv, HOST: validHost }).host, validHost);
  });
}

test('starts with the original four variables and closed reply settings', () => {
  const config = loadConfig(validEnv);

  assert.equal(config.metaGraphVersion, 'v23.0');
  assert.deepEqual(config.metaChannelTokens, {});
  assert.equal(config.internalApiToken, undefined);
  assert.equal(config.connect, undefined);
});

test('treats an empty META_CHANNEL_TOKENS value as no tokens', () => {
  assert.deepEqual(loadConfig({ ...validEnv, META_CHANNEL_TOKENS: '' }).metaChannelTokens, {});
});

test('reads META_CHANNEL_TOKENS as channel ids mapped to tokens', () => {
  const config = loadConfig({
    ...validEnv,
    META_CHANNEL_TOKENS: '{"PAGE_1":"token-a","IG_1":"token-b"}',
  });

  assert.deepEqual(config.metaChannelTokens, { PAGE_1: 'token-a', IG_1: 'token-b' });
});

for (const badTokens of [
  'not-json',
  '[]',
  'null',
  '"token"',
  '1',
  '{"a":""}',
  '{"a":1}',
  '{"a":{"b":"c"}}',
  '{"a":null}',
  '{"":"token"}',
]) {
  test(`rejects META_CHANNEL_TOKENS ${JSON.stringify(badTokens)} without echoing it`, () => {
    assert.throws(
      () => loadConfig({ ...validEnv, META_CHANNEL_TOKENS: badTokens }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'META_CHANNEL_TOKENS');
        assert.equal(error.message.includes(badTokens), false);
        return true;
      },
    );
  });
}

test('leaves INTERNAL_API_TOKEN unset when it is absent or empty', () => {
  assert.equal(loadConfig(validEnv).internalApiToken, undefined);
  assert.equal(loadConfig({ ...validEnv, INTERNAL_API_TOKEN: '' }).internalApiToken, undefined);
});

test('reads INTERNAL_API_TOKEN when it is set', () => {
  assert.equal(
    loadConfig({ ...validEnv, INTERNAL_API_TOKEN: 'internal-token' }).internalApiToken,
    'internal-token',
  );
});

test('defaults META_GRAPH_VERSION to v23.0', () => {
  assert.equal(loadConfig(validEnv).metaGraphVersion, 'v23.0');
  assert.equal(loadConfig({ ...validEnv, META_GRAPH_VERSION: 'v21.0' }).metaGraphVersion, 'v21.0');
});

for (const badVersion of ['v23', '23.0', 'v23.0/extra', 'https://evil.example']) {
  test(`rejects META_GRAPH_VERSION ${JSON.stringify(badVersion)} without echoing it`, () => {
    assert.throws(
      () => loadConfig({ ...validEnv, META_GRAPH_VERSION: badVersion }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'META_GRAPH_VERSION');
        assert.equal(error.message.includes(badVersion), false);
        return true;
      },
    );
  });
}

test('reads connect settings only when the four values are all present', () => {
  const config = loadConfig({
    ...validEnv,
    META_APP_ID: '800000000000006',
    META_OAUTH_REDIRECT_URI: 'https://inbox.example.com/inbox/connect/facebook/callback',
    META_TOKEN_KEY: 'ab'.repeat(32),
    CONNECT_PASSWORD: 'connect-password-1',
  });

  assert.equal(config.connect?.appId, '800000000000006');
  assert.equal(config.connect?.mountPath, '/inbox/connect');
  assert.equal(config.connect?.cookiePath, '/inbox/connect');
  assert.equal(config.connect?.tokenKey.length, 32);
  assert.equal(config.connect?.password, 'connect-password-1');
});

test('names the missing connect variable and does not echo a bad redirect', () => {
  assert.throws(
    () => loadConfig({ ...validEnv, META_APP_ID: '800000000000006' }),
    /META_OAUTH_REDIRECT_URI/,
  );

  const badRedirect = 'https://evil.example/steal?token=secret-value';
  assert.throws(
    () => loadConfig({
      ...validEnv,
      META_APP_ID: '800000000000006',
      META_OAUTH_REDIRECT_URI: badRedirect,
      META_TOKEN_KEY: 'ab'.repeat(32),
      CONNECT_PASSWORD: 'connect-password-1',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'META_OAUTH_REDIRECT_URI');
      assert.equal(error.message.includes('secret-value'), false);
      return true;
    },
  );
});

test('reads DingTalk settings without putting the secret in an error', () => {
  const secret = 'dingtalk-client-secret';
  const config = loadConfig({
    ...validEnv,
    META_APP_ID: '800000000000006',
    META_OAUTH_REDIRECT_URI: 'https://inbox.example.com/inbox/connect/facebook/callback',
    META_TOKEN_KEY: 'ab'.repeat(32),
    CONNECT_PASSWORD: 'connect-password-1',
    DINGTALK_CLIENT_ID: 'dingexampleclientid',
    DINGTALK_CLIENT_SECRET: secret,
    DINGTALK_APP_ID: 'app-1',
  });

  assert.equal(config.dingtalk?.clientId, 'dingexampleclientid');
  assert.equal(config.dingtalk?.redirectUri, 'https://inbox.example.com/inbox/auth/dingtalk/callback');
  assert.equal(config.dingtalk?.appId, 'app-1');
  assert.equal(config.dingtalk?.clientSecret, secret);

  assert.throws(
    () => loadConfig({
      ...validEnv,
      META_APP_ID: '800000000000006',
      META_OAUTH_REDIRECT_URI: 'https://inbox.example.com/inbox/connect/facebook/callback',
      META_TOKEN_KEY: 'ab'.repeat(32),
      CONNECT_PASSWORD: 'connect-password-1',
      DINGTALK_CLIENT_ID: 'dingexampleclientid',
      DINGTALK_CLIENT_SECRET: 'short',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'DINGTALK_CLIENT_SECRET');
      assert.equal(error.message.includes('short'), false);
      return true;
    },
  );
});

test('leaves Dify unset until both the base URL and the app key are present', () => {
  assert.equal(loadConfig(validEnv).dify, undefined);
  assert.throws(
    () => loadConfig({ ...validEnv, DIFY_API_BASE: 'http://nginx/v1' }),
    /DIFY_API_KEY/,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, DIFY_API_KEY: 'app-abcdefghijklmnopqrst' }),
    /DIFY_API_BASE/,
  );
  const config = loadConfig({
    ...validEnv,
    DIFY_API_BASE: 'http://nginx/v1/',
    DIFY_API_KEY: 'app-abcdefghijklmnopqrst',
  });
  assert.equal(config.dify?.apiBase, 'http://nginx/v1');
  assert.equal(config.dify?.apiKey, 'app-abcdefghijklmnopqrst');
});

for (const invalidHost of [
  '',
  ' ',
  '  127.0.0.1',
  '127.0.0.1 ',
  'example.com',
  'LOCALHOST.evil',
  '256.0.0.1',
  '1.2.3',
  '0',
  '127.1',
  '0x7f.1',
  '017700000001',
  '127.0.0.1\n',
  'LOCALHOST',
  '127.0.0.1:4010',
  'http://127.0.0.1',
  '0.0.0.0/0',
  '[::1]',
  'host;rm -rf /',
]) {
  test(`rejects invalid HOST value ${JSON.stringify(invalidHost)}`, () => {
    assert.throws(
      () => loadConfig({ ...validEnv, HOST: invalidHost }),
      /HOST/,
    );
  });
}
