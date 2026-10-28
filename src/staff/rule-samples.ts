import type { ChannelDb } from '../connect/channel-repository.js';
import { facebookCommentUrl } from './comment-link.js';
import { RuleValidationError } from './rule-store.js';

const CHANNEL_ID = /^[0-9]{5,32}$/;
const SAMPLE_ID = /^(facebook|instagram):[0-9]{5,32}:[A-Za-z0-9_-]{1,160}$/;

export interface RuleSample {
  id: string;
  eventId?: string;
  platform: 'facebook' | 'instagram';
  channelId: string;
  channelName: string;
  text: string;
  postText: string;
  postId: string | null;
  sourceUrl: string | null;
  occurredAt: string | null;
}

function inputFrom(input: unknown): {
  platform: 'all' | 'facebook' | 'instagram'; channelIds: string[]; excludeIds: string[];
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RuleValidationError('抽取评论的条件不正确。');
  }
  const value = input as Record<string, unknown>;
  const platform = value.platform ?? 'all';
  if (platform !== 'all' && platform !== 'facebook' && platform !== 'instagram') {
    throw new RuleValidationError('抽取评论的平台不正确。');
  }
  const channelIds = value.channelIds ?? [];
  if (!Array.isArray(channelIds) || channelIds.length > 200 ||
      channelIds.some(id => typeof id !== 'string' || !CHANNEL_ID.test(id))) {
    throw new RuleValidationError('主页编号格式不正确，最多选择 200 个主页。');
  }
  const excludeIds = value.excludeIds ?? [];
  if (!Array.isArray(excludeIds) || excludeIds.length > 200 ||
      excludeIds.some(id => typeof id !== 'string' || !SAMPLE_ID.test(id))) {
    throw new RuleValidationError('已抽取评论的编号不正确，最多记录 200 条。');
  }
  return { platform, channelIds: [...new Set(channelIds)], excludeIds: [...new Set(excludeIds)] };
}

function instagramUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port ? url.toString() : null;
  } catch { return null; }
}

function dateFrom(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Public comments only. This reads local data and never calls Meta or executes a rule.
// Cached comments share the platform/channel of their normalized anchor. Prefer the
// latest cache for each post, then normalized events for duplicate comment IDs.
const SAMPLE_SQL = `WITH channels AS MATERIALIZED (
  SELECT external_id AS channel_id, name,
    CASE WHEN kind='instagram' THEN 'instagram' ELSE 'facebook' END AS platform
  FROM meta_channels
  WHERE ($1::text='all' OR kind=CASE WHEN $1='instagram' THEN 'instagram' ELSE 'facebook_page' END)
    AND (cardinality($2::text[])=0 OR external_id=ANY($2))
), caches AS MATERIALIZED (
  SELECT DISTINCT ON (n.platform,n.channel_id,coalesce(cc.post_id,cc.normalized_event_id::text))
    n.platform,n.channel_id,ch.name AS channel_name,cc.post_id,cc.payload,cc.fetched_at
  FROM comment_context cc
  JOIN normalized_events n ON n.id=cc.normalized_event_id AND n.kind='comment'
  JOIN channels ch ON ch.platform=n.platform AND ch.channel_id=n.channel_id
  WHERE jsonb_typeof(cc.payload->'comments')='array'
  ORDER BY n.platform,n.channel_id,coalesce(cc.post_id,cc.normalized_event_id::text),cc.fetched_at DESC
), cache_data AS MATERIALIZED (
  SELECT platform,channel_id,channel_name,post_id,fetched_at,
    payload->>'postText' AS post_text,payload->>'postUrl' AS post_url,payload->'comments' AS comments
  FROM caches
), cached_comments AS (
  SELECT DISTINCT ON (cc.platform,cc.channel_id,c->>'id')
    cc.platform,cc.channel_id,cc.channel_name,c->>'id' AS external_id,
    NULL::uuid AS event_id,c->>'text' AS body,c->>'createdAt' AS occurred_at,
    cc.post_id,cc.post_text,coalesce(c->>'permalinkUrl',cc.post_url) AS post_url
  FROM cache_data cc
  CROSS JOIN LATERAL jsonb_array_elements(cc.comments) c
  WHERE c->>'id' ~ '^[A-Za-z0-9_-]+$' AND char_length(c->>'id')<=160
    AND char_length(c->>'text') BETWEEN 1 AND 4000 AND c->>'text' ~ '[^[:space:]]'
    AND coalesce(c->>'authorId',c->>'senderId',c->'from'->>'id','')<>cc.channel_id
    AND NOT EXISTS (SELECT 1 FROM normalized_events n
      WHERE n.platform=cc.platform AND n.kind='comment' AND n.external_id=c->>'id')
    AND NOT EXISTS (SELECT 1 FROM reply_audit a WHERE a.platform=cc.platform
      AND a.channel_id=cc.channel_id AND a.status='sent' AND a.platform_message_id=c->>'id')
  ORDER BY cc.platform,cc.channel_id,c->>'id',cc.fetched_at DESC
), candidates AS MATERIALIZED (
  SELECT n.platform,n.channel_id,ch.name AS channel_name,n.external_id,n.id AS event_id,
    n.body,n.occurred_at::text,cc.post_id,cc.payload->>'postText' AS post_text,
    cc.payload->>'postUrl' AS post_url
  FROM normalized_events n
  JOIN channels ch ON ch.platform=n.platform AND ch.channel_id=n.channel_id
  LEFT JOIN comment_context cc ON cc.normalized_event_id=n.id
  WHERE n.kind='comment' AND n.sender_id IS DISTINCT FROM n.channel_id
    AND n.external_id ~ '^[A-Za-z0-9_-]+$' AND char_length(n.external_id)<=160
    AND char_length(n.body) BETWEEN 1 AND 4000 AND n.body ~ '[^[:space:]]'
    AND NOT EXISTS (SELECT 1 FROM reply_audit a WHERE a.platform=n.platform
      AND a.channel_id=n.channel_id AND a.status='sent' AND a.platform_message_id=n.external_id)
  UNION ALL SELECT * FROM cached_comments
), chosen AS MATERIALIZED (
  SELECT *,platform||':'||channel_id||':'||external_id AS sample_id,
    (platform||':'||channel_id||':'||external_id)=ANY($3::text[]) AS recycled
  FROM candidates
  ORDER BY recycled ASC,
    ((platform||':'||channel_id||':'||external_id)=coalesce($3[array_length($3,1)],'')) ASC,random()
  LIMIT 1
)
SELECT s.*,coalesce(s.post_id,src.post_id) AS resolved_post_id,
  left(coalesce(nullif(s.post_text,''),post.payload->>'postText',''),2000) AS resolved_post_text,
  coalesce(s.post_url,post.payload->>'postUrl') AS resolved_post_url
FROM chosen s
LEFT JOIN normalized_events n ON n.id=s.event_id
LEFT JOIN LATERAL (
  SELECT CASE WHEN s.platform='instagram' THEN v->'media'->>'id' ELSE v->>'post_id' END AS post_id
  FROM webhook_events w
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w.raw_payload->'entry')='array'
    THEN w.raw_payload->'entry' ELSE '[]'::jsonb END) e
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'changes')='array'
    THEN e->'changes' ELSE '[]'::jsonb END) c
  CROSS JOIN LATERAL (SELECT c->'value' AS v) value
  WHERE w.id=n.webhook_event_id AND
    (CASE WHEN s.platform='instagram' THEN v->>'id' ELSE v->>'comment_id' END)=s.external_id
  LIMIT 1
) src ON s.post_id IS NULL
LEFT JOIN LATERAL (
  SELECT cc.payload FROM comment_context cc
  JOIN normalized_events anchor ON anchor.id=cc.normalized_event_id
    AND anchor.platform=s.platform AND anchor.channel_id=s.channel_id
  WHERE cc.post_id=coalesce(s.post_id,src.post_id)
  ORDER BY cc.fetched_at DESC LIMIT 1
) post ON true`;

export class RuleSamples {
  constructor(private readonly db: Pick<ChannelDb, 'query'>) {}

  async random(input: unknown): Promise<{ sample: RuleSample | null; recycled: boolean }> {
    const scope = inputFrom(input);
    const result = await this.db.query(SAMPLE_SQL, [scope.platform, scope.channelIds, scope.excludeIds]);
    const row = result.rows[0];
    if (!row) return { sample: null, recycled: false };
    const platform = row.platform === 'instagram' ? 'instagram' : 'facebook';
    const postId = typeof row.resolved_post_id === 'string' && /^[0-9]{5,32}(?:_[0-9]{5,32})?$/.test(row.resolved_post_id)
      ? row.resolved_post_id : null;
    const postUrl = typeof row.resolved_post_url === 'string' ? row.resolved_post_url : null;
    return {
      recycled: row.recycled === true,
      sample: {
        id: String(row.sample_id),
        ...(typeof row.event_id === 'string' ? { eventId: row.event_id } : {}),
        platform,
        channelId: String(row.channel_id),
        channelName: String(row.channel_name),
        text: String(row.body),
        postText: String(row.resolved_post_text ?? '').slice(0, 2000),
        postId,
        sourceUrl: platform === 'facebook'
          ? facebookCommentUrl(postUrl, postId, String(row.external_id)) : instagramUrl(postUrl),
        occurredAt: dateFrom(row.occurred_at),
      },
    };
  }
}
