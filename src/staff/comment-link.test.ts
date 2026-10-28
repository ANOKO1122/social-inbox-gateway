import assert from 'node:assert/strict';
import test from 'node:test';
import { facebookCommentUrl } from './comment-link.js';

test('links a composite comment ID to its reel permalink', () => {
  assert.equal(facebookCommentUrl('https://www.facebook.com/reel/800000000000012/', null, '800000000000012_8000000000000010'),
    'https://www.facebook.com/reel/800000000000012/?comment_id=8000000000000010');
});
test('preserves post query parameters and replaces stale comment targets', () => {
  const url = new URL(facebookCommentUrl('https://www.facebook.com/permalink.php?story_fbid=123&id=456&comment_id=111&reply_comment_id=222#old', null, '333')!);
  assert.equal(url.searchParams.get('story_fbid'), '123');
  assert.equal(url.searchParams.get('id'), '456');
  assert.equal(url.searchParams.get('comment_id'), '333');
  assert.equal(url.searchParams.has('reply_comment_id'), false);
  assert.equal(url.hash, '');
});
test('falls back to post ID and refuses unsafe URLs or malformed comment IDs', () => {
  assert.equal(facebookCommentUrl('https://evil.example/', '123_456', '456_789'), 'https://www.facebook.com/123_456?comment_id=789');
  assert.equal(facebookCommentUrl('javascript:alert(1)', null, '789'), null);
  assert.equal(facebookCommentUrl('https://www.facebook.com@evil.example/', null, '789'), null);
  assert.equal(facebookCommentUrl(null, '123_456', 'bad-id'), null);
});
