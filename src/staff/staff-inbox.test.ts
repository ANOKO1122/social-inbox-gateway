import assert from 'node:assert/strict';
import test from 'node:test';

import { StaffRepository, groupInbox, orderThread, presentThread, type InboxComment } from './staff-repository.js';
import { formatBeijing } from './beijing-time.js';

function row(input: Partial<InboxComment> & Pick<InboxComment, 'id' | 'occurredAt'>): InboxComment {
  return {
    kind: 'comment',
    channelId: '8000000000000007',
    channelName: '店',
    senderId: '80000000000000011',
    senderName: '安',
    postId: '8000000000000007_800000000000000003',
    parentId: null,
    externalId: input.id,
    body: '你好',
    replyStatus: null,
    replyBody: null,
    replyStaffId: null,
    threadCount: 1,
    postTitle: null,
    ...input,
  };
}

test('formats timestamps in Beijing time', () => {
  assert.equal(formatBeijing(new Date('2026-10-15T03:16:00Z')), '2026-10-15 11:16');
  assert.equal(formatBeijing(new Date('2026-10-15T03:16:00Z'), 'short'), '10-15 11:16');
});

test('groups comments from the same post and keeps private messages apart', () => {
  const older = row({ id: 'a', occurredAt: new Date('2026-10-15T01:00:00Z'), body: '第一楼' });
  const newer = row({ id: 'b', occurredAt: new Date('2026-10-15T02:00:00Z'), senderName: '白', body: '第二楼' });
  const otherPost = row({ id: 'c', occurredAt: new Date('2026-10-15T03:00:00Z'), postId: '8000000000000007_800000000000000013' });
  const message = row({
    id: 'd',
    kind: 'message',
    occurredAt: new Date('2026-10-15T04:00:00Z'),
    postId: null,
    senderName: null,
    body: '私信内容',
  });
  const heads = groupInbox([message, otherPost, newer, older]);
  assert.equal(heads.length, 3);
  assert.equal(heads[0]?.kind, 'message');
  assert.equal(heads[1]?.id, 'c');
  assert.equal(heads[2]?.id, 'b');
  assert.equal(heads[2]?.threadCount, 2);
  assert.equal(heads[2]?.senderName, '白');
});

test('orders a post thread by time and keeps reply names', () => {
  const ordered = orderThread([
    row({ id: 'b', occurredAt: new Date('2026-10-15T02:00:00Z'), senderName: '白', parentId: 'parent-comment' }),
    row({ id: 'a', occurredAt: new Date('2026-10-15T01:00:00Z'), senderName: '安', externalId: 'parent-comment' }),
  ]);
  assert.deepEqual(ordered.map((item) => item.senderName), ['安', '白']);
  const presented = presentThread(ordered);
  assert.equal(presented.notes.get('a')?.depth, 0);
  assert.equal(presented.notes.get('b')?.replyTo, '安');
  assert.equal(presented.notes.get('b')?.depth, 1);
});

test('a reply whose parent id is the root still targets the name at the start', () => {
  const presented = presentThread([
    row({
      id: 'root',
      occurredAt: new Date('2026-10-15T01:00:00Z'),
      senderName: 'Test Author Alpha',
      externalId: 'root',
      body: 'Test Author Beta Please review this sample reply.',
    }),
    row({
      id: 'mid',
      occurredAt: new Date('2026-10-15T02:00:00Z'),
      senderName: 'Test Author Beta',
      externalId: 'mid',
      parentId: 'root',
      body: 'Test Author Alpha Does this synthetic reply read clearly?',
    }),
    row({
      id: 'leaf',
      occurredAt: new Date('2026-10-15T03:00:00Z'),
      senderName: 'Test Author Alpha',
      externalId: 'leaf',
      parentId: 'root',
      body: 'Test Author Beta Yes.',
    }),
    row({
      id: 'newer',
      occurredAt: new Date('2026-10-15T04:00:00Z'),
      senderName: 'Test Author Gamma',
      externalId: 'newer',
      body: 'A separate sample comment.',
    }),
  ]);
  assert.deepEqual(presented.ordered.map((item) => item.id), ['newer', 'root', 'mid', 'leaf']);
  assert.equal(presented.notes.get('mid')?.replyTo, 'Test Author Alpha');
  assert.equal(presented.notes.get('mid')?.text, 'Does this synthetic reply read clearly?');
  assert.equal(presented.notes.get('leaf')?.replyTo, 'Test Author Beta');
  assert.equal(presented.notes.get('leaf')?.depth, 2);
  assert.equal(presented.notes.get('leaf')?.text, 'Yes.');
});


test('imported comments without author IDs remain available in the inbox and detail', async () => {
  const staff = { id: 'staff-id', unionId: 'staff-union', name: 'Admin', role: 'admin' as const };
  for (const senderId of ['', null, undefined, '   ']) {
    const stored = {
      id: '00000000-0000-4000-8000-000000000001', kind: 'comment',
      channel_id: '8000000000000007', sender_id: senderId,
      external_id: '800000000000000003_123456789',
      post_id: '8000000000000007_800000000000000003',
      occurred_at: new Date('2026-10-15T03:16:00Z'), body: 'Imported comment',
    };
    const repo = new StaffRepository({
      async query(sql) {
        return { rows: sql.startsWith('WITH items AS')
          ? [{ items: [stored], total: 1, has_more: false }]
          : [stored] };
      },
      async connect() { throw new Error('Unexpected transaction'); },
    });
    const comments = await repo.listComments(staff);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.senderId, 'unknown');
    assert.equal(comments[0]?.senderName, '未知用户');
    assert.equal((await repo.commentFor(staff, stored.id))?.externalId, stored.external_id);
    stored.kind = 'message';
    assert.equal((await repo.listComments(staff)).length, 0);
    assert.equal(await repo.commentFor(staff, stored.id), null);
    stored.kind = 'comment';
    Object.assign(stored, { sender_name: '已有昵称' });
    assert.equal((await repo.listComments(staff))[0]?.senderName, '已有昵称');
  }
});
