import assert from 'node:assert/strict';
import test from 'node:test';

import { createGraphReplyClient, type GraphReplyInput, type GraphReplyResult } from './reply-client.js';

const TOKEN = 'page-token-VERY-SECRET';

function input(overrides: Partial<GraphReplyInput> = {}): GraphReplyInput {
  return {
    platform: 'facebook',
    kind: 'comment',
    channelId: 'PAGE_ID_1',
    senderId: 'PSID_1',
    externalId: 'COMMENT_ID_1',
    text: 'hello',
    accessToken: TOKEN,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function captureFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const captured = { url: String(url), init: init ?? {} };
    calls.push(captured);
    return responder(captured.url, captured.init);
  };
  return { fetchImpl, calls };
}

function headerMap(init: RequestInit): { [name: string]: string | undefined } {
  const headers = init.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    assert.fail('Authorization must be a plain header object so the token cannot hide in a list');
  }
  return headers;
}

function assertTokenOnlyInAuthorization(call: CapturedCall, token: string): void {
  const headers = headerMap(call.init);
  assert.equal(headers.Authorization, `Bearer ${token}`);
  assert.equal(call.url.includes(token), false);
  assert.equal(String(call.init.body ?? '').includes(token), false);
  const rest = { ...headers, Authorization: 'Bearer' };
  assert.equal(JSON.stringify(rest).includes(token), false);
  assert.equal(call.url.includes('access_token'), false);
}

function assertNoFetchLeak(result: GraphReplyResult, ...secrets: string[]): void {
  const dumped = JSON.stringify(result);
  for (const secret of secrets) {
    assert.equal(dumped.includes(secret), false);
  }
}

test('posts a Facebook comment reply to the comment id with the message body', async () => {
  const captured = captureFetch(() => jsonResponse({ id: 'comment-reply-1' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: true, platformMessageId: 'comment-reply-1' });
  assert.equal(captured.calls.length, 1);
  assert.equal(captured.calls[0].url, 'https://graph.facebook.com/v23.0/COMMENT_ID_1/comments');
  assert.equal(captured.calls[0].init.method, 'POST');
  assert.equal(captured.calls[0].init.redirect, 'manual');
  assert.equal(captured.calls[0].init.body, JSON.stringify({ message: 'hello' }));
  assertTokenOnlyInAuthorization(captured.calls[0], TOKEN);
});

test('posts a Facebook private reply to the page id with RESPONSE messaging', async () => {
  const captured = captureFetch(() => jsonResponse({ message_id: 'm_fb_1' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({
    kind: 'message',
    channelId: 'PAGE_ID_1',
    senderId: 'PSID_9',
    text: 'dm hello',
  }));

  assert.deepEqual(result, { ok: true, platformMessageId: 'm_fb_1' });
  assert.equal(captured.calls[0].url, 'https://graph.facebook.com/v23.0/PAGE_ID_1/messages');
  assert.equal(captured.calls[0].init.body, JSON.stringify({
    recipient: { id: 'PSID_9' },
    messaging_type: 'RESPONSE',
    message: { text: 'dm hello' },
  }));
  assertTokenOnlyInAuthorization(captured.calls[0], TOKEN);
});

test('posts an Instagram comment reply to the comment replies edge', async () => {
  const captured = captureFetch(() => jsonResponse({ id: 'ig-reply-1' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({
    platform: 'instagram',
    kind: 'comment',
    externalId: 'IG_COMMENT_1',
    text: 'ig comment',
  }));

  assert.deepEqual(result, { ok: true, platformMessageId: 'ig-reply-1' });
  assert.equal(captured.calls[0].url, 'https://graph.facebook.com/v23.0/IG_COMMENT_1/replies');
  assert.equal(captured.calls[0].init.body, JSON.stringify({ message: 'ig comment' }));
});

test('posts an Instagram private reply without messaging_type', async () => {
  const captured = captureFetch(() => jsonResponse({ message_id: 'm_ig_1' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({
    platform: 'instagram',
    kind: 'message',
    channelId: 'IG_ACCOUNT_1',
    senderId: 'IGSID_1',
    text: 'ig dm',
  }));

  assert.deepEqual(result, { ok: true, platformMessageId: 'm_ig_1' });
  assert.equal(captured.calls[0].url, 'https://graph.facebook.com/v23.0/IG_ACCOUNT_1/messages');
  assert.equal(captured.calls[0].init.body, JSON.stringify({
    recipient: { id: 'IGSID_1' },
    message: { text: 'ig dm' },
  }));
  assert.equal(String(captured.calls[0].init.body).includes('messaging_type'), false);
});

test('uses META graph version when one is provided and still encodes the path id', async () => {
  const captured = captureFetch(() => jsonResponse({ id: 'comment-reply-1' }));
  const client = createGraphReplyClient({
    fetchImpl: captured.fetchImpl,
    graphVersion: 'v21.0',
  });
  const externalId = 'Comment_ID-1';

  await client.send(input({ externalId }));

  assert.equal(
    captured.calls[0].url,
    `https://graph.facebook.com/v21.0/${encodeURIComponent(externalId)}/comments`,
  );
});

test('uses a 10 second timeout by default', async () => {
  const original = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((milliseconds: number) => {
    seen.push(milliseconds);
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;

  try {
    const captured = captureFetch(() => jsonResponse({ id: 'comment-reply-1' }));
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });
    await client.send(input());
  } finally {
    AbortSignal.timeout = original;
  }

  assert.deepEqual(seen, [10_000]);
});

for (const [platform, kind, limit] of [
  ['facebook', 'comment', 8000],
  ['facebook', 'message', 2000],
  ['instagram', 'comment', 2200],
  ['instagram', 'message', 1000],
] as const) {
  test(`accepts a ${platform} ${kind} at exactly ${limit} characters`, async () => {
    const captured = captureFetch(() => jsonResponse(kind === 'comment' ? { id: 'ok' } : { message_id: 'ok' }));
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

    const result = await client.send(input({
      platform,
      kind,
      text: 'a'.repeat(limit),
    }));

    assert.equal(result.ok, true);
    assert.equal(captured.calls.length, 1);
  });

  test(`rejects a ${platform} ${kind} over ${limit} characters without calling Graph`, async () => {
    const captured = captureFetch(() => jsonResponse({ id: 'nope' }));
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

    const result = await client.send(input({
      platform,
      kind,
      text: 'a'.repeat(limit + 1),
    }));

    assert.deepEqual(result, { ok: false, code: 'text_invalid' });
    assert.equal(captured.calls.length, 0);
  });
}

for (const text of ['', ' ', '\n', '\t', ' \n\t ']) {
  test(`rejects blank text ${JSON.stringify(text)} without calling Graph`, async () => {
    const captured = captureFetch(() => jsonResponse({ id: 'nope' }));
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

    const result = await client.send(input({ text }));

    assert.deepEqual(result, { ok: false, code: 'text_invalid' });
    assert.equal(captured.calls.length, 0);
  });
}

for (const externalId of ['', 'bad/id', 'bad id', '..', 'id\n', 'a'.repeat(129), 'id%2Fsecret']) {
  test(`rejects comment id ${JSON.stringify(externalId)} locally`, async () => {
    const captured = captureFetch(() => jsonResponse({ id: 'nope' }));
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

    const result = await client.send(input({ externalId }));

    assert.deepEqual(result, { ok: false, code: 'invalid_object_id' });
    assert.equal(captured.calls.length, 0);
  });
}

test('rejects a message page id that is not safe to put in the path', async () => {
  const captured = captureFetch(() => jsonResponse({ message_id: 'nope' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({ kind: 'message', channelId: 'page/1' }));

  assert.deepEqual(result, { ok: false, code: 'invalid_object_id' });
  assert.equal(captured.calls.length, 0);
});

test('rejects a recipient id that is not an object id without calling Graph', async () => {
  const captured = captureFetch(() => jsonResponse({ message_id: 'nope' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({ kind: 'message', senderId: 'psid 1' }));

  assert.deepEqual(result, { ok: false, code: 'invalid_object_id' });
  assert.equal(captured.calls.length, 0);
});

test('does not call Graph when the access token is empty', async () => {
  const captured = captureFetch(() => jsonResponse({ id: 'nope' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({ accessToken: '' }));

  assert.deepEqual(result, { ok: false, code: 'missing_token' });
  assert.equal(captured.calls.length, 0);
});

test('does not put a token with header injection into the request', async () => {
  const captured = captureFetch(() => jsonResponse({ id: 'nope' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({ accessToken: 'token\r\nX-Injected: 1' }));

  assert.deepEqual(result, { ok: false, code: 'invalid_token' });
  assert.equal(captured.calls.length, 0);
});

for (const graphBaseUrl of [
  'https://example.com',
  'http://graph.facebook.com',
  'https://graph.facebook.com.evil.com',
  'https://user:pass@graph.facebook.com',
  'https://graph.facebook.com/extra',
]) {
  test(`refuses graph base ${graphBaseUrl} without calling fetch`, async () => {
    const captured = captureFetch(() => jsonResponse({ id: 'nope' }));
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl, graphBaseUrl });

    const result = await client.send(input());

    assert.deepEqual(result, { ok: false, code: 'invalid_graph_host' });
    assert.equal(captured.calls.length, 0);
  });
}

test('refuses a graph version that can change the host or path', async () => {
  const captured = captureFetch(() => jsonResponse({ id: 'nope' }));
  const client = createGraphReplyClient({
    fetchImpl: captured.fetchImpl,
    graphVersion: 'v23.0/../@evil.example',
  });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: 'invalid_graph_version' });
  assert.equal(captured.calls.length, 0);
});

test('keeps only a numeric Graph error code and a safe error type', async () => {
  const leaked = 'do-not-log-or-return-this-message';
  const captured = captureFetch(() => jsonResponse({
    error: {
      message: `${leaked} ${TOKEN}`,
      type: 'OAuthException',
      code: 190,
      fbtrace_id: 'TRACE123',
    },
  }, 400));
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });
    const result = await client.send(input());

    assert.deepEqual(result, { ok: false, code: '190', type: 'OAuthException' });
    assertNoFetchLeak(result, leaked, TOKEN, 'TRACE123');
    assert.equal(logs.join('\n').includes(TOKEN), false);
    assert.equal(logs.join('\n').includes(leaked), false);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test('drops an error type that is not a short identifier', async () => {
  const captured = captureFetch(() => jsonResponse({
    error: { message: 'secret message', type: 'OAuth Exception', code: 10 },
  }, 403));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: '10' });
  assertNoFetchLeak(result, 'secret message');
});

test('does not keep a non-numeric error code or the raw body', async () => {
  const captured = captureFetch(() => jsonResponse({
    error: { message: 'raw failure', type: 'OAuthException', code: '190' },
  }, 500));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: 'graph_http_error' });
  assertNoFetchLeak(result, 'raw failure', '190');
});

test('treats a non-json error body as a graph http error', async () => {
  const captured = captureFetch(async () => new Response('<html>secret page</html>', { status: 502 }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: 'graph_http_error' });
  assertNoFetchLeak(result, 'secret page');
});

test('reads at most 64KB of an error body', async () => {
  const leaked = 'PAST_LIMIT_SECRET';
  const message = 'do-not-keep-this-message';
  const prefix = JSON.stringify({
    error: { code: 10, type: 'OAuthException', message },
  });
  const payload = new TextEncoder().encode(`${prefix}${'x'.repeat(64 * 1024)}${leaked}`);
  const state = { bytes: 0, cancels: 0 };
  let offset = 0;
  const stream = new ReadableStream({
    type: 'bytes',
    pull(controller) {
      const request = controller.byobRequest;
      if (!request) {
        controller.error(new Error('error body must be read with a bounded BYOB request'));
        return;
      }
      if (offset >= payload.byteLength) {
        controller.close();
        request.respond(0);
        return;
      }

      const source = request.view;
      if (!source) {
        controller.error(new Error('missing BYOB view'));
        return;
      }
      const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      const room = Math.min(view.byteLength, payload.byteLength - offset);
      view.set(payload.subarray(offset, offset + room));
      offset += room;
      state.bytes += room;
      request.respond(room);
    },
    cancel() {
      state.cancels += 1;
    },
  });
  const captured = captureFetch(async () => new Response(stream, { status: 400 }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.equal(state.bytes <= 64 * 1024, true);
  assert.ok(state.cancels >= 1);
  assertNoFetchLeak(result, leaked, message);
  assert.equal(result.ok, false);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`treats HTTP ${status} as failure and does not read Location`, async () => {
    let locationReads = 0;
    const captured = captureFetch(() => {
      const response = new Response(JSON.stringify({
        error: { message: 'redirect secret', code: 1, type: 'OAuthException' },
      }), {
        status,
        headers: { Location: `https://evil.example/next?access_token=${TOKEN}` },
      });
      const original = response.headers.get.bind(response.headers);
      const headers = response.headers as { get: (name: string) => string | null };
      headers.get = (name: string) => {
        if (name.toLowerCase() === 'location') {
          locationReads += 1;
        }
        return original(name);
      };
      return response;
    });
    const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

    const result = await client.send(input());

    assert.deepEqual(result, { ok: false, code: 'graph_redirect' });
    assert.equal(locationReads, 0);
    assert.equal(captured.calls[0].init.redirect, 'manual');
    assertNoFetchLeak(result, TOKEN, 'evil.example', 'redirect secret');
  });
}

test('returns timeout when the abort signal fires and does not return the error text', { timeout: 2_000 }, async () => {
  const captured = captureFetch((_url, init) => new Promise((_resolve, reject) => {
    const signal = init.signal;
    assert.ok(signal);
    signal.addEventListener('abort', () => {
      const error = new Error(`timed out calling graph with ${TOKEN}`);
      error.name = 'TimeoutError';
      reject(error);
    });
  }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl, timeoutMs: 30 });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: 'timeout' });
  assertNoFetchLeak(result, TOKEN, 'timed out');
});

test('hides network errors instead of returning the thrown message', async () => {
  const captured = captureFetch(async () => {
    throw new Error(`getaddrinfo ENOTFOUND graph.facebook.com ${TOKEN}`);
  });
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: 'graph_unreachable' });
  assertNoFetchLeak(result, TOKEN, 'ENOTFOUND');
});

test('rejects a comment success body that has no string id', async () => {
  const captured = captureFetch(() => jsonResponse({ message_id: 'not-the-comment-field', id: 15 }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: 'invalid_graph_response' });
});

test('rejects a message success body that has no string message_id', async () => {
  const captured = captureFetch(() => jsonResponse({ id: 'not-the-message-field' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input({ kind: 'message' }));

  assert.deepEqual(result, { ok: false, code: 'invalid_graph_response' });
});

test('rejects an empty success id', async () => {
  const captured = captureFetch(() => jsonResponse({ id: '' }));
  const client = createGraphReplyClient({ fetchImpl: captured.fetchImpl });

  const result = await client.send(input());

  assert.deepEqual(result, { ok: false, code: 'invalid_graph_response' });
});


test('public comment reply with an unknown author uses only the comment ID as target', async () => {
  const { fetchImpl, calls } = captureFetch(() => jsonResponse({ id: '123456789_987654321' }));
  const client = createGraphReplyClient({ graphVersion: 'v26.0', fetchImpl });
  const result = await client.send(input({
    channelId: '8000000000000007', senderId: 'unknown',
    externalId: '800000000000000003_123456789',
  }));
  assert.equal(result.ok, true);
  assert.equal(new URL(calls[0]!.url).pathname, '/v26.0/800000000000000003_123456789/comments');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { message: 'hello' });
});
