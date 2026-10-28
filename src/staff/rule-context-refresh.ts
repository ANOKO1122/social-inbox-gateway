import type { ChannelDb } from '../connect/channel-repository.js';
import type { CommentContextClient, CommentContextView } from '../meta/comment-context.js';
import type { CommentContextStore } from './comment-context-store.js';

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACEBOOK_POST = /^[0-9]{5,20}_[0-9]{5,20}$/;
const REFRESH_MS = 60_000;
const MAX_RECENT_POSTS = 1_000;
const MAX_IN_FLIGHT = 32;

export interface RuleContextRefreshInput {
  eventId: string;
  platform: 'facebook' | 'instagram';
  channelId: string;
  externalId: string;
  accessToken: string;
}

/** Read-only Meta refresh. Pulled history never becomes a normalized event or a rule job. */
export class RuleContextRefresh {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly recent = new Map<string, number>();

  constructor(private readonly options: {
    db: Pick<ChannelDb, 'query'>;
    client: CommentContextClient;
    contexts: CommentContextStore;
  }) {}

  async refresh(input: RuleContextRefreshInput): Promise<void> {
    // Facebook's stream edge returns the latest 100 comments and replies in one read.
    // Instagram continues to use the runner's individual visibility check.
    if (input.platform !== 'facebook' || !EVENT_ID.test(input.eventId)) return;
    const result = await this.options.db.query(`SELECT v->>'post_id' AS post_id
      FROM normalized_events n JOIN webhook_events w ON w.id=n.webhook_event_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w.raw_payload->'entry')='array'
        THEN w.raw_payload->'entry' ELSE '[]'::jsonb END) e
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'changes')='array'
        THEN e->'changes' ELSE '[]'::jsonb END) c
      CROSS JOIN LATERAL (SELECT c->'value' AS v) value
      WHERE n.id=$1 AND n.platform=$2 AND n.channel_id=$3 AND n.external_id=$4
        AND n.kind='comment' AND e->>'id'=n.channel_id AND v->>'comment_id'=n.external_id
      LIMIT 1`, [input.eventId, input.platform, input.channelId, input.externalId]);
    const postId = result.rows[0]?.post_id;
    if (typeof postId !== 'string' || !FACEBOOK_POST.test(postId)) return;
    const key = `${input.platform}:${input.channelId}:${postId}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const now = Date.now();
    if ((this.recent.get(key) ?? 0) > now || this.inFlight.size >= MAX_IN_FLIGHT) return;
    const task = this.refreshPost(input, postId, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    await task;
  }

  private remember(key: string, until: number): void {
    const now = Date.now();
    for (const [id, expiry] of this.recent) if (expiry <= now) this.recent.delete(id);
    this.recent.delete(key);
    this.recent.set(key, until);
    while (this.recent.size > MAX_RECENT_POSTS) this.recent.delete(this.recent.keys().next().value!);
  }

  private async refreshPost(input: RuleContextRefreshInput, postId: string, key: string): Promise<void> {
    const result = await this.options.db.query(`SELECT cc.normalized_event_id, cc.payload, cc.fetched_at
      FROM comment_context cc JOIN normalized_events n ON n.id=cc.normalized_event_id
      WHERE cc.post_id=$1 AND n.platform=$2 AND n.channel_id=$3
      ORDER BY cc.fetched_at DESC LIMIT 1`, [postId, input.platform, input.channelId]);
    const row = result.rows[0];
    const fetchedAt = row?.fetched_at instanceof Date ? row.fetched_at.getTime()
      : typeof row?.fetched_at === 'string' ? Date.parse(row.fetched_at) : NaN;
    const cached = row?.normalized_event_id
      ? await this.options.contexts.cached(String(row.normalized_event_id), new Date()) : null;
    if (cached?.status === 'ok' && cached.comments && fetchedAt + REFRESH_MS > Date.now()) {
      this.remember(key, fetchedAt + REFRESH_MS);
      return;
    }

    const observedAt = new Date();
    // Failed reads receive the same cooldown so a busy post cannot hammer Meta.
    this.remember(key, observedAt.getTime() + REFRESH_MS);
    const pulled = await this.options.client.loadThread({ postId, accessToken: input.accessToken });
    if (pulled === null) return;
    const comments = pulled.slice(0, 100);
    let view: CommentContextView = cached ?? {
      status: 'ok', postText: null, postUrl: `https://www.facebook.com/${postId}`, lines: [],
    };
    if (!view.postText) {
      try {
        const loaded = await this.options.client.load({
          platform: input.platform, postId, commentId: input.externalId, accessToken: input.accessToken,
        });
        if (loaded.status === 'ok') view = loaded;
      } catch {
        // A failed post-body read must not discard the successfully read comment window.
      }
    }
    const states = [...new Map(comments.filter(comment => typeof comment.hidden === 'boolean')
      .map(comment => [comment.id, { id: comment.id, hidden: comment.hidden }])).values()];
    if (states.length) {
      await this.options.db.query(`INSERT INTO comment_visibility(platform, channel_id, external_id, hidden, checked_at)
        SELECT $1, $2, state.id, state.hidden, $4::timestamptz
        FROM jsonb_to_recordset($3::jsonb) AS state(id text, hidden boolean)
        ON CONFLICT (platform, channel_id, external_id) DO UPDATE
        SET hidden=EXCLUDED.hidden, checked_at=EXCLUDED.checked_at
        WHERE comment_visibility.checked_at <= EXCLUDED.checked_at`,
      [input.platform, input.channelId, JSON.stringify(states), observedAt]);
    }
    await this.options.contexts.save(input.eventId, { ...view, status: 'ok', comments }, postId, observedAt);
  }
}
