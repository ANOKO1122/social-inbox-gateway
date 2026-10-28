import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuditRow, KnownPage, Staff, StaffAccount } from './staff-repository.js';
import type { InboxComment } from './staff-repository.js';
import { renderAdmin, renderAudit, renderWorkbench } from './workbench-page.js';

const admin: Staff = {
  id: '11111111-1111-4111-8111-111111111111',
  unionId: 'union-admin-1',
  name: '阿宁',
  role: 'admin',
};

const pages: KnownPage[] = [
  { pageId: '8000000000000005', name: 'Example Shop' },
];

const accounts: StaffAccount[] = [
  {
    staff: {
      id: '22222222-2222-4222-8222-222222222222',
      unionId: 'union-agent-1',
      name: '小林',
      role: 'agent',
    },
    disabled: false,
    pageIds: ['8000000000000005'],
  },
];

test('admin assigns pages without dropping the page id', () => {
  const html = renderAdmin({ staff: admin, accounts, pages, nonce: 'nonce-value' });
  assert.match(html, /成员与权限/);
  assert.match(html, /name="pageId" value="8000000000000005" checked/);
  assert.match(html, /aria-label="管理 小林 的权限"/);
  assert.match(html, /保存权限/);
  assert.match(html, /href="\/inbox\/dify\/"/);
  assert.match(html, /知识库/);
  assert.match(html, /在岗/);
  assert.match(html, /data-page-search/);
  assert.match(html, /已分配 1 个主页／账号/);
  assert.match(html, /<dialog class="access-dialog"/);
  assert.match(html, /data-pages="visible"/);
  assert.match(html, /max-height: 16rem/);
  assert.match(html, /href="\/launches"/);
  assert.match(html, /定时发帖（postiz）/);
});

test('audit shows a readable result instead of the raw status', () => {
  const row: AuditRow = {
    id: 'audit-1',
    staffName: '小林',
    staffUnionId: 'union-agent-1',
    channelName: 'Example Shop',
    channelId: '8000000000000005',
    senderId: 'unknown',
    externalId: '800000000000000003_99887766',
    postId: '8000000000000005_800000000000000003',
    commentBody: '原文',
    replyBody: '回复',
    status: 'sent',
    platformMessageId: 'reply-1',
    errorCode: null,
    createdAt: new Date('2026-10-16T08:00:00Z'),
  };
  const html = renderAudit({ staff: admin, rows: [row], nonce: 'nonce-value' });
  assert.match(html, /已发送/);
  assert.match(html, /data-audit="failed"/);
  assert.match(html, /data-status="sent"/);
  const agentHtml = renderAudit({
    staff: { ...admin, role: 'agent' },
    rows: [row],
    nonce: 'nonce-value',
  });
  assert.equal(agentHtml.includes('/inbox/dify/'), false);
  assert.equal(html.includes('>sent<'), false);
  assert.match(html, /没有/);
  assert.match(html, /href="https:\/\/www\.facebook\.com\/8000000000000005_800000000000000003\?comment_id=99887766"/);
});

test('workbench keeps a read post on screen and names the reply target', () => {
  const comment: InboxComment = {
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'comment',
    channelId: '8000000000000005',
    channelName: 'Example Shop',
    senderId: 'sender-1',
    senderName: '小林',
    postId: '8000000000000005_800000000000000004',
    parentId: null,
    externalId: '800000000000000003_99887766',
    body: '这件还有货吗',
    occurredAt: new Date('2026-10-16T08:00:00Z'),
    replyStatus: null,
    replyBody: null,
    replyStaffId: null,
    threadCount: 1,
    postTitle: '秋季上新',
  };
  const html = renderWorkbench({
    staff: admin,
    comments: [comment],
    selected: comment,
    thread: [comment],
    nonce: 'nonce-value',
  });
  assert.match(html, /id="reply-target"/);
  assert.match(html, /id="reply-target" class="reply-target">正在回复 小林</);
  assert.match(html, /data-external="800000000000000003_99887766"/);
  assert.match(html, /data-filter="open"/);
  assert.match(html, /待处理/);
  assert.match(html, /contextCache/);
  assert.match(html, /if \(cached && !quiet\)/);
});
