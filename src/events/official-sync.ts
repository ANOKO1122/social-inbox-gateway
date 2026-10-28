import { millisecondsToIso, secondsToIso } from './timestamp.js';

type Platform = 'facebook' | 'instagram';
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;

export interface OfficialReply {
  platform: Platform;
  kind: 'comment' | 'message';
  channelId: string;
  externalId: string;
  recipientId: string | null;
  parentId: string | null;
  postId: string | null;
  body: string | null;
  occurredAt: string;
  observedAt: string;
}

export interface CommentRevision {
  platform: Platform;
  channelId: string;
  externalId: string;
  body: string | null;
  deleted: boolean;
  observedAt: string;
}

/** Outbound/revision callbacks are deliberately separate from customer events. */
export function extractOfficialSync(payload: unknown): { replies: OfficialReply[]; revisions: CommentRevision[] } {
  const replies: OfficialReply[] = [];
  const revisions: CommentRevision[] = [];
  if (!record(payload) || (payload.object !== 'page' && payload.object !== 'instagram')) return { replies, revisions };
  const platform = payload.object === 'page' ? 'facebook' : 'instagram';
  for (const entry of list(payload.entry)) {
    if (!record(entry)) continue;
    const channelId = text(entry.id);
    if (!channelId) continue;
    for (const item of list(entry.messaging)) {
      if (!record(item) || !record(item.message) || !record(item.sender) || !record(item.recipient)) continue;
      const message = item.message;
      const externalId = text(message.mid);
      const recipientId = text(item.recipient.id);
      const occurredAt = millisecondsToIso(item.timestamp);
      // Never guess the account identity from a truthy/malformed is_echo flag.
      if (item.sender.id !== channelId || !externalId || !recipientId || recipientId === channelId || !occurredAt
        || (message.is_echo !== undefined && message.is_echo !== null && typeof message.is_echo !== 'boolean')
        || message.is_deleted === true || message.is_edited === true) continue;
      replies.push({ platform, kind: 'message', channelId, externalId, recipientId,
        parentId: null, postId: null, body: typeof message.text === 'string' ? message.text : null,
        occurredAt, observedAt: occurredAt });
    }
    const observedAt = secondsToIso(entry.time);
    if (!observedAt) continue;
    for (const change of list(entry.changes)) {
      if (!record(change) || !record(change.value)) continue;
      const value = change.value;
      if (platform === 'facebook' ? change.field !== 'feed' || value.item !== 'comment' : change.field !== 'comments') continue;
      const externalId = text(platform === 'facebook' ? value.comment_id : value.id);
      if (!externalId) continue;
      if (platform === 'facebook' && (value.verb === 'edited' || value.verb === 'remove')) {
        // Removal can omit the author and body. A malformed edit cannot erase text.
        if (value.verb === 'remove' || typeof value.message === 'string') {
          revisions.push({ platform, channelId, externalId, body: typeof value.message === 'string' ? value.message : null,
            deleted: value.verb === 'remove', observedAt });
        }
        continue;
      }
      if ((platform === 'facebook' && value.verb !== 'add')
        || (platform === 'instagram' && value.verb !== undefined && value.verb !== 'add')
        || !record(value.from) || value.from.id !== channelId) continue;
      const occurredAt = platform === 'facebook' && value.created_time != null ? secondsToIso(value.created_time) : observedAt;
      if (!occurredAt) continue;
      const postId = text(platform === 'facebook' ? value.post_id : record(value.media) ? value.media.id : null);
      const parentId = text(value.parent_id);
      replies.push({ platform, kind: 'comment', channelId, externalId, recipientId: null,
        parentId: parentId === postId ? null : parentId, postId,
        body: typeof (platform === 'facebook' ? value.message : value.text) === 'string'
          ? String(platform === 'facebook' ? value.message : value.text) : null,
        occurredAt, observedAt });
    }
  }
  return { replies, revisions };
}

export const UPSERT_REVISION_SQL = `INSERT INTO comment_revisions (platform, channel_id, external_id, body, deleted, observed_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (platform, channel_id, external_id) DO UPDATE
  SET body = coalesce(EXCLUDED.body, comment_revisions.body), deleted = EXCLUDED.deleted, observed_at = EXCLUDED.observed_at
  WHERE NOT comment_revisions.deleted AND (EXCLUDED.observed_at > comment_revisions.observed_at
    OR (EXCLUDED.observed_at = comment_revisions.observed_at AND EXCLUDED.deleted))`;
