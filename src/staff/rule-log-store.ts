import type { ChannelDb } from '../connect/channel-repository.js';
import { facebookCommentUrl } from './comment-link.js';
import { RuleValidationError } from './rule-store.js';

export type RuleLogOutcome = 'hidden' | 'already_hidden' | 'review' | 'kept' | 'failed' | 'skipped';

export interface RuleLogItem {
  id: string;
  eventId: string;
  platform: 'facebook' | 'instagram';
  channelId: string;
  channelName: string;
  externalId: string;
  senderName: string | null;
  text: string;
  postText: string;
  occurredAt: string | null;
  processedAt: string | null;
  outcome: RuleLogOutcome;
  decision: 'hide' | 'keep' | 'review' | 'skip';
  reason: string;
  matchedKeywords: string[];
  ruleName: string;
  reviewStatus: 'open' | 'dismissed' | 'resolved';
  reviewedAt: string | null;
  inboxUrl: string;
  sourceUrl: string | null;
  sourceLabel: '定位源评论' | '打开原帖';
}

export interface RuleLogPage {
  rule: { id: string; name: string; enabled: boolean };
  items: RuleLogItem[];
  outcome: 'all' | RuleLogOutcome;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** All completed records attributable to this rule, independent of the outcome filter. */
  summary: { total: number } & Record<RuleLogOutcome, number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES: RuleLogOutcome[] = ['hidden', 'already_hidden', 'review', 'kept', 'failed', 'skipped'];
const PAGE_SIZE = 30;

function dateFrom(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function instagramUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['instagram.com', 'www.instagram.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port ? url.toString() : null;
  } catch { return null; }
}

// rule_ids only records the rules eligible at ingestion; it is not evidence of
// a keyword match. Older runs can only be attributed to their recorded rule_id.
const ATTRIBUTED = `q.status = 'completed' AND (
  q.matched_rule_ids @> ARRAY[$1::uuid]
  OR (cardinality(q.matched_rule_ids) = 0 AND q.rule_id = $1::uuid)
)`;

const PAGE_SQL = `WITH recent AS MATERIALIZED (
  SELECT q.* FROM rule_runs q WHERE ${ATTRIBUTED}
    AND ($2::text = 'all' OR q.outcome = $2)
  ORDER BY q.processed_at DESC, q.id DESC LIMIT $3 OFFSET $4
)
SELECT q.*, n.platform, n.channel_id, n.external_id, n.body, n.occurred_at,
  coalesce(ch.name, n.channel_id) AS channel_name, src.sender_name,
  coalesce(anchor.post_id, src.post_id) AS post_id,
  coalesce(anchor.payload->>'postUrl', post.payload->>'postUrl') AS post_url,
  left(coalesce(nullif(anchor.payload->>'postText', ''), post.payload->>'postText', ''), 2000) AS post_text
FROM recent q
JOIN normalized_events n ON n.id = q.normalized_event_id
LEFT JOIN meta_channels ch ON ch.external_id = n.channel_id
  AND ch.kind = CASE WHEN n.platform = 'instagram' THEN 'instagram' ELSE 'facebook_page' END
LEFT JOIN comment_context anchor ON anchor.normalized_event_id = n.id
LEFT JOIN LATERAL (
  SELECT coalesce(v->'from'->>'name', v->'from'->>'username') AS sender_name,
    CASE WHEN n.platform = 'instagram' THEN v->'media'->>'id' ELSE v->>'post_id' END AS post_id
  FROM webhook_events w
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w.raw_payload->'entry') = 'array'
    THEN w.raw_payload->'entry' ELSE '[]'::jsonb END) e
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'changes') = 'array'
    THEN e->'changes' ELSE '[]'::jsonb END) c
  CROSS JOIN LATERAL (SELECT c->'value' AS v) value
  WHERE w.id = n.webhook_event_id AND
    (CASE WHEN n.platform = 'instagram' THEN v->>'id' ELSE v->>'comment_id' END) = n.external_id
    AND e->>'id' = n.channel_id
  LIMIT 1
) src ON true
LEFT JOIN LATERAL (
  SELECT cc.payload FROM comment_context cc
  JOIN normalized_events cached ON cached.id = cc.normalized_event_id
    AND cached.platform = n.platform AND cached.channel_id = n.channel_id
  WHERE cc.post_id = coalesce(anchor.post_id, src.post_id)
  ORDER BY cc.fetched_at DESC LIMIT 1
) post ON true
ORDER BY q.processed_at DESC, q.id DESC`;

export class RuleLogStore {
  constructor(private readonly db: Pick<ChannelDb, 'query'>) {}

  async list(ruleId: unknown, input: { outcome?: unknown; page?: unknown } = {}): Promise<RuleLogPage | null> {
    if (typeof ruleId !== 'string' || !UUID.test(ruleId)) {
      throw new RuleValidationError('规则编号格式不正确。');
    }
    const outcome = input.outcome ?? 'all';
    if (outcome !== 'all' && !OUTCOMES.includes(outcome as RuleLogOutcome)) {
      throw new RuleValidationError('日志结果筛选不正确。');
    }
    const rawPage = input.page ?? 1;
    if ((typeof rawPage !== 'string' && typeof rawPage !== 'number')
      || !/^[1-9][0-9]{0,5}$/.test(String(rawPage))) {
      throw new RuleValidationError('日志页码不正确。');
    }
    const page = Number(rawPage);
    const rule = (await this.db.query('SELECT id, name, enabled FROM inbox_rules WHERE id = $1', [ruleId])).rows[0];
    if (!rule) return null;
    const counts = await this.db.query(`SELECT q.outcome, count(*)::int AS count
      FROM rule_runs q WHERE ${ATTRIBUTED} GROUP BY q.outcome`, [ruleId]);
    const summary: RuleLogPage['summary'] = { total: 0, hidden: 0, already_hidden: 0, review: 0, kept: 0, failed: 0, skipped: 0 };
    for (const row of counts.rows) {
      if (OUTCOMES.includes(row.outcome as RuleLogOutcome)) {
        summary[row.outcome as RuleLogOutcome] = Number(row.count);
        summary.total += Number(row.count);
      }
    }
    const total = outcome === 'all' ? summary.total : summary[outcome as RuleLogOutcome];
    const rows = await this.db.query(PAGE_SQL, [ruleId, outcome, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
    return {
      rule: { id: String(rule.id), name: String(rule.name), enabled: rule.enabled === true },
      outcome: outcome as RuleLogPage['outcome'], page, pageSize: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE), summary,
      items: rows.rows.map(row => {
        const platform = row.platform === 'instagram' ? 'instagram' : 'facebook';
        const eventId = String(row.normalized_event_id);
        const postUrl = typeof row.post_url === 'string' ? row.post_url : null;
        const postId = typeof row.post_id === 'string' ? row.post_id : null;
        return {
          id: String(row.id), eventId, platform, channelId: String(row.channel_id), channelName: String(row.channel_name),
          externalId: String(row.external_id), senderName: typeof row.sender_name === 'string' ? row.sender_name : null,
          text: typeof row.body === 'string' ? row.body : '', postText: String(row.post_text ?? ''),
          occurredAt: dateFrom(row.occurred_at), processedAt: dateFrom(row.processed_at),
          outcome: row.outcome as RuleLogOutcome, decision: row.decision as RuleLogItem['decision'],
          reason: String(row.reason ?? ''), matchedKeywords: Array.isArray(row.matched_keywords)
            ? row.matched_keywords.filter((word): word is string => typeof word === 'string') : [],
          ruleName: String(row.rule_name ?? rule.name), reviewStatus: row.review_status as RuleLogItem['reviewStatus'],
          reviewedAt: dateFrom(row.reviewed_at), inboxUrl: `/inbox/workbench/${platform}?event=${encodeURIComponent(eventId)}`,
          sourceUrl: platform === 'facebook' ? facebookCommentUrl(postUrl, postId, String(row.external_id)) : instagramUrl(postUrl),
          sourceLabel: platform === 'facebook' ? '定位源评论' : '打开原帖',
        };
      }),
    };
  }
}
