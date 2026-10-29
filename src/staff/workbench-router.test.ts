import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';
import request from 'supertest';

import { openPayload, sealPayload, staffSigningKey } from '../connect/session.js';
import type { GraphReplyClient } from '../meta/reply-client.js';
import type { ReplyStore } from '../meta/reply-router.js';
import { createDingTalkClient } from './dingtalk-client.js';
import type { InboxComment, Staff, StaffStore } from './staff-repository.js';
import { createWorkbenchRouter } from './workbench-router.js';

const TOKEN_KEY = Buffer.from('ab'.repeat(32), 'hex');
const SECRET = 'client-secret-value';
const EVENT_ID = '0de3ba02-8a5f-454d-bad1-81fa98ceb065';

const admin: Staff = {
  id: '11111111-1111-4111-8111-111111111111',
  unionId: 'union-admin-1',
  name: '阿宁',
  role: 'admin',
};
const agent: Staff = {
  id: '22222222-2222-4222-8222-222222222222',
  unionId: 'union-agent-1',
  name: '小林',
  role: 'agent',
};

function comment(): InboxComment {
  return {
    id: EVENT_ID,
    kind: 'comment',
    channelId: '8000000000000007',
    channelName: 'Example Shop',
    senderId: '80000000000000011',
    senderName: null,
    postId: '8000000000000007_800000000000000003',
    parentId: null,
    externalId: '800000000000000003_8000000000000008',
    body: '你好',
    occurredAt: new Date('2026-10-14T09:16:00Z'),
    replyStatus: 'sent',
    replyBody: '只有管理员能看到的回复',
    replyStaffId: admin.id,
    threadCount: 1,
    postTitle: null,
  };
}

function staffStore(current: Staff): StaffStore {
  return {
    async login() {
      return { status: 'ok', staff: current };
    },
    async byUnionId(unionId) {
      return current.unionId === unionId ? current : null;
    },
    async listComments() {
      return [comment()];
    },
    async commentsAfter() {
      return [];
    },
    async commentFor() {
      return comment();
    },
    async openPulledComment(_staff, input) {
      return {
        ...comment(),
        id: '44444444-4444-4444-8444-444444444444',
        externalId: input.externalId,
        senderId: 'unknown',
        senderName: null,
        body: input.body,
        replyStatus: null,
        replyBody: null,
      };
    },
    async threadFor(_staff, item) {
      return [item];
    },
    async beginAudit() {
      return { id: 'audit-1', status: 'pending', platformMessageId: null, errorCode: null };
    },
    async finishAudit() {},
    async listAudit() {
      return [];
    },
    async accounts() {
      return [];
    },
    async knownPages() {
      return [];
    },
    async saveAccess() {},
  };
}

function appFor(
  store: StaffStore,
  replies?: ReplyStore,
  extra?: Partial<Parameters<typeof createWorkbenchRouter>[0]>,
) {
  const app = express();
  app.use('/inbox', createWorkbenchRouter({
    tokenKey: TOKEN_KEY,
    dingtalk: createDingTalkClient({
      clientId: 'dingexampleclientid',
      clientSecret: SECRET,
      redirectUri: 'https://inbox.example.com/inbox/auth/dingtalk/callback',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('userAccessToken')) {
          return new Response(JSON.stringify({ accessToken: 'user-access-token' }), { status: 200 });
        }
        return new Response(JSON.stringify({ unionId: 'union-agent-1', nick: '小林' }), { status: 200 });
      },
    }),
    staff: store,
    replies: replies ?? {
      async claimReply() {
        return { outcome: 'claimed', replyId: 'reply-1' };
      },
      async completeReply() {},
    },
    tokens: { async tokenForChannel() { return 'page-token'; } },
    channelTokens: {},
    client: {
      async send() {
        return { ok: true, platformMessageId: 'mid-1' };
      },
    } satisfies GraphReplyClient,
    ...extra,
  }));
  return app;
}

function cookiePair(setCookie: string | string[] | undefined, name: string): string | undefined {
  const header = Array.isArray(setCookie) ? setCookie.find((item) => item.startsWith(`${name}=`)) : setCookie;
  if (!header?.startsWith(`${name}=`)) {
    return undefined;
  }
  const value = header.split(';')[0]?.slice(name.length + 1);
  return value ? `${name}=${value}` : undefined;
}

test('the Dify gate allows an admin and refuses everyone else', async () => {
  const app = appFor(staffStore(admin));
  const anonymous = await request(app).get('/inbox/auth/dify-gate');
  assert.equal(anonymous.status, 401);

  const adminSession = sealPayload(staffSigningKey(TOKEN_KEY), {
    kind: 'staff',
    exp: Math.floor(Date.now() / 1000) + 60,
    unionId: admin.unionId,
  });
  const allowed = await request(app).get('/inbox/auth/dify-gate').set('Cookie', `sig_staff=${encodeURIComponent(adminSession)}`);
  assert.equal(allowed.status, 204);

  const agentApp = appFor(staffStore(agent));
  const agentSession = sealPayload(staffSigningKey(TOKEN_KEY), {
    kind: 'staff',
    exp: Math.floor(Date.now() / 1000) + 60,
    unionId: agent.unionId,
  });
  const denied = await request(agentApp).get('/inbox/auth/dify-gate').set('Cookie', `sig_staff=${encodeURIComponent(agentSession)}`);
  assert.equal(denied.status, 403);
});

test('anonymous workbench redirects to DingTalk and the URL has no secret', async () => {
  const app = appFor(staffStore(admin));
  const workbench = await request(app).get('/inbox/workbench').redirects(0);
  assert.equal(workbench.status, 303);
  assert.equal(workbench.headers.location, '/inbox/auth/dingtalk/start');

  const start = await request(app).get('/inbox/auth/dingtalk/start').redirects(0);
  assert.equal(start.status, 303);
  assert.match(start.headers.location ?? '', /^https:\/\/login\.dingtalk\.com\/oauth2\/auth\?/);
  assert.equal(String(start.headers.location).includes(SECRET), false);
});

test('an agent does not see another person reply text', async () => {
  const login = await request(appFor(staffStore(agent))).get('/inbox/auth/dingtalk/start').redirects(0);
  const stateHeader = cookiePair(login.headers['set-cookie'], 'sig_staff_state');
  assert.ok(stateHeader);
  const stateToken = decodeURIComponent(stateHeader.slice('sig_staff_state='.length));
  const state = openPayload(staffSigningKey(TOKEN_KEY), stateToken, Math.floor(Date.now() / 1000));
  assert.equal(state?.kind, 'state');
  if (state?.kind !== 'state') {
    return;
  }

  const callback = await request(appFor(staffStore(agent)))
    .get(`/inbox/auth/dingtalk/callback?code=auth-code-value&state=${encodeURIComponent(state.nonce)}`)
    .set('Cookie', stateHeader)
    .redirects(0);
  assert.equal(callback.status, 303);
  const session = cookiePair(callback.headers['set-cookie'], 'sig_staff');
  assert.ok(session);
  assert.match(String(callback.headers['set-cookie']), /Path=\/inbox/);

  const page = await request(appFor(staffStore(agent))).get('/inbox/workbench').set('Cookie', session);
  assert.equal(page.status, 200);
  assert.match(page.text, /你好/);
  assert.equal(page.text.includes('只有管理员能看到的回复'), false);
  assert.match(page.text, /class="floor-state state-sent">已回复</);
});

test('a confirmed reply is audited before the result is shown', async () => {
  const seen: string[] = [];
  const store = staffStore(admin);
  store.beginAudit = async () => {
    seen.push('audit');
    return { id: 'audit-1', status: 'pending', platformMessageId: null, errorCode: null };
  };
  store.finishAudit = async () => {
    seen.push('finish');
  };
  const replies: ReplyStore = {
    async claimReply() {
      seen.push('claim');
      return { outcome: 'claimed', replyId: 'reply-1' };
    },
    async completeReply() {
      seen.push('complete');
    },
  };
  const session = sealPayload(staffSigningKey(TOKEN_KEY), {
    kind: 'staff',
    exp: Math.floor(Date.now() / 1000) + 60,
    unionId: admin.unionId,
  });
  const sent = await request(appFor(store, replies))
    .post('/inbox/workbench/reply')
    .set('Cookie', `sig_staff=${encodeURIComponent(session)}`)
    .type('form')
    .send({ eventId: EVENT_ID, idempotencyKey: 'reply-key-01', text: '谢谢' })
    .redirects(0);
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.location, `/inbox/workbench?event=${EVENT_ID}&notice=sent`);
  assert.deepEqual(seen, ['audit', 'claim', 'complete', 'finish']);
});

test('suggest fills a draft and does not send it', async () => {
  let sent = 0;
  let adopted: string | undefined;
  const store = staffStore(admin);
  const session = sealPayload(staffSigningKey(TOKEN_KEY), {
    kind: 'staff',
    exp: Math.floor(Date.now() / 1000) + 60,
    unionId: admin.unionId,
  });
  const app = appFor(store, undefined, {
    client: {
      async send() {
        sent += 1;
        return { ok: true, platformMessageId: 'mid-1' };
      },
    },
    suggestions: {
      async draft(input) {
        assert.equal(input.text, '你好');
        assert.equal(input.kind, 'comment');
        return {
          intent: 'product',
          suggestedReply: 'Happy to help.',
          needsHuman: true,
          sources: [],
        };
      },
    },
    suggestionStore: {
      async save() {
        return '33333333-3333-4333-8333-333333333333';
      },
      async markAdopted(input) {
        adopted = input.id;
      },
    },
  });
  const page = await request(app).get('/inbox/workbench').set('Cookie', `sig_staff=${encodeURIComponent(session)}`);
  assert.match(page.text, /生成建议/);
  assert.match(page.text, /帖子编号/);
  assert.match(page.text, /8000000000000007_800000000000000003/);
  assert.equal(page.text.includes('<summary>编号</summary>'), false);
  const suggested = await request(app)
    .post('/inbox/workbench/suggest')
    .set('Cookie', `sig_staff=${encodeURIComponent(session)}`)
    .type('form')
    .send({ eventId: EVENT_ID });
  assert.equal(suggested.status, 200);
  assert.equal(suggested.body.suggestedReply, 'Happy to help.');
  assert.equal(suggested.body.needsHuman, true);
  assert.equal(sent, 0);

  const reply = await request(app)
    .post('/inbox/workbench/reply')
    .set('Cookie', `sig_staff=${encodeURIComponent(session)}`)
    .type('form')
    .send({
      eventId: EVENT_ID,
      idempotencyKey: 'reply-key-02',
      text: 'Happy to help.',
      suggestionId: '33333333-3333-4333-8333-333333333333',
    })
    .redirects(0);
  assert.equal(reply.headers.location, `/inbox/workbench?event=${EVENT_ID}&notice=sent`);
  assert.equal(adopted, '33333333-3333-4333-8333-333333333333');
  assert.equal(sent, 1);
});

test('a pulled comment can be answered by its comment id', async () => {
  const store = staffStore(admin);
  const session = sealPayload(staffSigningKey(TOKEN_KEY), {
    kind: 'staff',
    exp: Math.floor(Date.now() / 1000) + 60,
    unionId: admin.unionId,
  });
  let sentTo = '';
  const target = '800000000000000003_99887766';
  const app = appFor(store, undefined, {
    client: {
      async send(input) {
        sentTo = input.externalId;
        return { ok: true, platformMessageId: 'reply-comment-1' };
      },
    },
    contexts: {
      async facts() {
        return { postId: null, senderName: null };
      },
      async cached() {
        return null;
      },
      async cachedPost() {
        return {
          status: 'ok',
          postText: '帖子',
          postUrl: null,
          lines: [],
          comments: [{
            id: target,
            text: '这条没有名字',
            createdAt: '2026-10-15T01:00:00.000Z',
            parentId: null,
            likeCount: 0,
            commentCount: 0,
            mentions: [],
          }],
        };
      },
      async save() {},
    },
  });
  const sent = await request(app)
    .post('/inbox/workbench/reply')
    .set('Cookie', `sig_staff=${encodeURIComponent(session)}`)
    .type('form')
    .send({
      eventId: EVENT_ID,
      targetId: target,
      idempotencyKey: 'reply-key-03',
      text: '收到',
    })
    .redirects(0);
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.location, '/inbox/workbench?event=44444444-4444-4444-8444-444444444444&notice=sent');
  assert.equal(sentTo, target);

  const rejected = await request(app)
    .post('/inbox/workbench/reply')
    .set('Cookie', `sig_staff=${encodeURIComponent(session)}`)
    .type('form')
    .send({
      eventId: EVENT_ID,
      targetId: '800000000000000003_11111111',
      idempotencyKey: 'reply-key-04',
      text: '收到',
    })
    .redirects(0);
  assert.equal(rejected.headers.location, `/inbox/workbench?event=${EVENT_ID}&notice=failed`);
  assert.equal(sentTo, target);
});

test('suggest stays optional when Dify is not configured', async () => {
  const session = sealPayload(staffSigningKey(TOKEN_KEY), {
    kind: 'staff',
    exp: Math.floor(Date.now() / 1000) + 60,
    unionId: admin.unionId,
  });
  const response = await request(appFor(staffStore(admin)))
    .post('/inbox/workbench/suggest')
    .set('Cookie', `sig_staff=${encodeURIComponent(session)}`)
    .type('form')
    .send({ eventId: EVENT_ID });
  assert.equal(response.status, 503);
  assert.match(response.body.message, /手写回复/);
});


test('review counts show each platform total and refresh independently of conversation filters', async () => {
  const store = staffStore(agent);
  let counts = { facebook: 54, instagram: 9 };
  store.pendingReviewCounts = async (staff) => {
    assert.equal(staff.id, agent.id);
    return counts;
  };
  const session = sealPayload(staffSigningKey(TOKEN_KEY), {
    kind: 'staff', unionId: agent.unionId, exp: Math.floor(Date.now() / 1000) + 300,
  });
  const app = appFor(store);
  const page = await request(app).get('/inbox/workbench/instagram').set('Cookie', `sig_staff=${session}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-review-count="facebook"[^>]*> \(54\)<\/span>/);
  assert.match(page.text, /data-review-count="instagram"[^>]*> \(9\)<\/span>/);
  assert.match(page.text, /data-queue-filter="review"[^>]*>待人工审核 \(9\)<\/button>/);
  counts = { facebook: 53, instagram: 0 };
  const queue = await request(app).get('/inbox/workbench/queue?platform=instagram&q=missing&kind=message')
    .set('Cookie', `sig_staff=${session}`);
  assert.equal(queue.status, 200);
  assert.deepEqual(queue.body.reviewCounts, counts);
});
