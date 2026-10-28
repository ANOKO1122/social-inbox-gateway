import type { ChannelDb } from '../connect/channel-repository.js';
import type { CommentContextView, CommentMention, PulledComment, ThreadLine } from '../meta/comment-context.js';

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POST_ID = /^[0-9]{5,32}(?:_[0-9]{5,32})?$/;
const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;

export interface CommentFacts {
  postId: string | null;
  senderName: string | null;
}

export interface CommentContextRecords {
  facts(eventId: string): Promise<CommentFacts>;
  cached(eventId: string, now: Date): Promise<CommentContextView | null>;
  cachedPost(postId: string, now: Date): Promise<CommentContextView | null>;
  save(eventId: string, view: CommentContextView, postId?: string | null, observedAt?: Date): Promise<void>;
}

export class CommentContextStore implements CommentContextRecords {
  constructor(private readonly db: ChannelDb) {}

  async facts(eventId: string): Promise<CommentFacts> {
    if (!EVENT_ID.test(eventId)) {
      return { postId: null, senderName: null };
    }
    const result = await this.db.query(
      `SELECT v->>'post_id' AS post_id, v->'from'->>'name' AS sender_name
       FROM normalized_events n
       JOIN webhook_events w ON w.id = n.webhook_event_id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.raw_payload->'entry', '[]'::jsonb)) e
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e->'changes', '[]'::jsonb)) c
       CROSS JOIN LATERAL (SELECT c->'value' AS v) s
       WHERE n.id = $1 AND v->>'comment_id' = n.external_id
       LIMIT 1`,
      [eventId],
    );
    const row = result.rows[0];
    const postId = typeof row?.post_id === 'string' && POST_ID.test(row.post_id) ? row.post_id : null;
    const senderName = cleanName(row?.sender_name);
    return { postId, senderName };
  }

  async cached(eventId: string, now: Date): Promise<CommentContextView | null> {
    if (!EVENT_ID.test(eventId)) {
      return null;
    }
    const result = await this.db.query(
      `SELECT payload, fetched_at FROM comment_context WHERE normalized_event_id = $1`,
      [eventId],
    );
    return fresh(result.rows[0], now);
  }

  async cachedPost(postId: string, now: Date): Promise<CommentContextView | null> {
    if (!POST_ID.test(postId)) {
      return null;
    }
    const result = await this.db.query(
      `SELECT payload, fetched_at FROM comment_context WHERE post_id = $1 ORDER BY fetched_at DESC LIMIT 1`,
      [postId],
    );
    return fresh(result.rows[0], now);
  }

  async save(eventId: string, view: CommentContextView, postId?: string | null, observedAt?: Date): Promise<void> {
    if (!EVENT_ID.test(eventId)) {
      return;
    }
    const storedPost = postId && POST_ID.test(postId) ? postId : null;
    await this.db.query(
      `INSERT INTO comment_context (normalized_event_id, payload, post_id, fetched_at)
       VALUES ($1, $2::jsonb, $3, COALESCE($4::timestamptz, now()))
       ON CONFLICT (normalized_event_id) DO UPDATE
       SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at, post_id = COALESCE(EXCLUDED.post_id, comment_context.post_id)
       WHERE comment_context.fetched_at <= EXCLUDED.fetched_at`,
      [eventId, JSON.stringify({ ...view, lines: [], comments: view.comments?.slice(0, 100), threadWindow: 'latest100' }), storedPost, observedAt ?? null],
    );
  }
}

function fresh(row: { payload?: unknown; fetched_at?: unknown } | undefined, now: Date): CommentContextView | null {
  const fetchedAt = row?.fetched_at instanceof Date ? row.fetched_at : typeof row?.fetched_at === 'string' ? new Date(row.fetched_at) : undefined;
  const view = viewFrom(row?.payload);
  if (view && (row?.payload as { threadWindow?: string } | undefined)?.threadWindow !== 'latest100') {
    view.comments = undefined;
  }
  if (!view || !fetchedAt || Number.isNaN(fetchedAt.getTime())) {
    return null;
  }
  const age = now.getTime() - fetchedAt.getTime();
  if (view.status === 'ok' && age < FRESH_MS) {
    return view;
  }
  if (view.status === 'unavailable' && age < RETRY_MS) {
    return view;
  }
  return null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return name.length > 0 ? name : null;
}

function viewFrom(value: unknown): CommentContextView | null {
  if (typeof value === 'string') {
    try {
      return viewFrom(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as { status?: unknown; postText?: unknown; postUrl?: unknown; lines?: unknown; comments?: unknown };
  if (row.status !== 'ok' && row.status !== 'unavailable') {
    return null;
  }
  const lines = Array.isArray(row.lines) ? row.lines.flatMap(lineFrom) : [];
  const view: CommentContextView = {
    status: row.status,
    postText: typeof row.postText === 'string' ? row.postText.slice(0, 800) : null,
    postUrl: typeof row.postUrl === 'string' && row.postUrl.startsWith('https://') ? row.postUrl.slice(0, 300) : null,
    lines,
  };
  if (Array.isArray(row.comments)) {
    view.comments = row.comments.slice(0, 100).flatMap(commentFromStored);
  }
  return view;
}

function commentFromStored(value: unknown): PulledComment[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const row = value as Partial<PulledComment>;
  if (typeof row.id !== 'string' || typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) {
    return [];
  }
  const mentions = Array.isArray(row.mentions) ? row.mentions.flatMap(mentionFromStored) : [];
  return [{
    id: row.id.slice(0, 80),
    text: typeof row.text === 'string' ? row.text.slice(0, 8000) : '',
    createdAt: row.createdAt,
    parentId: typeof row.parentId === 'string' ? row.parentId.slice(0, 80) : null,
    likeCount: typeof row.likeCount === 'number' && row.likeCount >= 0 ? Math.floor(row.likeCount) : 0,
    commentCount: typeof row.commentCount === 'number' && row.commentCount >= 0 ? Math.floor(row.commentCount) : 0,
    mentions,
    ...(typeof row.hidden === 'boolean' ? { hidden: row.hidden } : {}),
    ...(typeof row.canHide === 'boolean' ? { canHide: row.canHide } : {}),
  }];
}

function mentionFromStored(value: unknown): CommentMention[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const row = value as Partial<CommentMention>;
  if (typeof row.name !== 'string' || typeof row.offset !== 'number' || typeof row.length !== 'number') {
    return [];
  }
  return [{ name: row.name.slice(0, 80), offset: row.offset, length: row.length }];
}

function lineFrom(value: unknown): ThreadLine[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const row = value as { name?: unknown; text?: unknown; current?: unknown; reply?: unknown };
  if (typeof row.text !== 'string') {
    return [];
  }
  return [{
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name.slice(0, 80) : '评论',
    text: row.text.slice(0, 500),
    current: row.current === true,
    reply: row.reply === true,
  }];
}
