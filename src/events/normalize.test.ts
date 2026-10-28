import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeMetaPayload } from './normalize.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('normalizes a top-level Facebook comment', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-comment')), [
    {
      platform: 'facebook',
      kind: 'comment',
      channelId: 'PAGE_ID_1',
      senderId: 'PSID_1',
      externalId: 'COMMENT_ID_1',
      parentId: null,
      text: 'Fake top-level comment',
      occurredAt: '2025-10-09T08:53:21.000Z',
    },
  ]);
});

/** Deep-cloned fixture whose first change `value` is handed to `mutate`. */
function withChangeValue(name: string, mutate: (value: Record<string, unknown>) => void): unknown {
  const payload = fixture(name) as { entry: { changes: { value: Record<string, unknown> }[] }[] };

  mutate(payload.entry[0].changes[0].value);

  return payload;
}

test('Facebook reply keeps the parent comment ID as parentId', () => {
  const [event] = normalizeMetaPayload(fixture('facebook-comment-reply'));

  assert.equal(event.externalId, 'COMMENT_ID_2');
  assert.equal(event.senderId, 'PSID_2');
  assert.equal(event.parentId, 'COMMENT_ID_1');
  assert.equal(event.text, 'Fake reply to a comment');
  assert.equal(event.occurredAt, '2025-10-09T08:53:30.000Z');
});

test('Facebook comment with a missing parent_id is top level', () => {
  const payload = withChangeValue('facebook-comment', (value) => {
    delete value.parent_id;
  });

  assert.equal(normalizeMetaPayload(payload)[0].parentId, null);
});

test('skips Facebook comments written by the page itself (reply-loop guard)', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-comment-by-page')), []);
});

test('skips edited and removed Facebook comments', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-comment-edited')), []);
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-comment-removed')), []);
});

test('skips Facebook feed items that are not comments, and other verbs', () => {
  for (const item of ['post', 'status', 'reaction', 'photo']) {
    const payload = withChangeValue('facebook-comment', (value) => {
      value.item = item;
    });

    assert.deepEqual(normalizeMetaPayload(payload), [], `item: ${item}`);
  }

  for (const verb of ['edited', 'remove', 'hide', 'unhide', 'like']) {
    const payload = withChangeValue('facebook-comment', (value) => {
      value.verb = verb;
    });

    assert.deepEqual(normalizeMetaPayload(payload), [], `verb: ${verb}`);
  }
});

test('skips Facebook changes whose field is not feed', () => {
  const payload = fixture('facebook-comment') as { entry: { changes: { field: string }[] }[] };

  payload.entry[0].changes[0].field = 'mention';

  assert.deepEqual(normalizeMetaPayload(payload), []);
});

test('Facebook comment falls back to entry.time (seconds) when created_time is missing', () => {
  const payload = withChangeValue('facebook-comment', (value) => {
    delete value.created_time;
  });

  assert.equal(normalizeMetaPayload(payload)[0].occurredAt, '2025-10-09T08:53:25.000Z');
});

test('skips a Facebook comment with no usable time instead of using the current time', () => {
  const payload = withChangeValue('facebook-comment', (value) => {
    value.created_time = 'not-a-number';
  }) as { entry: { time?: unknown }[] };

  delete payload.entry[0].time;

  assert.deepEqual(normalizeMetaPayload(payload), []);
});

test('skips Facebook comments missing comment_id or sender', () => {
  const noId = withChangeValue('facebook-comment', (value) => {
    delete value.comment_id;
  });
  const noSender = withChangeValue('facebook-comment', (value) => {
    delete value.from;
  });

  assert.deepEqual(normalizeMetaPayload(noId), []);
  assert.deepEqual(normalizeMetaPayload(noSender), []);
});

test('Facebook comment without message text keeps the event with text null', () => {
  const payload = withChangeValue('facebook-comment', (value) => {
    delete value.message;
  });

  assert.equal(normalizeMetaPayload(payload)[0].text, null);
});

test('normalizes a Facebook private message (timestamp is milliseconds)', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-message')), [
    {
      platform: 'facebook',
      kind: 'message',
      channelId: 'PAGE_ID_1',
      senderId: 'PSID_1',
      externalId: 'MID_FB_1',
      parentId: null,
      text: 'Fake private message',
      occurredAt: '2025-10-09T08:54:10.123Z',
    },
  ]);
});

test('normalizes an Instagram private message (timestamp is milliseconds)', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('instagram-message')), [
    {
      platform: 'instagram',
      kind: 'message',
      channelId: 'IG_ID_1',
      senderId: 'IGSID_1',
      externalId: 'MID_IG_1',
      parentId: null,
      text: 'Fake Instagram direct message',
      occurredAt: '2025-10-09T08:55:30.456Z',
    },
  ]);
});

test('skips echo messages sent by the page itself (reply-loop guard)', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-message-echo')), []);
});

test('skips Facebook echo messages on is_echo alone, whatever the sender id says', () => {
  const payload = fixture('facebook-message-echo') as {
    entry: { messaging: { sender: { id: string } }[] }[];
  };

  payload.entry[0].messaging[0].sender.id = 'SOME_OTHER_ID';

  assert.deepEqual(normalizeMetaPayload(payload), []);
});

test('skips Instagram echo messages too', () => {
  const payload = fixture('instagram-message') as {
    entry: { messaging: { message: Record<string, unknown> }[] }[];
  };

  payload.entry[0].messaging[0].message.is_echo = true;

  assert.deepEqual(normalizeMetaPayload(payload), []);
});

test('keeps a message whose is_echo is false', () => {
  const payload = fixture('facebook-message') as {
    entry: { messaging: { message: Record<string, unknown> }[] }[];
  };

  payload.entry[0].messaging[0].message.is_echo = false;

  assert.equal(normalizeMetaPayload(payload).length, 1);
});

test('skips a message whose sender is the receiving page even without is_echo', () => {
  const payload = fixture('facebook-message') as {
    entry: { messaging: { sender: { id: string } }[] }[];
  };

  payload.entry[0].messaging[0].sender.id = 'PAGE_ID_1';

  assert.deepEqual(normalizeMetaPayload(payload), []);
});

test('skips delivery and read receipts', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-message-delivery')), []);
  assert.deepEqual(normalizeMetaPayload(fixture('facebook-message-read')), []);
});

test('skips postback events and messages without a mid', () => {
  const postback = fixture('facebook-message') as {
    entry: { messaging: Record<string, unknown>[] }[];
  };
  const noMid = fixture('facebook-message') as {
    entry: { messaging: { message: Record<string, unknown> }[] }[];
  };

  postback.entry[0].messaging[0] = {
    sender: { id: 'PSID_1' },
    timestamp: 1760000050123,
    postback: { title: 'Fake button', payload: 'FAKE_PAYLOAD' },
  };
  delete noMid.entry[0].messaging[0].message.mid;

  assert.deepEqual(normalizeMetaPayload(postback), []);
  assert.deepEqual(normalizeMetaPayload(noMid), []);
});

test('keeps an attachment-only message with text null', () => {
  const [event] = normalizeMetaPayload(fixture('facebook-message-attachment-only'));

  assert.equal(event.externalId, 'MID_FB_2');
  assert.equal(event.text, null);
  assert.equal(event.occurredAt, '2025-10-09T08:54:50.123Z');
});

test('skips a message with a missing or invalid timestamp instead of using entry.time or now', () => {
  for (const timestamp of [undefined, 'soon', null, -5]) {
    const payload = fixture('facebook-message') as {
      entry: { messaging: { timestamp?: unknown }[] }[];
    };

    payload.entry[0].messaging[0].timestamp = timestamp;

    assert.deepEqual(normalizeMetaPayload(payload), [], `timestamp: ${String(timestamp)}`);
  }
});

test('skips a message without a sender id', () => {
  const payload = fixture('facebook-message') as {
    entry: { messaging: { sender?: unknown }[] }[];
  };

  delete payload.entry[0].messaging[0].sender;

  assert.deepEqual(normalizeMetaPayload(payload), []);
});

test('normalizes a top-level Instagram comment (time comes from entry.time in seconds)', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('instagram-comment')), [
    {
      platform: 'instagram',
      kind: 'comment',
      channelId: 'IG_ID_1',
      senderId: 'IGSID_1',
      externalId: 'IG_COMMENT_ID_1',
      parentId: null,
      text: 'Fake Instagram comment',
      occurredAt: '2025-10-09T08:55:00.000Z',
    },
  ]);
});

test('Instagram reply keeps parent_id as parentId', () => {
  const [event] = normalizeMetaPayload(fixture('instagram-comment-reply'));

  assert.equal(event.externalId, 'IG_COMMENT_ID_2');
  assert.equal(event.senderId, 'IGSID_2');
  assert.equal(event.parentId, 'IG_COMMENT_ID_1');
  assert.equal(event.text, 'Fake Instagram reply');
  assert.equal(event.occurredAt, '2025-10-09T08:55:10.000Z');
});

test('skips Instagram comments written by the account itself (reply-loop guard)', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('instagram-comment-by-account')), []);
});

test('skips Instagram changes whose field is not comments', () => {
  const payload = fixture('instagram-comment') as { entry: { changes: { field: string }[] }[] };

  payload.entry[0].changes[0].field = 'mentions';

  assert.deepEqual(normalizeMetaPayload(payload), []);
});

test('skips an Instagram comment with missing id, sender or entry.time', () => {
  const cases: Record<string, (payload: { entry: Record<string, any>[] }) => void> = {
    id: (payload) => delete payload.entry[0].changes[0].value.id,
    sender: (payload) => delete payload.entry[0].changes[0].value.from,
    time: (payload) => delete payload.entry[0].time,
  };

  for (const [name, mutate] of Object.entries(cases)) {
    const payload = fixture('instagram-comment') as { entry: Record<string, any>[] };

    mutate(payload);

    assert.deepEqual(normalizeMetaPayload(payload), [], `missing ${name}`);
  }
});

test('Instagram comment without text keeps the event with text null', () => {
  const payload = fixture('instagram-comment') as { entry: { changes: { value: Record<string, unknown> }[] }[] };

  delete payload.entry[0].changes[0].value.text;

  assert.equal(normalizeMetaPayload(payload)[0].text, null);
});

test('the top-level object alone decides the platform', () => {
  const asInstagram = fixture('facebook-comment') as { object: string };
  const asFacebook = fixture('instagram-comment') as { object: string };

  asInstagram.object = 'instagram';
  asFacebook.object = 'page';

  // A feed/comment change is not an Instagram event, and vice versa.
  assert.deepEqual(normalizeMetaPayload(asInstagram), []);
  assert.deepEqual(normalizeMetaPayload(asFacebook), []);
});

test('returns an empty array for unknown objects, including a lookalike change shape', () => {
  assert.deepEqual(normalizeMetaPayload(fixture('unknown-object')), []);

  for (const object of ['user', 'PAGE', 'Instagram', '', undefined, null, 1, {}]) {
    assert.deepEqual(
      normalizeMetaPayload({ object, entry: [{ id: 'PAGE_ID_1', time: 1760000000, changes: [] }] }),
      [],
      `object: ${JSON.stringify(object)}`,
    );
  }
});

test('never throws on garbage input and returns an empty array', () => {
  const garbage: unknown[] = [
    undefined,
    null,
    42,
    'page',
    true,
    [],
    [{ object: 'page' }],
    {},
    { object: 'page' },
    { object: 'page', entry: null },
    { object: 'page', entry: 'x' },
    { object: 'page', entry: {} },
    { object: 'page', entry: [null, 1, 'x', []] },
    { object: 'page', entry: [{}] },
    { object: 'page', entry: [{ id: 'PAGE_ID_1', messaging: 'x', changes: 'y' }] },
    { object: 'page', entry: [{ id: 'PAGE_ID_1', messaging: [null, 1, 'x', []], changes: [null, 1, 'x', []] }] },
    { object: 'page', entry: [{ id: 'PAGE_ID_1', changes: [{ field: 'feed', value: null }] }] },
    { object: 'instagram', entry: [{ id: 'IG_ID_1', changes: [{ field: 'comments', value: 'x' }] }] },
    { object: 'instagram', entry: [{ id: 5, messaging: [{ sender: { id: 'IGSID_1' }, timestamp: 1, message: { mid: 'M' } }] }] },
  ];

  for (const input of garbage) {
    assert.deepEqual(normalizeMetaPayload(input), [], `input: ${JSON.stringify(input)}`);
  }
});

test('a malformed event only drops itself, not the rest of the batch', () => {
  const events = normalizeMetaPayload(fixture('mixed-batch'));

  assert.deepEqual(
    events.map((event) => [event.platform, event.kind, event.channelId, event.senderId, event.externalId]),
    [
      ['facebook', 'message', 'PAGE_ID_1', 'PSID_1', 'MID_FB_MIX_1'],
      ['facebook', 'message', 'PAGE_ID_1', 'PSID_2', 'MID_FB_MIX_2'],
      ['facebook', 'comment', 'PAGE_ID_1', 'PSID_3', 'COMMENT_ID_MIX_1'],
      ['facebook', 'message', 'PAGE_ID_2', 'PSID_4', 'MID_FB_MIX_3'],
    ],
  );
});

test('is deterministic and does not mutate the payload', () => {
  const payload = fixture('mixed-batch');
  const before = JSON.stringify(payload);

  assert.deepEqual(normalizeMetaPayload(payload), normalizeMetaPayload(payload));
  assert.equal(JSON.stringify(payload), before);
});

test('only exposes the NormalizedEvent fields, never the raw payload', () => {
  const [event] = normalizeMetaPayload(fixture('facebook-comment'));

  assert.deepEqual(Object.keys(event).sort(), [
    'channelId',
    'externalId',
    'kind',
    'occurredAt',
    'parentId',
    'platform',
    'senderId',
    'text',
  ]);
});

test('every normalized fixture event has an ISO 8601 UTC occurredAt', () => {
  for (const name of ['facebook-comment', 'facebook-message', 'instagram-comment', 'instagram-message', 'mixed-batch']) {
    for (const event of normalizeMetaPayload(fixture(name))) {
      assert.match(event.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  }
});

test('skips only the event whose timestamp is outside the plausible window', () => {
  const message = (mid: string, timestamp: number) => ({
    sender: { id: 'PSID_1' },
    timestamp,
    message: { mid, text: 'Fake text' },
  });
  const comment = (id: string, createdTime: number) => ({
    field: 'feed',
    value: {
      from: { id: 'PSID_2' },
      item: 'comment',
      verb: 'add',
      comment_id: id,
      post_id: 'POST_ID_1',
      parent_id: 'POST_ID_1',
      created_time: createdTime,
    },
  });
  const igComment = (id: string) => ({
    field: 'comments',
    value: { from: { id: 'IGSID_1' }, id, text: 'Fake text' },
  });

  // Facebook private message: seconds passed where milliseconds are expected, and zero.
  const facebookMessages = normalizeMetaPayload({
    object: 'page',
    entry: [
      {
        id: 'PAGE_ID_1',
        messaging: [
          message('MID_OK_1', 1760000050123),
          message('MID_SECONDS_AS_MS', 1760000050),
          message('MID_ZERO', 0),
          message('MID_OK_2', 1760000060123),
        ],
      },
    ],
  });

  assert.deepEqual(
    facebookMessages.map((event) => event.externalId),
    ['MID_OK_1', 'MID_OK_2'],
  );

  // Facebook comment: milliseconds passed where seconds are expected. An invalid
  // created_time does not fall back to entry.time.
  const facebookComments = normalizeMetaPayload({
    object: 'page',
    entry: [
      {
        id: 'PAGE_ID_1',
        time: 1760000005,
        changes: [comment('COMMENT_OK_1', 1760000001), comment('COMMENT_MS_AS_S', 1760000001123), comment('COMMENT_OK_2', 1760000002)],
      },
    ],
  });

  assert.deepEqual(
    facebookComments.map((event) => event.externalId),
    ['COMMENT_OK_1', 'COMMENT_OK_2'],
  );

  // Instagram comment: entry.time in milliseconds (out of window) drops that entry's comments only.
  const instagramComments = normalizeMetaPayload({
    object: 'instagram',
    entry: [
      { id: 'IG_ID_1', time: 1760000100, changes: [igComment('IG_OK_1')] },
      { id: 'IG_ID_1', time: 1760000100000, changes: [igComment('IG_MS_AS_S')] },
      { id: 'IG_ID_1', time: 1760000200, changes: [igComment('IG_OK_2')] },
    ],
  });

  assert.deepEqual(
    instagramComments.map((event) => event.externalId),
    ['IG_OK_1', 'IG_OK_2'],
  );
});

test('fails closed on is_echo: only undefined, false and null mean "not an echo"', () => {
  const withEcho = (isEcho: unknown, present = true): unknown => {
    const payload = fixture('facebook-message') as {
      entry: { messaging: { message: Record<string, unknown> }[] }[];
    };

    if (present) {
      payload.entry[0].messaging[0].message.is_echo = isEcho;
    }

    return payload;
  };

  for (const isEcho of [true, 'true', 'false', 1, 0, '', {}, []]) {
    assert.deepEqual(normalizeMetaPayload(withEcho(isEcho)), [], `is_echo: ${JSON.stringify(isEcho)}`);
  }

  for (const isEcho of [false, null]) {
    assert.equal(normalizeMetaPayload(withEcho(isEcho)).length, 1, `is_echo: ${JSON.stringify(isEcho)}`);
  }

  assert.equal(normalizeMetaPayload(withEcho(undefined, false)).length, 1, 'is_echo missing');
});

test('fails closed on is_echo for Instagram messages too', () => {
  for (const isEcho of ['true', 'false', 1]) {
    const payload = fixture('instagram-message') as {
      entry: { messaging: { message: Record<string, unknown> }[] }[];
    };

    payload.entry[0].messaging[0].message.is_echo = isEcho;

    assert.deepEqual(normalizeMetaPayload(payload), [], `is_echo: ${JSON.stringify(isEcho)}`);
  }
});

test('skips a Facebook message with a numeric sender.id or message.mid', () => {
  type Messaging = { sender: { id: unknown }; message: { mid: unknown } };

  const numericSender = fixture('facebook-message') as { entry: { messaging: Messaging[] }[] };
  const numericMid = fixture('facebook-message') as { entry: { messaging: Messaging[] }[] };

  numericSender.entry[0].messaging[0].sender.id = 123456789;
  numericMid.entry[0].messaging[0].message.mid = 123456789;

  assert.deepEqual(normalizeMetaPayload(numericSender), []);
  assert.deepEqual(normalizeMetaPayload(numericMid), []);
});

test('skips a Facebook comment with a numeric comment_id or from.id', () => {
  const numericCommentId = withChangeValue('facebook-comment', (value) => {
    value.comment_id = 123456789;
  });
  const numericSender = withChangeValue('facebook-comment', (value) => {
    value.from = { id: 123456789 };
  });

  assert.deepEqual(normalizeMetaPayload(numericCommentId), []);
  assert.deepEqual(normalizeMetaPayload(numericSender), []);
});

test('skips an Instagram comment with a numeric value.id or from.id', () => {
  const numericId = withChangeValue('instagram-comment', (value) => {
    value.id = 123456789;
  });
  const numericSender = withChangeValue('instagram-comment', (value) => {
    value.from = { id: 123456789 };
  });

  assert.deepEqual(normalizeMetaPayload(numericId), []);
  assert.deepEqual(normalizeMetaPayload(numericSender), []);
});

test('skips an Instagram message whose sender is the account itself even without is_echo', () => {
  const payload = fixture('instagram-message') as {
    entry: { messaging: { sender: { id: string }; message: Record<string, unknown> }[] }[];
  };

  payload.entry[0].messaging[0].sender.id = 'IG_ID_1';

  assert.equal(payload.entry[0].messaging[0].message.is_echo, undefined);
  assert.deepEqual(normalizeMetaPayload(payload), []);
});
