import type { NormalizedEvent } from './types.js';
import { extractCommentVisibility } from './comment-visibility.js';
import { extractOfficialSync, UPSERT_REVISION_SQL } from './official-sync.js';

/** Minimal subset of `pg`'s Pool/Client used by the repository, for easy injection. */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: Array<{ id: string }> }>;
}

/**
 * Client borrowed with `pool.connect()`. `release(err)` matches pg: passing an
 * error destroys the connection instead of returning it to the pool.
 */
export interface TransactionClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<{ id: string }> }>;
  release(err?: Error | boolean): void;
}

export interface Connectable {
  connect(): Promise<TransactionClient>;
}

export interface InsertRawEventInput {
  platformObject: string;
  eventKey: string;
  rawPayload: unknown;
}

export interface InsertRawEventResult {
  inserted: boolean;
  id: string;
}

export interface StoreVerifiedWebhookInput {
  platformObject: string;
  eventKey: string;
  rawPayload: unknown;
  events: NormalizedEvent[];
}

export interface StoreVerifiedWebhookResult {
  rawInserted: boolean;
  normalizedInserted: number;
}

export interface ClaimReplyInput {
  normalizedEventId: string;
  idempotencyKey: string;
}

export type ClaimReplyResult =
  | { outcome: 'claimed'; replyId: string }
  | { outcome: 'sent'; platformMessageId: string }
  | { outcome: 'failed'; errorCode: string; errorType: string | null }
  | { outcome: 'in_progress' }
  | { outcome: 'conflict' };

export type CompleteReplyInput = {
  replyId: string;
} & (
  | { status: 'sent'; platformMessageId: string }
  | { status: 'failed'; errorCode: string; errorType?: string | null }
);

export interface StoredNormalizedEvent {
  id: string;
  platform: 'facebook' | 'instagram';
  kind: 'comment' | 'message';
  channelId: string;
  senderId: string;
  externalId: string;
}

const INSERT_SQL = `INSERT INTO webhook_events (platform_object, event_key, raw_payload)
VALUES ($1, $2, $3::jsonb)
ON CONFLICT (event_key) DO NOTHING
RETURNING id`;

const INSERT_VERIFIED_SQL = `INSERT INTO webhook_events (platform_object, event_key, raw_payload, ingest_source)
VALUES ($1, $2, $3::jsonb, 'meta_webhook')
ON CONFLICT (event_key) DO NOTHING
RETURNING id`;

const SELECT_SQL = 'SELECT id FROM webhook_events WHERE event_key = $1';

const INSERT_NORMALIZED_SQL = `INSERT INTO normalized_events (
  webhook_event_id,
  platform,
  kind,
  channel_id,
  sender_id,
  external_id,
  parent_id,
  body,
  occurred_at,
  ingest_source,
  rule_eligible
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'meta_webhook', $3 = 'comment')
ON CONFLICT (platform, kind, external_id) DO NOTHING
RETURNING id`;

const ENQUEUE_RULES_SQL = `INSERT INTO rule_runs (normalized_event_id, rule_ids)
SELECT n.id, array_agg(r.id ORDER BY r.priority, r.id)
FROM normalized_events n
JOIN inbox_rules r ON r.enabled AND r.category = 'moderation'
  AND r.enabled_at <= n.created_at
  AND (r.platform = 'all' OR r.platform = n.platform)
  AND (cardinality(r.channel_ids) = 0 OR n.channel_id = ANY(r.channel_ids))
WHERE n.id = $1 AND n.ingest_source = 'meta_webhook'
  AND n.rule_eligible AND n.kind = 'comment'
  AND n.sender_id IS DISTINCT FROM n.channel_id
  AND NOT EXISTS (SELECT 1 FROM comment_revisions revision WHERE revision.platform = n.platform
    AND revision.channel_id = n.channel_id AND revision.external_id = n.external_id)
  AND NOT EXISTS (SELECT 1 FROM official_replies official WHERE official.platform = n.platform
    AND official.kind = n.kind AND official.channel_id = n.channel_id AND official.external_id = n.external_id)
  AND NOT EXISTS (SELECT 1 FROM reply_audit a
    WHERE a.status = 'sent' AND a.platform = n.platform AND a.platform_message_id = n.external_id)
GROUP BY n.id
ON CONFLICT (normalized_event_id) DO NOTHING`;

type SqlQuery = (text: string, values: unknown[]) => Promise<{ rows: Array<{ id: string }> }>;

const SAFE_ERROR_TOKEN = /^[A-Za-z0-9_]{1,64}$/;

function rowRecords(result: { rows: Array<{ id: string }> }): Array<Record<string, unknown>> {
  return result.rows as unknown as Array<Record<string, unknown>>;
}

function textOrNull(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function safeErrorCode(value: string): string {
  return SAFE_ERROR_TOKEN.test(value) ? value : 'unspecified_error';
}

function safeErrorType(value: string | null | undefined): string | null {
  return typeof value === 'string' && SAFE_ERROR_TOKEN.test(value) ? value : null;
}

export class EventRepository {
  constructor(private readonly db: Queryable) {}

  async insertRawEvent(input: InsertRawEventInput): Promise<InsertRawEventResult> {
    return this.insertRawEventWith((text, values) => this.db.query(text, values), input);
  }

  /**
   * Stores the raw webhook and its normalized events on one connection.
   * `normalizedInserted` counts rows actually returned by `RETURNING`, not the input length.
   * Only newly inserted, verified webhook comments receive rule eligibility. A duplicate
   * callback never upgrades a legacy/imported/API-pulled row. Eligibility records origin,
   * not pending work: any future executor must consume new insertions after rules are
   * enabled, and must never scan existing eligible rows to backfill old comments.
   */
  async storeVerifiedWebhook(input: StoreVerifiedWebhookInput): Promise<StoreVerifiedWebhookResult> {
    const client = await (this.db as Queryable & Connectable).connect();
    let rollbackError: Error | undefined;

    try {
      await client.query('BEGIN');
      const raw = await this.insertRawEventWith((text, values) => client.query(text, values), input, true);
      let normalizedInserted = 0;

      const sync = extractOfficialSync(input.rawPayload);
      for (const revision of sync.revisions) {
        await client.query(UPSERT_REVISION_SQL, [revision.platform, revision.channelId,
          revision.externalId, revision.body, revision.deleted, revision.observedAt]);
      }
      for (const reply of sync.replies) {
        await client.query(`INSERT INTO official_replies (platform, kind, channel_id, external_id,
          recipient_id, parent_id, post_id, body, occurred_at, observed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (platform, kind, channel_id, external_id) DO UPDATE
          SET recipient_id = coalesce(official_replies.recipient_id, EXCLUDED.recipient_id),
            parent_id = coalesce(official_replies.parent_id, EXCLUDED.parent_id),
            post_id = coalesce(official_replies.post_id, EXCLUDED.post_id),
            body = coalesce(EXCLUDED.body, official_replies.body), observed_at = EXCLUDED.observed_at
          WHERE EXCLUDED.observed_at > official_replies.observed_at`,
        [reply.platform, reply.kind, reply.channelId, reply.externalId, reply.recipientId,
          reply.parentId, reply.postId, reply.body, reply.occurredAt, reply.observedAt]);
      }

      for (const visibility of extractCommentVisibility(input.rawPayload)) {
        await client.query(`INSERT INTO comment_visibility (platform, channel_id, external_id, hidden, checked_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (platform, channel_id, external_id) DO UPDATE
          SET hidden = EXCLUDED.hidden, checked_at = EXCLUDED.checked_at
          WHERE EXCLUDED.checked_at > comment_visibility.checked_at`, [visibility.platform,
          visibility.channelId, visibility.externalId, visibility.hidden, visibility.observedAt]);
      }

      for (const event of input.events) {
        const inserted = await client.query(INSERT_NORMALIZED_SQL, [
          raw.id,
          event.platform,
          event.kind,
          event.channelId,
          event.senderId,
          event.externalId,
          event.parentId,
          event.text,
          event.occurredAt,
        ]);

        if (inserted.rows[0]) {
          normalizedInserted += 1;
          if (event.kind === 'comment') {
            // Admission is tied to this successful INSERT, never to a later
            // scan of rule_eligible. Duplicate callbacks cannot queue history.
            await client.query(ENQUEUE_RULES_SQL, [inserted.rows[0].id]);
          }
        }
      }

      await client.query('COMMIT');

      return { rawInserted: raw.inserted, normalizedInserted };
    } catch (error) {
      // A failed statement (including COMMIT) must not leave the transaction open.
      // The caller still sees `error`. If ROLLBACK itself fails, the connection
      // may still be in a transaction, so it must not go back to the pool.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure : new Error(String(rollbackFailure));
      }
      throw error;
    } finally {
      if (rollbackError) {
        client.release(rollbackError);
      } else {
        client.release();
      }
    }
  }

  /**
   * Occupies an idempotency key in a short transaction. Callers must not call
   * Graph until this method has committed and returned.
   */
  async claimReply(input: ClaimReplyInput): Promise<ClaimReplyResult> {
    return this.inTransaction(async (query) => {
      const inserted = rowRecords(await query(
        `INSERT INTO outbound_replies (normalized_event_id, idempotency_key, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [input.normalizedEventId, input.idempotencyKey],
      ));
      const insertedId = textOrNull(inserted[0] ?? {}, 'id');
      if (insertedId) {
        return { outcome: 'claimed', replyId: insertedId };
      }

      const existing = rowRecords(await query(
        `SELECT id, normalized_event_id, status, platform_message_id, error_code, error_type
         FROM outbound_replies
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [input.idempotencyKey],
      ));
      const row = existing[0];
      if (!row) {
        throw new Error('outbound_replies row missing after idempotency conflict');
      }

      if (textOrNull(row, 'normalized_event_id') !== input.normalizedEventId) {
        return { outcome: 'conflict' };
      }

      const status = textOrNull(row, 'status');
      const platformMessageId = textOrNull(row, 'platform_message_id');
      const replyId = textOrNull(row, 'id');
      if (!replyId) {
        throw new Error('outbound_replies.id is missing');
      }

      if (status === 'sent') {
        if (!platformMessageId) {
          throw new Error('sent reply is missing platform_message_id');
        }
        return { outcome: 'sent', platformMessageId };
      }

      if (status === 'failed') {
        return {
          outcome: 'failed',
          errorCode: textOrNull(row, 'error_code') ?? 'unspecified_error',
          errorType: textOrNull(row, 'error_type'),
        };
      }

      if (status === 'pending' && platformMessageId) {
        await query(
          `UPDATE outbound_replies
           SET status = 'sent', updated_at = now()
           WHERE id = $1
             AND status = 'pending'
             AND platform_message_id IS NOT NULL`,
          [replyId],
        );
        return { outcome: 'sent', platformMessageId };
      }

      const takeover = rowRecords(await query(
        `UPDATE outbound_replies
         SET updated_at = now()
         WHERE id = $1
           AND status = 'pending'
           AND platform_message_id IS NULL
           AND updated_at < now() - interval '2 minutes'
         RETURNING id`,
        [replyId],
      ));
      if (takeover[0]) {
        return { outcome: 'claimed', replyId };
      }

      return { outcome: 'in_progress' };
    });
  }

  async findNormalizedEventById(id: string): Promise<StoredNormalizedEvent | null> {
    const result = rowRecords(await this.db.query(
      `SELECT id, platform, kind, channel_id, sender_id, external_id
       FROM normalized_events
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM comment_revisions revision
         WHERE normalized_events.kind = 'comment' AND revision.platform = normalized_events.platform
           AND revision.channel_id = normalized_events.channel_id AND revision.external_id = normalized_events.external_id
           AND revision.deleted)`,
      [id],
    ));
    const row = result[0];
    if (!row) {
      return null;
    }

    const eventId = textOrNull(row, 'id');
    const platform = textOrNull(row, 'platform');
    const kind = textOrNull(row, 'kind');
    const channelId = textOrNull(row, 'channel_id');
    const senderId = textOrNull(row, 'sender_id');
    const externalId = textOrNull(row, 'external_id');
    if (
      !eventId ||
      (platform !== 'facebook' && platform !== 'instagram') ||
      (kind !== 'comment' && kind !== 'message') ||
      !channelId ||
      !senderId ||
      !externalId
    ) {
      return null;
    }

    return { id: eventId, platform, kind, channelId, senderId, externalId };
  }

  /** Writes the Graph result in a separate short transaction. Does not call Graph. */
  async completeReply(input: CompleteReplyInput): Promise<void> {
    const platformMessageId = input.status === 'sent' ? input.platformMessageId : null;
    const errorCode = input.status === 'failed' ? safeErrorCode(input.errorCode) : null;
    const errorType = input.status === 'failed' ? safeErrorType(input.errorType) : null;

    if (input.status === 'sent' && input.platformMessageId.length === 0) {
      throw new Error('platform_message_id is required');
    }

    await this.inTransaction(async (query) => {
      const updated = await query(
        `UPDATE outbound_replies
         SET status = $2,
             platform_message_id = $3,
             error_code = $4,
             error_type = $5,
             updated_at = now()
         WHERE id = $1
           AND status = 'pending'
         RETURNING id`,
        [input.replyId, input.status, platformMessageId, errorCode, errorType],
      );
      if (!updated.rows[0]) {
        throw new Error('outbound reply is not pending');
      }
    });
  }

  private async inTransaction<T>(work: (query: SqlQuery) => Promise<T>): Promise<T> {
    const client = await (this.db as Queryable & Connectable).connect();
    let rollbackError: Error | undefined;

    try {
      await client.query('BEGIN');
      const result = await work((text, values) => client.query(text, values));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error
          ? rollbackFailure
          : new Error('rollback failed');
      }
      throw error;
    } finally {
      if (rollbackError) {
        client.release(rollbackError);
      } else {
        client.release();
      }
    }
  }

  private async insertRawEventWith(query: SqlQuery, input: InsertRawEventInput, verified = false): Promise<InsertRawEventResult> {
    // Serialise explicitly: node-postgres would turn a JS array into a
    // PostgreSQL array literal rather than a JSON value.
    const insertResult = await query(verified ? INSERT_VERIFIED_SQL : INSERT_SQL, [
      input.platformObject,
      input.eventKey,
      JSON.stringify(input.rawPayload),
    ]);
    const insertedRow = insertResult.rows[0];

    if (insertedRow) {
      return { inserted: true, id: insertedRow.id };
    }

    const existingResult = await query(SELECT_SQL, [input.eventKey]);
    const existingRow = existingResult.rows[0];

    if (!existingRow) {
      throw new Error(`webhook_events row for event_key ${input.eventKey} not found after conflict`);
    }

    return { inserted: false, id: existingRow.id };
  }
}
