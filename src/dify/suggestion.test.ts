import assert from 'node:assert/strict';
import test from 'node:test';

import { createSuggestionClient, parseSuggestion, SuggestionError } from './suggestion.js';

const draft = {
  intent: 'size_question',
  suggested_reply: 'Yes, this goes up to 3XL.',
  needs_human: false,
  sources: ['服饰尺码表'],
};

test('parseSuggestion reads workflow outputs and keeps a sourced automatic draft', () => {
  const parsed = parseSuggestion({ data: { status: 'succeeded', outputs: draft } });
  assert.deepEqual(parsed, {
    intent: 'size_question',
    suggestedReply: 'Yes, this goes up to 3XL.',
    needsHuman: false,
    sources: ['服饰尺码表'],
  });
});

test('parseSuggestion accepts a JSON string and forces review when nothing was cited', () => {
  const parsed = parseSuggestion({
    data: {
      status: 'succeeded',
      outputs: { result: JSON.stringify({ ...draft, sources: [], needs_human: false }) },
    },
  });
  assert.equal(parsed?.needsHuman, true);
  assert.deepEqual(parsed?.sources, []);
});

test('parseSuggestion reads JSON wrapped in a markdown fence', () => {
  const parsed = parseSuggestion({
    data: {
      status: 'succeeded',
      outputs: { text: '```json\n{"intent":"shipping","suggested_reply":"Please share the order number.","needs_human":true,"sources":[]}\n```' },
    },
  });
  assert.equal(parsed?.intent, 'shipping');
  assert.equal(parsed?.needsHuman, true);
  assert.equal(parsed?.suggestedReply, 'Please share the order number.');
});

test('parseSuggestion rejects a failed run', () => {
  assert.equal(parseSuggestion({ data: { status: 'failed', outputs: draft } }), undefined);
});

test('the client posts a blocking workflow run and never puts the key in an error', async () => {
  const key = 'app-abcdefghijklmnopqrst';
  let seen: { url: string; authorization: string; body: unknown } | undefined;
  const client = createSuggestionClient({
    apiBase: 'http://nginx/v1',
    apiKey: key,
    fetchImpl: async (input, init) => {
      seen = {
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization') ?? '',
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify({ data: { status: 'succeeded', outputs: draft } }), { status: 200 });
    },
  });
  const result = await client.draft({
    staffId: '11111111-1111-4111-8111-111111111111',
    platform: 'facebook',
    kind: 'comment',
    text: 'Does it come in Newport?',
    postText: 'wool coat',
    replyTo: null,
    context: '- Mark: hello',
  });
  assert.equal(result.suggestedReply, draft.suggested_reply);
  assert.equal(seen?.url, 'http://nginx/v1/workflows/run');
  assert.equal(seen?.authorization, `Bearer ${key}`);
  const body = seen?.body as { response_mode: string; inputs: { text: string } };
  assert.equal(body.response_mode, 'blocking');
  assert.equal(body.inputs.text, 'Does it come in Newport?');
});

test('a failed workflow response stays a fixed error and drops the body', async () => {
  const secret = 'app-zzzzzzzzzzzzzzzz';
  const client = createSuggestionClient({
    apiBase: 'http://nginx/v1',
    apiKey: 'app-abcdefghijklmnopqrst',
    fetchImpl: async () => new Response(JSON.stringify({ message: secret }), { status: 401 }),
  });
  await assert.rejects(
    () => client.draft({
      staffId: 'staff',
      platform: 'facebook',
      kind: 'message',
      text: 'hi',
      postText: null,
      replyTo: null,
      context: '',
    }),
    (error: unknown) => {
      assert.ok(error instanceof SuggestionError);
      assert.equal(error.code, 'unavailable');
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );
});

test('a failed model authentication stays a fixed error and drops the body', async () => {
  const secret = 'sk-should-not-leak';
  const client = createSuggestionClient({
    apiBase: 'http://nginx/v1',
    apiKey: 'app-abcdefghijklmnopqrst',
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        status: 'failed',
        error: `PluginInvokeError authentication_error HTTP 401 ${secret}`,
      },
    }), { status: 200 }),
  });
  await assert.rejects(
    () => client.draft({
      staffId: 'staff',
      platform: 'facebook',
      kind: 'comment',
      text: 'hi',
      postText: null,
      replyTo: null,
      context: '',
    }),
    (error: unknown) => {
      assert.ok(error instanceof SuggestionError);
      assert.equal(error.code, 'model_auth');
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );
});

test('an aborted run is a timeout', async () => {
  const client = createSuggestionClient({
    apiBase: 'http://nginx/v1',
    apiKey: 'app-abcdefghijklmnopqrst',
    fetchImpl: async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  await assert.rejects(
    () => client.draft({
      staffId: 'staff',
      platform: 'facebook',
      kind: 'comment',
      text: 'hi',
      postText: null,
      replyTo: null,
      context: '',
    }),
    (error: unknown) => error instanceof SuggestionError && error.code === 'timeout',
  );
});
