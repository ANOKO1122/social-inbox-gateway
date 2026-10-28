import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommentContextClient, orderPulledComments } from './comment-context.js';

const POST = '8000000000000007_800000000000000003';
const CURRENT = '800000000000000003_8000000000000008';

test('loads the post text once and does not list comments', async () => {
  const calls: string[] = [];
  const client = createCommentContextClient({
    graphVersion: 'v26.0',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      assert.equal(url.searchParams.get('access_token'), null);
      assert.equal((init?.headers as Record<string, string>).Authorization?.startsWith('Bearer '), true);
      return new Response(JSON.stringify({
        message: '男士两件套，南瓜图案',
        permalink_url: `https://www.facebook.com/${POST}`,
      }), { status: 200 });
    },
  });

  const view = await client.load({ postId: POST, commentId: CURRENT, accessToken: 'page-token-value' });
  assert.equal(view.status, 'ok');
  assert.equal(view.postText, '男士两件套，南瓜图案');
  assert.equal(view.postUrl, `https://www.facebook.com/${POST}`);
  assert.deepEqual(view.lines, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endsWith('/comments'), false);
});

test('reads only the recent comment page and keeps the token in the header', async () => {
  const calls: string[] = [];
  const client = createCommentContextClient({
    graphVersion: 'v26.0',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      assert.equal(url.searchParams.get('access_token'), null);
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer page-token-value');
      assert.equal(url.pathname, `/v26.0/${POST}/comments`);
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(url.searchParams.get('order'), 'reverse_chronological');
      assert.equal(url.searchParams.get('after'), null);
      return new Response(JSON.stringify({
        data: [{
          id: '800000000000000003_8000000000000008',
          message: 'Jonathan 你好',
          created_time: '2026-10-15T01:00:00+0000',
          parent: { id: POST },
          like_count: 3,
          comment_count: 1,
          message_tags: [{ name: 'Jonathan', offset: 0, length: 8 }],
        }, {
          id: '800000000000000003_999',
          message: '回复',
          created_time: '2026-10-15T02:00:00+0000',
          parent: { id: '800000000000000003_8000000000000008' },
          like_count: 0,
          comment_count: 0,
        }],
        paging: {
          next: `https://graph.facebook.com/v26.0/${POST}/comments?after=abc&access_token=page-token-value`,
        },
      }), { status: 200 });
    },
  });

  const comments = await client.loadThread({ postId: POST, accessToken: 'page-token-value' });
  assert.equal(comments?.length, 2);
  assert.equal(comments?.[0]?.likeCount, 3);
  assert.deepEqual(comments?.[0]?.mentions, [{ name: 'Jonathan', offset: 0, length: 8 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.includes('access_token'), false);
  const ordered = orderPulledComments(comments ?? []);
  assert.deepEqual(ordered.map((item) => [item.depth, item.comment.likeCount]), [[0, 3], [1, 0]]);
});

test('does not return a Graph error body', async () => {
  const client = createCommentContextClient({
    graphVersion: 'v26.0',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'token leaked page-token-value', code: 190 },
    }), { status: 400 }),
  });

  await assert.rejects(
    () => client.load({ postId: POST, commentId: CURRENT, accessToken: 'page-token-value' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'graph_190');
      assert.equal(error.message.includes('page-token-value'), false);
      return true;
    },
  );
});
