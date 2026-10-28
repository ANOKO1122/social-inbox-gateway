import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from './app.js';

test('GET /health/live returns an ok status', async () => {
  const app = createApp({
    config: {
      port: 4010,
      host: '127.0.0.1',
      databaseUrl: 'postgresql://user:password@localhost:5432/social_inbox',
      metaVerifyToken: 'verify-token',
      metaAppSecret: 'app-secret',
    },
    eventStore: {
      async storeVerifiedWebhook() {
        return { rawInserted: true, normalizedInserted: 0 };
      },
    },
  });

  const response = await request(app).get('/health/live');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});
