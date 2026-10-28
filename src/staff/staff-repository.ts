import type { ChannelDb } from '../connect/channel-repository.js';
import { UPSERT_REVISION_SQL } from '../events/official-sync.js';

const UNION_ID = /^[A-Za-z0-9_-]{4,128}$/;
const PAGE_ID = /^[0-9]{5,32}$/;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;
const POST_ID = /^[0-9]{5,32}(?:_[0-9]{5,32})?$/;
const COMMENT_ID = /^[0-9_]{8,80}$/;
const SENDER_ID = /^[0-9]{5,32}$/;
const UNKNOWN_SENDER = 'unknown';

export interface Staff {
  id: string;
  unionId: string;
  name: string;
  role: 'admin' | 'agent';
}

export interface PulledCommentInput {
  channelId: string;
  postId: string;
  externalId: string;
  parentId: string | null;
  body: string;
  occurredAt: Date;
}

export type InboxQueue = 'all' | 'review' | 'rule_hidden' | 'dismissed';

export interface InboxPageOptions {
  q?: string;
  kind?: 'all' | 'comment' | 'message';
  state?: 'all' | 'open';
  cursor?: string;
  through?: string;
}

export interface InboxPage {
  rows: InboxComment[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  endCursor: string | null;
}

export class InboxPageValidationError extends Error {}

type InboxCursor = { time: string; id: string };

function decodeInboxCursor(value: string): InboxCursor {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InboxPageValidationError('invalid_cursor');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new InboxPageValidationError('invalid_cursor'); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(parsed[0])
    || typeof parsed[1] !== 'string' || !EVENT_ID.test(parsed[1])) throw new InboxPageValidationError('invalid_cursor');
  const date = new Date(parsed[0]);
  if (parsed[0].startsWith('0000-') || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== parsed[0].slice(0, 19)) {
    throw new InboxPageValidationError('invalid_cursor');
  }
  return { time: parsed[0], id: parsed[1] };
}

function encodeInboxCursor(row: Record<string, unknown> | undefined): string | null {
  return row && typeof row.cursor_time === 'string' && typeof row.id === 'string'
    ? Buffer.from(JSON.stringify([row.cursor_time, row.id])).toString('base64url') : null;
}

export function inboxPageOptions(input: Record<string, unknown>, ignoreCursors = false): InboxPageOptions {
  if (input.q !== undefined && (typeof input.q !== 'string' || input.q.length > 200 || input.q.includes('\u0000'))) {
    throw new InboxPageValidationError('invalid_search');
  }
  if (input.kind !== undefined && input.kind !== 'all' && input.kind !== 'comment' && input.kind !== 'message') {
    throw new InboxPageValidationError('invalid_kind');
  }
  if (input.state !== undefined && input.state !== 'all' && input.state !== 'open') {
    throw new InboxPageValidationError('invalid_state');
  }
  const result: InboxPageOptions = { q: typeof input.q === 'string' ? input.q.trim() : '',
    kind: input.kind ?? 'all', state: input.state ?? 'all' };
  if (!ignoreCursors) {
    for (const key of ['cursor', 'through'] as const) {
      const value = input[key];
      if (value !== undefined) {
        if (typeof value !== 'string') throw new InboxPageValidationError('invalid_cursor');
        decodeInboxCursor(value);
        result[key] = value;
      }
    }
    if (result.cursor && result.through) throw new InboxPageValidationError('conflicting_cursors');
  }
  return result;
}

export interface RuleReview {
  ruleName: string;
  reason: string;
  decision: string;
  outcome: string;
  status: 'open' | 'dismissed' | 'resolved';
  reviewedAt?: Date;
}

export interface InboxComment {
  ruleReview?: RuleReview;
  platform?: 'facebook' | 'instagram';
  hidden?: boolean;
  deleted?: boolean;
  reaction?: string;
  adSource?: boolean;
  isOwn?: boolean;
  operatorName?: string;
  pendingCount?: number;
  sentReplies?: { id: string; body: string; staffName: string; occurredAt: Date; deleted?: boolean }[];
  id: string;
  kind: 'comment' | 'message';
  channelId: string;
  channelName: string;
  senderId: string;
  senderName: string | null;
  postId: string | null;
  parentId: string | null;
  externalId: string;
  body: string;
  occurredAt: Date;
  replyStatus: 'pending' | 'sent' | 'failed' | null;
  replyBody: string | null;
  replyStaffId: string | null;
  threadCount: number;
  postTitle: string | null;
}

export interface AuditRow {
  action?: 'hide' | 'show' | 'like' | 'unlike' | 'delete' | 'block' | 'unblock';
  platform?: 'facebook' | 'instagram';
  eventId?: string;
  kind?: 'comment' | 'message';
  postId?: string | null;
  postUrl?: string | null;
  parentId?: string | null;
  id: string;
  staffName: string;
  staffUnionId: string;
  channelName: string;
  channelId: string;
  senderId: string;
  externalId: string;
  commentBody: string;
  replyBody: string;
  status: string;
  platformMessageId: string | null;
  errorCode: string | null;
  createdAt: Date;
}

export interface StaffAccount {
  staff: Staff;
  disabled: boolean;
  pageIds: string[];
}

export interface KnownPage {
  platform?: 'facebook' | 'instagram';
  pageId: string;
  name: string;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface StaffStore {
  saveReaction?(staff: Staff, comment: InboxComment, reaction: string): Promise<void>;
  saveVisibility?(comment: InboxComment, hidden: boolean, observedAt?: Date): Promise<void>;
  saveDeleted?(comment: InboxComment, observedAt?: Date): Promise<void>;
  recordModeration?(staff: Staff, comment: InboxComment, hidden: boolean, errorCode?: string): Promise<void>;
  listModeration?(staff: Staff): Promise<AuditRow[]>;
  login(unionId: string, name: string): Promise<{ status: 'ok'; staff: Staff } | { status: 'disabled' }>;
  byUnionId(unionId: string): Promise<Staff | null>;
  listComments(staff: Staff, platform?: 'facebook' | 'instagram', source?: string, queue?: InboxQueue): Promise<InboxComment[]>;
  listInboxPage?(staff: Staff, platform?: 'facebook' | 'instagram', source?: string, queue?: InboxQueue, options?: InboxPageOptions): Promise<InboxPage>;
  resolveReview?(staff: Staff, eventId: string): Promise<'dismissed' | 'not_found' | 'not_open'>;
  commentsAfter(staff: Staff, since: Date): Promise<InboxComment[]>;
  commentFor(staff: Staff, eventId: string): Promise<InboxComment | null>;
  openPulledComment(staff: Staff, input: PulledCommentInput): Promise<InboxComment | null>;
  threadFor(staff: Staff, item: InboxComment): Promise<InboxComment[]>;
  beginAudit(input: {
    staff: Staff;
    comment: InboxComment;
    replyBody: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: 'pending' | 'sent' | 'failed'; platformMessageId: string | null; errorCode: string | null } | { conflict: true }>;
  finishAudit(id: string, result: { status: 'sent'; platformMessageId: string } | { status: 'failed'; errorCode: string }): Promise<void>;
  listAudit(staff: Staff): Promise<AuditRow[]>;
  accounts(): Promise<StaffAccount[]>;
  knownPages(): Promise<KnownPage[]>;
  saveAccess(input: { actor: Staff; staffId: string; role: 'admin' | 'agent'; disabled: boolean; pageIds: string[] }): Promise<void>;
}

export class StaffRepository implements StaffStore {
  constructor(private readonly db: ChannelDb) {}

  async login(unionId: string, name: string): Promise<{ status: 'ok'; staff: Staff } | { status: 'disabled' }> {
    if (!UNION_ID.test(unionId)) {
      throw new Error('invalid_staff');
    }
    const client = await this.db.connect();
    let rollbackError: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE staff_users IN EXCLUSIVE MODE');
      const existing = await client.query(
        `SELECT id, dingtalk_union_id, display_name, role, disabled_at
         FROM staff_users WHERE dingtalk_union_id = $1`,
        [unionId],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.disabled_at) {
          await client.query('COMMIT');
          return { status: 'disabled' };
        }
        await client.query(
          `UPDATE staff_users SET display_name = $2, updated_at = now() WHERE id = $1`,
          [row.id, name],
        );
        await client.query('COMMIT');
        return { status: 'ok', staff: staffFrom(row, name) };
      }
      const count = await client.query('SELECT count(*)::int AS total FROM staff_users');
      const role = Number(count.rows[0]?.total ?? 0) === 0 ? 'admin' : 'agent';
      const inserted = await client.query(
        `INSERT INTO staff_users (dingtalk_union_id, display_name, role)
         VALUES ($1, $2, $3)
         RETURNING id, dingtalk_union_id, display_name, role`,
        [unionId, name, role],
      );
      await client.query('COMMIT');
      return { status: 'ok', staff: staffFrom(inserted.rows[0], name) };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure : new Error('rollback');
      }
      throw error;
    } finally {
      client.release(rollbackError);
    }
  }

  async byUnionId(unionId: string): Promise<Staff | null> {
    if (!UNION_ID.test(unionId)) {
      return null;
    }
    const result = await this.db.query(
      `SELECT id, dingtalk_union_id, display_name, role
       FROM staff_users
       WHERE dingtalk_union_id = $1 AND disabled_at IS NULL`,
      [unionId],
    );
    const row = result.rows[0];
    return row ? staffFrom(row, text(row.display_name) ?? '钉钉用户') : null;
  }

  async listComments(staff: Staff, platform?: 'facebook' | 'instagram', source?: string, queue: InboxQueue = 'all'): Promise<InboxComment[]> {
    return (await this.listInboxPage(staff, platform, source, queue)).rows;
  }

  async listInboxPage(staff: Staff, platform?: 'facebook' | 'instagram', source?: string, queue: InboxQueue = 'all', options: InboxPageOptions = {}): Promise<InboxPage> {
    const filters = inboxPageOptions({ ...options });
    const cursor = filters.cursor ? decodeInboxCursor(filters.cursor) : null;
    const through = filters.through ? decodeInboxCursor(filters.through) : null;
    const result = await this.db.query(`WITH items AS (${commentSql("AND ($3::text IS NULL OR n.platform = $3) AND ($4 = 'all' OR ($4 = 'ads' AND n.kind = 'message' AND ads.sender_id IS NOT NULL) OR ($4 = 'unknown' AND (n.kind <> 'message' OR ads.sender_id IS NULL))) AND ($5 = 'all' OR ($5 = 'review' AND run.decision = 'review' AND run.review_status = 'open' AND revision.deleted IS NOT TRUE AND sent.has_live IS NOT TRUE) OR ($5 = 'rule_hidden' AND run.outcome = 'hidden' AND visibility.hidden IS TRUE) OR ($5 = 'dismissed' AND run.review_status = 'dismissed')) AND ($7 = 'all' OR n.kind = $7)")}), ranked AS (
      SELECT *, count(*) OVER thread AS thread_count,
        count(*) FILTER (WHERE reply_status IS DISTINCT FROM 'sent' AND hidden IS NOT TRUE AND deleted IS NOT TRUE AND review_status IS DISTINCT FROM 'dismissed') OVER thread AS pending_count,
        bool_or($6 = '' OR position(lower($6) IN lower(concat_ws(' ', channel_name, channel_id,
          sender_name, sender_id, post_text, post_id, external_id, body))) > 0) OVER thread AS search_matches,
        row_number() OVER (PARTITION BY platform, kind, channel_id,
          CASE WHEN kind = 'message' THEN sender_id ELSE coalesce(post_id, id::text) END
          ORDER BY occurred_at DESC, id DESC) AS position
      FROM items WHERE NOT is_own
      WINDOW thread AS (PARTITION BY platform, kind, channel_id,
        CASE WHEN kind = 'message' THEN sender_id ELSE coalesce(post_id, id::text) END)
    ), threads AS (
      SELECT * FROM ranked WHERE position = 1 AND search_matches AND ($8 = 'all' OR pending_count > 0)
    ), eligible AS (
      SELECT * FROM threads WHERE $9::timestamptz IS NULL OR (occurred_at, id) < ($9::timestamptz, $10::uuid)
    ), page_size AS (
      SELECT CASE WHEN $11::timestamptz IS NULL THEN 50 ELSE greatest(50,
        count(*) FILTER (WHERE (occurred_at, id) >= ($11::timestamptz, $12::uuid))) END AS size FROM eligible
    ), candidates AS (
      SELECT * FROM eligible ORDER BY occurred_at DESC, id DESC LIMIT (SELECT size + 1 FROM page_size)
    ), visible AS (
      SELECT *, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM candidates ORDER BY occurred_at DESC, id DESC LIMIT (SELECT size FROM page_size)
    ) SELECT (SELECT count(*)::int FROM threads) AS total,
      (SELECT count(*) FROM candidates) > (SELECT size FROM page_size) AS has_more,
      coalesce((SELECT jsonb_agg(to_jsonb(visible) ORDER BY occurred_at DESC, id DESC) FROM visible), '[]'::jsonb) AS items`, [
      staff.role === 'admin', staff.id, platform ?? null, ['ads','unknown'].includes(source ?? '') ? source : 'all',
      ['review', 'rule_hidden', 'dismissed'].includes(queue) ? queue : 'all', filters.q, filters.kind, filters.state,
      cursor?.time ?? null, cursor?.id ?? null, through?.time ?? null, through?.id ?? null,
    ]);
    const envelope = result.rows[0];
    const items: Record<string, unknown>[] = Array.isArray(envelope?.items) ? envelope.items : [];
    const rows = items.map(commentFrom).filter((row): row is InboxComment => row !== null);
    const hasMore = envelope?.has_more === true;
    const endCursor = encodeInboxCursor(items.at(-1));
    return { rows, total: Number(envelope?.total ?? 0), hasMore, endCursor, nextCursor: hasMore ? endCursor : null };
  }

  async commentsAfter(staff: Staff, since: Date): Promise<InboxComment[]> {
    const result = await this.db.query(
      commentSql('AND n.occurred_at > $3 ORDER BY n.occurred_at ASC LIMIT 50'),
      [staff.role === 'admin', staff.id, since],
    );
    return result.rows.map(commentFrom).filter((row): row is InboxComment => row !== null);
  }

  async commentFor(staff: Staff, eventId: string): Promise<InboxComment | null> {
    if (!EVENT_ID.test(eventId)) {
      return null;
    }
    const result = await this.db.query(
      commentSql('AND n.id = $3 LIMIT 1'),
      [staff.role === 'admin', staff.id, eventId],
    );
    const row = result.rows[0];
    return row ? commentFrom(row) : null;
  }

  async resolveReview(staff: Staff, eventId: string): Promise<'dismissed' | 'not_found' | 'not_open'> {
    if (!EVENT_ID.test(eventId)) return 'not_found';
    const result = await this.db.query(`WITH permitted AS (
      SELECT r.id, r.review_status,
        (EXISTS (SELECT 1 FROM comment_revisions revision WHERE revision.platform = n.platform
          AND revision.channel_id = n.channel_id AND revision.external_id = n.external_id AND revision.deleted)
        OR EXISTS (SELECT 1 FROM reply_audit audit
          LEFT JOIN comment_revisions revision ON revision.platform = audit.platform
            AND revision.channel_id = audit.channel_id AND revision.external_id = audit.platform_message_id
          WHERE audit.normalized_event_id = n.id AND audit.status = 'sent' AND audit.platform_message_id IS NOT NULL
            AND revision.deleted IS NOT TRUE)
        OR EXISTS (SELECT 1 FROM official_replies official
          LEFT JOIN comment_revisions revision ON revision.platform = official.platform
            AND revision.channel_id = official.channel_id AND revision.external_id = official.external_id
          WHERE official.platform = n.platform AND official.kind = 'comment' AND official.channel_id = n.channel_id
            AND official.parent_id = n.external_id AND revision.deleted IS NOT TRUE)) AS handled
      FROM rule_runs r
      JOIN normalized_events n ON n.id = r.normalized_event_id
      WHERE n.id = $1 AND r.status = 'completed' AND r.decision = 'review'
        AND ($2::boolean OR n.channel_id IN (SELECT page_id FROM staff_page_access WHERE staff_user_id = $3))
    ), changed AS (
      UPDATE rule_runs SET review_status = 'dismissed',
        reviewed_at = CASE WHEN review_status = 'open' THEN now() ELSE reviewed_at END,
        reviewed_by = CASE WHEN review_status = 'open' THEN $3 ELSE reviewed_by END
      WHERE id IN (SELECT id FROM permitted WHERE NOT handled OR review_status = 'dismissed')
        AND review_status IN ('open', 'dismissed')
      RETURNING id
    ) SELECT CASE WHEN EXISTS (SELECT 1 FROM changed) OR EXISTS (
      SELECT 1 FROM permitted WHERE review_status = 'dismissed'
    ) THEN 'dismissed' WHEN EXISTS (SELECT 1 FROM permitted) THEN 'not_open' ELSE 'not_found' END AS result`,
    [eventId, staff.role === 'admin', staff.id]);
    return result.rows[0]?.result === 'dismissed' ? 'dismissed'
      : result.rows[0]?.result === 'not_open' ? 'not_open' : 'not_found';
  }

  async openPulledComment(staff: Staff, input: PulledCommentInput): Promise<InboxComment | null> {
    const parentId = input.parentId && input.parentId !== input.postId && COMMENT_ID.test(input.parentId)
      ? input.parentId
      : null;
    if (!PAGE_ID.test(input.channelId) || !POST_ID.test(input.postId) || !COMMENT_ID.test(input.externalId) || Number.isNaN(input.occurredAt.getTime())) {
      return null;
    }
    const existing = await this.commentByExternal(staff, input.externalId);
    if (existing) {
      return existing;
    }
    const body = input.body.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 8000);
    const payload = {
      object: 'page',
      entry: [{
        id: input.channelId,
        changes: [{
          field: 'feed',
          value: {
            item: 'comment',
            verb: 'add',
            comment_id: input.externalId,
            post_id: input.postId,
            message: body,
            created_time: Math.floor(input.occurredAt.getTime() / 1000),
          },
        }],
      }],
    };
    const client = await this.db.connect();
    let rollbackError: Error | undefined;
    try {
      await client.query('BEGIN');
      const raw = await client.query(
        `INSERT INTO webhook_events (platform_object, event_key, raw_payload, ingest_source)
         VALUES ('page', $1, $2::jsonb, 'api_pull')
         ON CONFLICT (event_key) DO NOTHING
         RETURNING id`,
        [`pulled:facebook:comment:${input.externalId}`, JSON.stringify(payload)],
      );
      const rawId = text(raw.rows[0]?.id) ?? text((await client.query(
        'SELECT id FROM webhook_events WHERE event_key = $1',
        [`pulled:facebook:comment:${input.externalId}`],
      )).rows[0]?.id);
      if (!rawId) {
        throw new Error('pulled_comment_raw_missing');
      }
      await client.query(
        `INSERT INTO normalized_events (
           webhook_event_id, platform, kind, channel_id, sender_id, external_id, parent_id, body, occurred_at,
           ingest_source, rule_eligible
         ) VALUES ($1, 'facebook', 'comment', $2, $3, $4, $5, $6, $7, 'api_pull', false)
         ON CONFLICT (platform, kind, external_id) DO NOTHING`,
        [rawId, input.channelId, UNKNOWN_SENDER, input.externalId, parentId, body, input.occurredAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure : new Error('rollback');
      }
      throw error;
    } finally {
      client.release(rollbackError);
    }
    return this.commentByExternal(staff, input.externalId);
  }

  private async commentByExternal(staff: Staff, externalId: string): Promise<InboxComment | null> {
    if (!COMMENT_ID.test(externalId)) {
      return null;
    }
    const result = await this.db.query(
      commentSql(`AND n.kind = 'comment' AND n.external_id = $3 LIMIT 1`),
      [staff.role === 'admin', staff.id, externalId],
    );
    const row = result.rows[0];
    return row ? commentFrom(row) : null;
  }

  async threadFor(staff: Staff, item: InboxComment): Promise<InboxComment[]> {
    const admin = staff.role === 'admin';
    if (item.kind === 'message' && PAGE_ID.test(item.channelId) && SENDER_ID.test(item.senderId)) {
      const result = await this.db.query(
        commentSql(`AND n.kind = 'message' AND n.channel_id = $3 AND n.sender_id = $4 AND n.platform = $5 ORDER BY n.occurred_at ASC, n.id ASC`),
        [admin, staff.id, item.channelId, item.senderId, item.platform ?? 'facebook'],
      );
      return this.withOfficialReplies(staff, item, withSentReplies(result.rows.map(commentFrom).filter((row): row is InboxComment => row !== null)));
    }
    if (item.kind === 'comment' && item.postId && PAGE_ID.test(item.channelId) && POST_ID.test(item.postId)) {
      const result = await this.db.query(
        commentSql(`AND n.kind = 'comment' AND n.channel_id = $3 AND src.post_id = $4 AND n.platform = $5 ORDER BY n.occurred_at ASC, n.id ASC`),
        [admin, staff.id, item.channelId, item.postId, item.platform ?? 'facebook'],
      );
      return this.withOfficialReplies(staff, item, withSentReplies(result.rows.map(commentFrom).filter((row): row is InboxComment => row !== null)));
    }
    return this.withOfficialReplies(staff, item, withSentReplies([item]));
  }

  private async withOfficialReplies(staff: Staff, item: InboxComment, rows: InboxComment[]): Promise<InboxComment[]> {
    const result = await this.db.query(`SELECT o.*, coalesce(revision.body, o.body, '') AS current_body,
        coalesce(revision.deleted, false) AS deleted
      FROM official_replies o LEFT JOIN comment_revisions revision ON o.kind = 'comment'
        AND revision.platform = o.platform AND revision.channel_id = o.channel_id AND revision.external_id = o.external_id
      WHERE o.platform = $1 AND o.channel_id = $2 AND o.kind = $3
        AND ($4::boolean OR o.channel_id IN (SELECT page_id FROM staff_page_access WHERE staff_user_id = $5))
        AND (($3 = 'message' AND o.recipient_id = $6) OR ($3 = 'comment'
          AND (($7::text IS NOT NULL AND o.post_id = $7) OR o.parent_id = ANY($8::text[]))))
      ORDER BY o.occurred_at, o.external_id`, [item.platform ?? 'facebook', item.channelId, item.kind,
      staff.role === 'admin', staff.id, item.senderId, item.postId, rows.map((row) => row.externalId)]);
    const existing = new Set(rows.map((row) => row.externalId));
    for (const row of result.rows) {
      const externalId = text(row.external_id), occurredAt = asDate(row.occurred_at);
      if (!externalId || !occurredAt || existing.has(externalId)) continue;
      existing.add(externalId);
      rows.push({ ...item, id: `reply:${externalId}`, externalId, occurredAt,
        parentId: text(row.parent_id) ?? null, postId: text(row.post_id) ?? item.postId,
        senderId: item.channelId, senderName: item.channelName, body: String(row.current_body ?? ''),
        deleted: row.deleted === true, isOwn: true, operatorName: '官方客户端', hidden: undefined,
        reaction: undefined, ruleReview: undefined, replyStatus: null, replyBody: null, replyStaffId: null,
        sentReplies: [], pendingCount: undefined });
    }
    return orderThread(rows);
  }

  async saveDeleted(comment: InboxComment, observedAt = new Date()): Promise<void> {
    if (comment.kind !== 'comment') return;
    await this.db.query(UPSERT_REVISION_SQL, [comment.platform ?? 'facebook', comment.channelId,
      comment.externalId, null, true, observedAt]);
  }

  async beginAudit(input: {
    staff: Staff;
    comment: InboxComment;
    replyBody: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: 'pending' | 'sent' | 'failed'; platformMessageId: string | null; errorCode: string | null } | { conflict: true }> {
    const inserted = await this.db.query(
      `INSERT INTO reply_audit (
         staff_user_id, staff_union_id, staff_name, normalized_event_id, platform,
         channel_id, channel_name, external_id, sender_id, comment_body, reply_body,
         idempotency_key, status
       ) VALUES ($1,$2,$3,$4,$12,$5,$6,$7,$8,$9,$10,$11,'pending')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, status, platform_message_id, error_code`,
      [
        input.staff.id,
        input.staff.unionId,
        input.staff.name,
        input.comment.id,
        input.comment.channelId,
        input.comment.channelName,
        input.comment.externalId,
        input.comment.senderId,
        input.comment.body,
        input.replyBody,
        input.idempotencyKey,
        input.comment.platform ?? 'facebook',
      ],
    );
    const row = inserted.rows[0] ?? (await this.db.query(
      `SELECT id, status, platform_message_id, error_code, staff_user_id, normalized_event_id
       FROM reply_audit WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    )).rows[0];
    if (!row || row.staff_user_id && row.staff_user_id !== input.staff.id) {
      return { conflict: true };
    }
    if (row.normalized_event_id && row.normalized_event_id !== input.comment.id) {
      return { conflict: true };
    }
    const status = row.status === 'sent' || row.status === 'failed' || row.status === 'pending' ? row.status : 'pending';
    return {
      id: String(row.id),
      status,
      platformMessageId: text(row.platform_message_id) ?? null,
      errorCode: text(row.error_code) ?? null,
    };
  }

  async finishAudit(id: string, result: { status: 'sent'; platformMessageId: string } | { status: 'failed'; errorCode: string }): Promise<void> {
    const errorCode = result.status === 'failed' && SAFE_CODE.test(result.errorCode) ? result.errorCode : result.status === 'failed' ? 'graph_error' : null;
    await this.db.query(
      `WITH sent AS (
        UPDATE reply_audit
        SET status = $2, platform_message_id = $3, error_code = $4, updated_at = now()
        WHERE id = $1 RETURNING normalized_event_id, staff_user_id, status
      ) UPDATE rule_runs r SET review_status = 'resolved', reviewed_at = now(), reviewed_by = sent.staff_user_id
        FROM sent WHERE r.normalized_event_id = sent.normalized_event_id AND sent.status = 'sent'
          AND r.status = 'completed' AND r.decision = 'review' AND r.review_status = 'open'`,
      [id, result.status, result.status === 'sent' ? result.platformMessageId : null, errorCode],
    );
  }

  async listAudit(staff: Staff): Promise<AuditRow[]> {
    const result = await this.db.query(
      `SELECT a.*, n.kind AS event_kind, n.parent_id, src.post_id, ctx.payload->>'postUrl' AS post_url
       FROM reply_audit a
       LEFT JOIN normalized_events n ON n.id = a.normalized_event_id
       LEFT JOIN LATERAL (
         SELECT CASE WHEN a.platform = 'instagram' THEN v->'media'->>'id' ELSE v->>'post_id' END AS post_id
         FROM webhook_events w
         CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.raw_payload->'entry', '[]'::jsonb)) e
         CROSS JOIN LATERAL jsonb_array_elements(coalesce(e->'changes', '[]'::jsonb)) c
         CROSS JOIN LATERAL (SELECT c->'value' AS v) s
         WHERE w.id = n.webhook_event_id AND
           (CASE WHEN a.platform = 'instagram' THEN v->>'id' ELSE v->>'comment_id' END) = a.external_id
         LIMIT 1
       ) src ON true
       LEFT JOIN LATERAL (
         SELECT payload FROM comment_context WHERE post_id = src.post_id ORDER BY fetched_at DESC LIMIT 1
       ) ctx ON true
       WHERE ($1::boolean OR a.staff_user_id = $2)
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [staff.role === 'admin', staff.id],
    );
    return result.rows.flatMap((row) => {
      const createdAt = asDate(row.created_at);
      if (!createdAt || typeof row.reply_body !== 'string') {
        return [];
      }
      return [{
        id: String(row.id),
        platform: row.platform === 'instagram' ? 'instagram' as const : 'facebook' as const,
        eventId: text(row.normalized_event_id),
        kind: row.event_kind === 'message' ? 'message' as const : 'comment' as const,
        postId: text(row.post_id) ?? null,
        postUrl: text(row.post_url) ?? null,
        parentId: text(row.parent_id) ?? null,
        staffName: text(row.staff_name) ?? '钉钉用户',
        staffUnionId: text(row.staff_union_id) ?? '',
        channelName: text(row.channel_name) ?? '',
        channelId: text(row.channel_id) ?? '',
        senderId: text(row.sender_id) ?? '',
        externalId: text(row.external_id) ?? '',
        commentBody: typeof row.comment_body === 'string' ? row.comment_body : '',
        replyBody: row.reply_body,
        status: text(row.status) ?? '',
        platformMessageId: text(row.platform_message_id) ?? null,
        errorCode: text(row.error_code) ?? null,
        createdAt,
      }];
    });
  }

  async saveReaction(staff: Staff, comment: InboxComment, reaction: string): Promise<void> {
    await this.db.query(`INSERT INTO message_reactions(normalized_event_id, reaction, staff_user_id)
      VALUES ($1,$2,$3) ON CONFLICT (normalized_event_id) DO UPDATE SET
      reaction=EXCLUDED.reaction, staff_user_id=EXCLUDED.staff_user_id, updated_at=now()`, [comment.id, reaction, staff.id]);
  }

  async saveVisibility(comment: InboxComment, hidden: boolean, observedAt = new Date()): Promise<void> {
    await this.db.query(`INSERT INTO comment_visibility(platform, channel_id, external_id, hidden, checked_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(platform, channel_id, external_id)
      DO UPDATE SET hidden=EXCLUDED.hidden, checked_at=EXCLUDED.checked_at
      WHERE comment_visibility.checked_at <= EXCLUDED.checked_at`,
      [comment.platform ?? 'facebook', comment.channelId, comment.externalId, hidden, observedAt]);
  }

  async recordModeration(staff: Staff, comment: InboxComment, hidden: boolean, errorCode?: string): Promise<void> {
    await this.db.query(`WITH audit AS (
      INSERT INTO comment_moderation_audit(normalized_event_id,staff_user_id,staff_name,platform,
        channel_id,channel_name,external_id,comment_body,hidden,status,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    ), resolved AS (
      UPDATE rule_runs r SET review_status='resolved', reviewed_at=now(), reviewed_by=audit.staff_user_id
      FROM audit WHERE r.normalized_event_id=audit.normalized_event_id AND audit.status='sent'
        AND r.status='completed' AND r.decision='review' AND r.review_status='open'
    ) INSERT INTO comment_visibility(platform,channel_id,external_id,hidden)
      SELECT platform,channel_id,external_id,hidden FROM audit WHERE status='sent'
      ON CONFLICT(platform,channel_id,external_id) DO UPDATE SET hidden=EXCLUDED.hidden,checked_at=now()`,
      [comment.id,staff.id,staff.name,comment.platform ?? 'facebook',comment.channelId,comment.channelName,
        comment.externalId,comment.body,hidden,errorCode ? 'failed' : 'sent',errorCode ?? null]);
  }

  async listModeration(staff: Staff): Promise<AuditRow[]> {
    const result = await this.db.query(`SELECT * FROM comment_moderation_audit
      WHERE ($1::boolean OR staff_user_id=$2) ORDER BY created_at DESC LIMIT 100`, [staff.role==='admin',staff.id]);
    return result.rows.map(row => ({ id: String(row.id), eventId: String(row.normalized_event_id),
      platform: row.platform === 'instagram' ? 'instagram' : 'facebook', kind: 'comment',
      action: row.hidden ? 'hide' : 'show', staffName: String(row.staff_name),staffUnionId:'',
      channelName:String(row.channel_name),channelId:String(row.channel_id),senderId:'',externalId:String(row.external_id),
      commentBody:String(row.comment_body),replyBody:row.hidden ? '隐藏评论' : '取消隐藏评论',
      status:String(row.status),platformMessageId:null,errorCode:text(row.error_code) ?? null,createdAt:asDate(row.created_at)! }));
  }

  async accounts(): Promise<StaffAccount[]> {
    const result = await this.db.query(
      `SELECT u.id, u.dingtalk_union_id, u.display_name, u.role, u.disabled_at,
              coalesce(array_agg(a.page_id) FILTER (WHERE a.page_id IS NOT NULL), '{}') AS page_ids
       FROM staff_users u
       LEFT JOIN staff_page_access a ON a.staff_user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at`,
      [],
    );
    return result.rows.flatMap((row) => {
      const staff = staffFrom(row, text(row.display_name) ?? '钉钉用户');
      if (!staff.id) {
        return [];
      }
      const pageIds = Array.isArray(row.page_ids) ? row.page_ids.filter((id): id is string => typeof id === 'string') : [];
      return [{ staff, disabled: row.disabled_at != null, pageIds }];
    });
  }

  async knownPages(): Promise<KnownPage[]> {
    const result = await this.db.query(
      `SELECT DISTINCT external_id, name, kind
       FROM meta_channels
       WHERE kind IN ('facebook_page', 'instagram')
       ORDER BY name`,
      [],
    );
    return result.rows.flatMap((row) => {
      const pageId = text(row.external_id);
      if (!pageId || !PAGE_ID.test(pageId)) {
        return [];
      }
      return [{ pageId, platform: (row.kind === 'instagram' ? 'instagram' : 'facebook') as 'facebook' | 'instagram', name: (row.kind === 'instagram' ? 'Instagram · @' : 'Facebook · ') + (text(row.name) ?? pageId) }];
    });
  }

  async saveAccess(input: { actor: Staff; staffId: string; role: 'admin' | 'agent'; disabled: boolean; pageIds: string[] }): Promise<void> {
    if (input.actor.role !== 'admin' || !EVENT_ID.test(input.staffId)) {
      throw new Error('forbidden');
    }
    const pageIds = [...new Set(input.pageIds.filter((id) => PAGE_ID.test(id)))];
    const client = await this.db.connect();
    let rollbackError: Error | undefined;
    try {
      await client.query('BEGIN');
      const target = await client.query(
        `SELECT id, role, disabled_at FROM staff_users WHERE id = $1`,
        [input.staffId],
      );
      if (!target.rows[0]) {
        throw new Error('not_found');
      }
      const activeAdmins = await client.query(
        `SELECT count(*)::int AS total FROM staff_users WHERE role = 'admin' AND disabled_at IS NULL AND id <> $1`,
        [input.staffId],
      );
      const others = Number(activeAdmins.rows[0]?.total ?? 0);
      if ((input.role !== 'admin' || input.disabled) && others === 0 && target.rows[0].role === 'admin' && !target.rows[0].disabled_at) {
        throw new Error('last_admin');
      }
      await client.query(
        `UPDATE staff_users
         SET role = $2, disabled_at = CASE WHEN $3 THEN coalesce(disabled_at, now()) ELSE NULL END, updated_at = now()
         WHERE id = $1`,
        [input.staffId, input.role, input.disabled],
      );
      await client.query('DELETE FROM staff_page_access WHERE staff_user_id = $1', [input.staffId]);
      for (const pageId of pageIds) {
        await client.query(
          `INSERT INTO staff_page_access (staff_user_id, page_id) VALUES ($1, $2)`,
          [input.staffId, pageId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure : new Error('rollback');
      }
      throw error;
    } finally {
      client.release(rollbackError);
    }
  }
}

function staffFrom(row: Record<string, unknown> | undefined, name: string): Staff {
  return {
    id: text(row?.id) ?? '',
    unionId: text(row?.dingtalk_union_id) ?? '',
    name,
    role: row?.role === 'admin' ? 'admin' : 'agent',
  };
}

function commentSql(tail: string): string {
  return `SELECT n.id, n.platform, n.kind, n.parent_id, n.channel_id, coalesce(ch.name, n.channel_id) AS channel_name, n.sender_id,
            src.sender_name, src.post_id, post.post_text, visibility.hidden, reaction.reaction, (n.kind = 'message' AND ads.sender_id IS NOT NULL) AS ad_source,
            n.external_id, coalesce(revision.body, n.body, '') AS body, n.occurred_at, coalesce(revision.deleted, false) AS deleted,
            run.rule_name, run.reason AS rule_reason, run.decision AS rule_decision, run.outcome AS rule_outcome,
            CASE WHEN run.review_status = 'open' AND (revision.deleted OR sent.has_live) THEN 'resolved' ELSE run.review_status END AS review_status, run.reviewed_at,
            CASE WHEN sent.has_live THEN 'sent' WHEN a.status <> 'sent' THEN a.status ELSE NULL END AS reply_status,
            a.reply_body, a.staff_user_id AS reply_staff_id, sent.replies AS sent_replies,
            (coalesce(n.sender_id = n.channel_id, false) OR EXISTS (
              SELECT 1 FROM reply_audit own WHERE own.platform = n.platform AND own.channel_id = n.channel_id
                AND own.platform_message_id = n.external_id AND own.status = 'sent'
            ) OR EXISTS (
              SELECT 1 FROM official_replies own WHERE own.platform = n.platform AND own.kind = n.kind
                AND own.channel_id = n.channel_id AND own.external_id = n.external_id
            )) AS is_own
     FROM normalized_events n
     LEFT JOIN comment_revisions revision ON n.kind = 'comment' AND revision.platform = n.platform
       AND revision.channel_id = n.channel_id AND revision.external_id = n.external_id
     LEFT JOIN rule_runs run ON run.normalized_event_id = n.id AND run.status = 'completed' AND run.outcome <> 'skipped'
     LEFT JOIN inbox_ad_referrals ads ON ads.platform=n.platform AND ads.channel_id=n.channel_id AND ads.sender_id=n.sender_id
     LEFT JOIN message_reactions reaction ON reaction.normalized_event_id = n.id
     LEFT JOIN comment_visibility visibility ON visibility.platform = n.platform AND visibility.channel_id = n.channel_id AND visibility.external_id = n.external_id
     LEFT JOIN meta_channels ch ON ch.kind = CASE WHEN n.platform = 'instagram' THEN 'instagram' ELSE 'facebook_page' END AND ch.external_id = n.channel_id
     LEFT JOIN LATERAL (
       SELECT coalesce(v->'from'->>'name', v->'from'->>'username') AS sender_name,
              CASE WHEN n.platform = 'instagram' THEN v->'media'->>'id' ELSE v->>'post_id' END AS post_id
       FROM webhook_events w
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.raw_payload->'entry', '[]'::jsonb)) e
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e->'changes', '[]'::jsonb)) c
       CROSS JOIN LATERAL (SELECT c->'value' AS v) s
       WHERE w.id = n.webhook_event_id AND (CASE WHEN n.platform = 'instagram' THEN v->>'id' ELSE v->>'comment_id' END) = n.external_id
       LIMIT 1
     ) src ON true
     LEFT JOIN LATERAL (
       SELECT payload->>'postText' AS post_text
       FROM comment_context
       WHERE post_id = src.post_id
       ORDER BY fetched_at DESC
       LIMIT 1
     ) post ON true
     LEFT JOIN LATERAL (
       SELECT status, reply_body, staff_user_id
       FROM reply_audit
       WHERE normalized_event_id = n.id
       ORDER BY created_at DESC
       LIMIT 1
     ) a ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', reply_id, 'body', reply_body,
         'staffName', staff_name, 'occurredAt', occurred_at, 'deleted', deleted) ORDER BY occurred_at, reply_id) AS replies,
         bool_or(NOT deleted) AS has_live
       FROM (SELECT DISTINCT ON (reply_id) * FROM (
         SELECT audit.platform_message_id AS reply_id, coalesce(rev.body, audit.reply_body) AS reply_body,
           audit.staff_name, coalesce(echo.occurred_at, audit.updated_at) AS occurred_at,
           coalesce(rev.deleted, false) AS deleted, 0 AS priority
         FROM reply_audit audit
         LEFT JOIN comment_revisions rev ON n.kind = 'comment' AND rev.platform = audit.platform
           AND rev.channel_id = audit.channel_id AND rev.external_id = audit.platform_message_id
         LEFT JOIN official_replies echo ON echo.platform = audit.platform AND echo.kind = n.kind
           AND echo.channel_id = audit.channel_id AND echo.external_id = audit.platform_message_id
         WHERE audit.normalized_event_id = n.id AND audit.status = 'sent' AND audit.platform_message_id IS NOT NULL
         UNION ALL
         SELECT official.external_id, coalesce(rev.body, official.body, ''), '官方客户端', official.occurred_at,
           coalesce(rev.deleted, false), 1
         FROM official_replies official
         LEFT JOIN comment_revisions rev ON official.kind = 'comment' AND rev.platform = official.platform
           AND rev.channel_id = official.channel_id AND rev.external_id = official.external_id
         WHERE official.platform = n.platform AND official.kind = n.kind AND official.channel_id = n.channel_id
           AND ((n.kind = 'comment' AND official.parent_id = n.external_id)
             OR (n.kind = 'message' AND official.recipient_id = n.sender_id AND official.occurred_at >= n.occurred_at))
       ) candidates ORDER BY reply_id, priority, occurred_at DESC) successful
     ) sent ON true
     WHERE n.platform IN ('facebook', 'instagram') AND n.kind IN ('comment', 'message')
       AND ($1::boolean OR n.channel_id IN (
         SELECT page_id FROM staff_page_access WHERE staff_user_id = $2
       ))
     ${tail}`;
}

export function threadKey(row: InboxComment): string {
  if (row.kind === 'message') {
    return `dm:${row.platform ?? 'facebook'}:${row.channelId}:${row.senderId}`;
  }
  return `post:${row.platform ?? 'facebook'}:${row.channelId}:${row.postId ?? row.id}`;
}

export function groupInbox(rows: InboxComment[]): InboxComment[] {
  const groups = new Map<string, InboxComment[]>();
  for (const row of rows) {
    const key = threadKey(row);
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return [...groups.values()].map((list) => ({ ...list[0]!, threadCount: list.length, pendingCount: list.filter(row => !row.isOwn && !row.deleted && row.replyStatus !== 'sent' && !row.hidden && row.ruleReview?.status !== 'dismissed').length })).slice(0, 50);
}

// Successful audit rows are the durable outbound history; webhook echoes use the same external ID.
function withSentReplies(rows: InboxComment[]): InboxComment[] {
  const own = new Map<string, InboxComment>();
  for (const parent of rows) for (const reply of parent.sentReplies ?? []) {
    // One DM echo may cover several preceding customer messages. Preserve the
    // known local operator when another message sees the same official echo.
    if (own.get(reply.id)?.operatorName && own.get(reply.id)?.operatorName !== '官方客户端'
      && reply.staffName === '官方客户端') continue;
    own.set(reply.id, { ...parent, id: `reply:${reply.id}`, externalId: reply.id,
      parentId: parent.kind === 'comment' ? parent.externalId : null,
      senderId: parent.channelId, senderName: parent.channelName, body: reply.body,
      occurredAt: reply.occurredAt, deleted: reply.deleted === true, hidden: undefined, reaction: undefined, ruleReview: undefined, isOwn: true, operatorName: reply.staffName,
      replyStatus: null, replyBody: null, sentReplies: [], pendingCount: undefined });
  }
  return orderThread([...rows.filter(row => !own.has(row.externalId)), ...own.values()]);
}

export function orderThread(rows: InboxComment[]): InboxComment[] {
  return [...rows].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id));
}

export interface ThreadNote {
  depth: number;
  replyTo: string | null;
  text: string;
}

export function presentThread(rows: InboxComment[]): { ordered: InboxComment[]; notes: Map<string, ThreadNote> } {
  const chronological = orderThread(rows);
  const byExternal = new Map(chronological.map((row) => [row.externalId, row]));
  const names = [...new Set(chronological.flatMap((row) => row.senderName ? [row.senderName] : []))]
    .sort((left, right) => right.length - left.length);
  const rootOf = new Map<string, string>();
  const rootId = (row: InboxComment): string => {
    const cached = rootOf.get(row.id);
    if (cached) {
      return cached;
    }
    let current = row;
    const seen = new Set<string>();
    while (current.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      const parent = byExternal.get(current.parentId);
      if (!parent) {
        break;
      }
      current = parent;
    }
    rootOf.set(row.id, current.id);
    return current.id;
  };
  const placement = new Map<string, { visualParentId: string | null; replyTo: string | null; text: string }>();
  for (const row of chronological) {
    const parent = row.parentId ? byExternal.get(row.parentId) : undefined;
    if (!parent) {
      placement.set(row.id, { visualParentId: null, replyTo: null, text: row.body });
      continue;
    }
    const mentioned = leadingName(row.body, names);
    const parentName = parent.senderName;
    let replyTo = parentName ?? '更早的评论';
    let visualParent = parent;
    let text = row.body;
    if (mentioned && mentioned !== parentName) {
      replyTo = mentioned;
      const root = rootId(row);
      const earlier = chronological.filter((item) => item.occurredAt.getTime() <= row.occurredAt.getTime()
        && item.senderName === mentioned
        && rootId(item) === root
        && item.id !== row.id);
      const target = earlier.at(-1);
      if (target) {
        visualParent = target;
      }
    }
    if (mentioned === replyTo) {
      const stripped = stripLeadingName(row.body, mentioned);
      if (stripped.length > 0) {
        text = stripped;
      }
    }
    placement.set(row.id, { visualParentId: visualParent.id, replyTo, text });
  }
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) {
      return 0;
    }
    seen.add(id);
    const parentId = placement.get(id)?.visualParentId;
    return parentId ? Math.min(depthOf(parentId, seen) + 1, 4) : 0;
  };
  const notes = new Map<string, ThreadNote>();
  for (const row of chronological) {
    const place = placement.get(row.id);
    notes.set(row.id, {
      depth: depthOf(row.id),
      replyTo: place?.replyTo ?? null,
      text: place?.text || row.body,
    });
  }
  const children = new Map<string, InboxComment[]>();
  const roots: InboxComment[] = [];
  for (const row of chronological) {
    const parentId = placement.get(row.id)?.visualParentId;
    if (!parentId) {
      roots.push(row);
    } else {
      const list = children.get(parentId) ?? [];
      list.push(row);
      children.set(parentId, list);
    }
  }
  roots.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id));
  const ordered: InboxComment[] = [];
  const walk = (row: InboxComment) => {
    ordered.push(row);
    const list = children.get(row.id) ?? [];
    list.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id));
    for (const child of list) {
      walk(child);
    }
  };
  for (const root of roots) {
    walk(root);
  }
  return { ordered, notes };
}

function leadingName(body: string, names: string[]): string | null {
  const trimmed = body.trim();
  for (const name of names) {
    if (trimmed === name || trimmed.startsWith(`${name} `)) {
      return name;
    }
  }
  return null;
}

function stripLeadingName(body: string, name: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith(`${name} `)) {
    return '';
  }
  return trimmed.slice(name.length).trim();
}

function postTitleFrom(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return title.length > 0 ? title : null;
}

function commentFrom(row: Record<string, unknown>): InboxComment | null {
  const occurredAt = asDate(row.occurred_at);
  const id = text(row.id);
  const channelId = text(row.channel_id);
  // Imported public comments can omit the author; replies target the comment ID.
  // Private messages still require the real recipient ID.
  const senderId = text(row.sender_id)?.trim() || (row.kind === 'comment' ? UNKNOWN_SENDER : undefined);
  const externalId = text(row.external_id);
  if (!occurredAt || !id || !channelId || !senderId || !externalId) {
    return null;
  }
  const replyStatus = row.reply_status === 'pending' || row.reply_status === 'sent' || row.reply_status === 'failed'
    ? row.reply_status
    : null;
  const postId = typeof row.post_id === 'string' && POST_ID.test(row.post_id) ? row.post_id : null;
  const parentId = text(row.parent_id);
  const senderName = typeof row.sender_name === 'string'
    ? row.sender_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
    : '';
  return {
    id,
    platform: row.platform === 'instagram' ? 'instagram' : 'facebook',
    kind: row.kind === 'message' ? 'message' : 'comment',
    channelId,
    channelName: text(row.channel_name) ?? channelId,
    senderId,
    senderName: senderName.length > 0 ? senderName : senderId === UNKNOWN_SENDER ? '未知用户' : null,
    postId,
    parentId: parentId && parentId !== postId ? parentId : null,
    externalId,
    body: typeof row.body === 'string' ? row.body : '',
    occurredAt,
    replyStatus,
    replyBody: typeof row.reply_body === 'string' ? row.reply_body : null,
    replyStaffId: text(row.reply_staff_id) ?? null,
    threadCount: Number(row.thread_count ?? 1),
    pendingCount: row.pending_count == null ? undefined : Number(row.pending_count),
    adSource: row.ad_source === true,
    reaction: typeof row.reaction === 'string' ? row.reaction : undefined,
    hidden: typeof row.hidden === 'boolean' ? row.hidden : undefined,
    deleted: row.deleted === true,
    isOwn: row.is_own === true,
    ruleReview: typeof row.rule_decision === 'string' ? {
      ruleName: text(row.rule_name) ?? '评论规则', reason: text(row.rule_reason) ?? '',
      decision: row.rule_decision, outcome: text(row.rule_outcome) ?? '',
      status: row.review_status === 'dismissed' || row.review_status === 'resolved' ? row.review_status : 'open',
      reviewedAt: asDate(row.reviewed_at),
    } : undefined,
    sentReplies: Array.isArray(row.sent_replies) ? row.sent_replies.flatMap((reply) => {
      const occurredAt = asDate(reply.occurredAt);
      return occurredAt && typeof reply.id === 'string' ? [{ ...reply, occurredAt }] : [];
    }) : [],
    postTitle: postTitleFrom(row.post_text),
  };
}
