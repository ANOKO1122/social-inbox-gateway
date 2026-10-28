import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildEventKey } from './event-key.js';
import type { MetaWebhookPayload } from './types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function messagingPayload(...mids: string[]): MetaWebhookPayload {
  return {
    object: 'page',
    entry: [
      {
        id: 'page-1',
        time: 1,
        messaging: mids.map((mid) => ({ sender: { id: 'user-1' }, message: { mid, text: 'hi' } })),
      },
    ],
  };
}

function commentPayload(object: string, value: Record<string, unknown>, field = 'comments'): MetaWebhookPayload {
  return { object, entry: [{ id: 'p1', changes: [{ field, value }] }] };
}

test('returns a 64 character lowercase hex SHA-256 digest', () => {
  assert.match(buildEventKey(messagingPayload('m_1')), /^[0-9a-f]{64}$/);
});

test('hashes a structured array with the ids:v1 domain, object and sorted event tokens', () => {
  const payload = messagingPayload('m_b', 'm_a');

  assert.equal(
    buildEventKey(payload),
    sha256(JSON.stringify(['ids:v1', 'page', [['message', 'm_a'], ['message', 'm_b']]])),
  );
});

test('builds [kind, id] tokens for messaging mid, comment_id, value id and value mid', () => {
  const payload: MetaWebhookPayload = {
    object: 'instagram',
    entry: [
      {
        id: 'ig-1',
        messaging: [{ message: { mid: 'mid-1' } }],
        changes: [
          { field: 'comments', value: { comment_id: 'comment-1' } },
          { field: 'comments', value: { id: 'value-id-1' } },
          { field: 'messages', value: { mid: 'value-mid-1' } },
        ],
      },
    ],
  };

  assert.equal(
    buildEventKey(payload),
    sha256(
      JSON.stringify([
        'ids:v1',
        'instagram',
        [
          ['message', 'mid-1'],
          [['comments', null, null], 'comment-1'],
          [['comments', null, null], 'value-id-1'],
          [['messages', null, null], 'value-mid-1'],
        ],
      ]),
    ),
  );
});

test('uses field, value.verb and value.item as the kind of a change event', () => {
  const payload = commentPayload('page', { comment_id: 'c1', verb: 'add', item: 'comment' }, 'feed');

  assert.equal(
    buildEventKey(payload),
    sha256(JSON.stringify(['ids:v1', 'page', [[['feed', 'add', 'comment'], 'c1']]])),
  );
});

test('uses the key-sorted canonical JSON of an event without a platform id as its token', () => {
  const payload: MetaWebhookPayload = {
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'u1' }, postback: { payload: 'GO' } }] }],
  };

  assert.equal(
    buildEventKey(payload),
    sha256(JSON.stringify(['ids:v1', 'page', ['{"postback":{"payload":"GO"},"sender":{"id":"u1"}}']])),
  );
});

test('is stable when the same ids arrive in a different order', () => {
  assert.equal(
    buildEventKey(messagingPayload('m_1', 'm_2', 'm_3')),
    buildEventKey(messagingPayload('m_3', 'm_1', 'm_2')),
  );
});

test('is stable when the same events are spread across entries in a different order', () => {
  const first: MetaWebhookPayload = {
    object: 'page',
    entry: [
      { id: 'p1', messaging: [{ message: { mid: 'm_1' } }] },
      { id: 'p2', messaging: [{ message: { mid: 'm_2' } }] },
    ],
  };
  const second: MetaWebhookPayload = {
    object: 'page',
    entry: [
      { id: 'p2', messaging: [{ message: { mid: 'm_2' } }] },
      { id: 'p1', messaging: [{ message: { mid: 'm_1' } }] },
    ],
  };

  assert.equal(buildEventKey(first), buildEventKey(second));
});

test('is stable when a mixed batch of id and id-less events is reordered', () => {
  const message = { message: { mid: 'm_1' } };
  const postback = { sender: { id: 'u1' }, postback: { payload: 'A' } };
  const read = { sender: { id: 'u1' }, read: { watermark: 5 } };
  const first: MetaWebhookPayload = { object: 'page', entry: [{ messaging: [message, postback, read] }] };
  const second: MetaWebhookPayload = { object: 'page', entry: [{ messaging: [read, postback, message] }] };

  assert.equal(buildEventKey(first), buildEventKey(second));
});

test('gives the same key to an identical payload delivered twice', () => {
  const build = (): MetaWebhookPayload => ({
    object: 'page',
    entry: [{ messaging: [{ message: { mid: 'm_1' } }, { postback: { payload: 'A' } }] }],
  });

  assert.equal(buildEventKey(build()), buildEventKey(build()));
});

test('deduplicates repeated events', () => {
  assert.equal(
    buildEventKey(messagingPayload('m_1', 'm_1', 'm_2')),
    buildEventKey(messagingPayload('m_2', 'm_1')),
  );
});

test('ignores fields outside the event id and kind when an id is present', () => {
  const base = messagingPayload('m_1');
  const withExtras: MetaWebhookPayload = {
    ...base,
    extra: { retry: 2 },
    entry: [{ ...base.entry[0], time: 999, unknown: 'kept' }],
  };

  assert.equal(buildEventKey(withExtras), buildEventKey(base));
});

test('produces different keys for different ids', () => {
  assert.notEqual(buildEventKey(messagingPayload('m_1')), buildEventKey(messagingPayload('m_2')));
  assert.notEqual(
    buildEventKey(messagingPayload('m_1')),
    buildEventKey(messagingPayload('m_1', 'm_2')),
  );
});

test('produces different keys for the same id under a different object', () => {
  const page = messagingPayload('m_1');
  const instagram = { ...messagingPayload('m_1'), object: 'instagram' };

  assert.notEqual(buildEventKey(page), buildEventKey(instagram));
});

test('does not collide when an id contains the old comma separator', () => {
  assert.notEqual(buildEventKey(messagingPayload('a,b')), buildEventKey(messagingPayload('a', 'b')));
});

test('does not collide when object and id contain the old colon separator', () => {
  const first = { ...messagingPayload('b:c'), object: 'a' };
  const second = { ...messagingPayload('c'), object: 'a:b' };

  assert.notEqual(buildEventKey(first), buildEventKey(second));
});

test('does not drop an id-less event that differs while a message id stays the same', () => {
  const build = (postbackPayload: string): MetaWebhookPayload => ({
    object: 'page',
    entry: [
      {
        messaging: [
          { message: { mid: 'm_1' } },
          { sender: { id: 'u1' }, postback: { payload: postbackPayload } },
        ],
      },
    ],
  });

  assert.notEqual(buildEventKey(build('A')), buildEventKey(build('B')));
});

test('separates add and edited changes that share a comment_id', () => {
  const add = commentPayload('instagram', { comment_id: 'c1', verb: 'add' });
  const edited = commentPayload('instagram', { comment_id: 'c1', verb: 'edited' });

  assert.notEqual(buildEventKey(add), buildEventKey(edited));
});

test('separates changes that only differ by field or item', () => {
  const comments = commentPayload('page', { comment_id: 'c1' }, 'comments');
  const feed = commentPayload('page', { comment_id: 'c1' }, 'feed');
  const feedPost = commentPayload('page', { comment_id: 'c1', item: 'post' }, 'feed');
  const feedComment = commentPayload('page', { comment_id: 'c1', item: 'comment' }, 'feed');

  assert.notEqual(buildEventKey(comments), buildEventKey(feed));
  assert.notEqual(buildEventKey(feedPost), buildEventKey(feedComment));
});

test('ignores key order inside id-less events', () => {
  const first: MetaWebhookPayload = {
    object: 'page',
    entry: [{ id: 'p1', time: 1, messaging: [{ sender: { id: 'u1' }, postback: { payload: 'GO' } }] }],
  };
  const second = {
    entry: [{ messaging: [{ postback: { payload: 'GO' }, sender: { id: 'u1' } }], time: 1, id: 'p1' }],
    object: 'page',
  } as MetaWebhookPayload;

  assert.equal(buildEventKey(first), buildEventKey(second));
  assert.match(buildEventKey(first), /^[0-9a-f]{64}$/);
});

test('separates id-less events with different content', () => {
  const build = (watermark: number): MetaWebhookPayload => ({
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'u1' }, read: { watermark } }] }],
  });

  assert.notEqual(buildEventKey(build(1)), buildEventKey(build(2)));
});

test('falls back to the canonical JSON of the payload with the json:v1 domain when no event is recognised', () => {
  const payload = { object: 'page', entry: [{ time: 1, id: 'p1' }] } as MetaWebhookPayload;

  assert.equal(
    buildEventKey(payload),
    sha256(JSON.stringify(['json:v1', '{"entry":[{"id":"p1","time":1}],"object":"page"}'])),
  );
});

test('fallback ignores object key order', () => {
  const first = { object: 'page', entry: [{ id: 'p1', time: 1 }] } as MetaWebhookPayload;
  const second = { entry: [{ time: 1, id: 'p1' }], object: 'page' } as MetaWebhookPayload;

  assert.equal(buildEventKey(first), buildEventKey(second));
});

test('fallback is repeatable and does not depend on time or randomness', () => {
  const payload = { object: 'page', entry: [{ id: 'p1', time: 1 }] } as MetaWebhookPayload;
  const first = buildEventKey(payload);
  const realNow = Date.now;
  const realRandom = Math.random;

  Date.now = () => realNow() + 60_000;
  Math.random = () => 0.123456;
  try {
    assert.equal(buildEventKey(payload), first);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
});

test('fallback produces different keys for different content', () => {
  const first = { object: 'page', entry: [{ id: 'p1', time: 1 }] } as MetaWebhookPayload;
  const second = { object: 'page', entry: [{ id: 'p1', time: 2 }] } as MetaWebhookPayload;

  assert.notEqual(buildEventKey(first), buildEventKey(second));
});

test('fallback keeps array order significant', () => {
  const first = { object: 'page', entry: [{ id: 'p1' }, { id: 'p2' }] } as MetaWebhookPayload;
  const second = { object: 'page', entry: [{ id: 'p2' }, { id: 'p1' }] } as MetaWebhookPayload;

  assert.notEqual(buildEventKey(first), buildEventKey(second));
});

// Tokens are sorted by their JSON-serialised form, where the escaped quote of
// the empty mid sorts after the digit 4.
test('treats empty or non-string ids as missing and tokenises the events by content', () => {
  const payload = {
    object: 'page',
    entry: [{ messaging: [{ message: { mid: '' } }, { message: { mid: 42 } }] }],
  } as unknown as MetaWebhookPayload;

  assert.equal(
    buildEventKey(payload),
    sha256(JSON.stringify(['ids:v1', 'page', ['{"message":{"mid":42}}', '{"message":{"mid":""}}']])),
  );
});

test('falls back to the whole payload when messaging and changes hold no event objects', () => {
  const payload = { object: 'page', entry: [{ messaging: [null, 1], changes: [] }] } as unknown as MetaWebhookPayload;

  assert.equal(
    buildEventKey(payload),
    sha256(JSON.stringify(['json:v1', '{"entry":[{"changes":[],"messaging":[null,1]}],"object":"page"}'])),
  );
});

test('does not throw on malformed payload shapes', () => {
  const malformed = [
    { object: 'page' },
    { object: 'page', entry: null },
    { object: 'page', entry: 'oops' },
    { object: 'page', entry: [null, 1, 'x', { messaging: 'bad', changes: { value: 1 } }] },
    { object: 'page', entry: [{ messaging: [null, { message: null }], changes: [null, { value: null }] }] },
    { entry: [{ messaging: [{ message: { mid: 'm_1' } }] }] },
  ] as unknown as MetaWebhookPayload[];

  for (const payload of malformed) {
    assert.doesNotThrow(() => buildEventKey(payload));
    assert.match(buildEventKey(payload), /^[0-9a-f]{64}$/);
  }
});

test('fallback preserves an own __proto__ key from parsed JSON', () => {
  const withProto = JSON.parse('{"object":"page","entry":[],"__proto__":{"a":1}}') as MetaWebhookPayload;
  const withoutProto = JSON.parse('{"object":"page","entry":[]}') as MetaWebhookPayload;

  assert.notEqual(buildEventKey(withProto), buildEventKey(withoutProto));
});
