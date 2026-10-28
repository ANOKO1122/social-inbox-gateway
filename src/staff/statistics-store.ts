import type { ChannelDb } from '../connect/channel-repository.js';
import { buildEventKey } from '../events/event-key.js';
import { normalizeMetaPayload } from '../events/normalize.js';
import type { MetaWebhookPayload, NormalizedEvent } from '../events/types.js';

export interface InboxStatistics {
  day: string;
  generatedAt: string;
  platform: 'all' | 'facebook' | 'instagram';
  received: { total: number; messages: number; comments: number };
  rule: { processed: number; hidden: number; automationEnabled: boolean };
  manual: { processed: number; replies: number; hidden: number; restored: number; noAction?: number; deleted?: number; otherActions?: number };
  pages: Array<{
    platform: 'facebook' | 'instagram';
    channelId: string;
    name: string;
    total: number;
    messages: number;
    comments: number;
  }>;
}

type Db = Pick<ChannelDb, 'query'>;
type Row = Record<string, unknown>;

function eventIdentity(event: NormalizedEvent): string {
  return JSON.stringify([event.platform, event.channelId, event.kind, event.externalId]);
}

/** Imported comments share this table, but do not use the webhook receiver's key. */
function verifiedShapeEvents(row: Row): NormalizedEvent[] {
  const payload = row.raw_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (row.ingest_source !== 'meta_webhook' && row.ingest_source !== null)) return [];
  // Before ingest_source existed, this is the only persisted receiver fingerprint.
  // It excludes the historical imports; it is not a retrospective signature check.
  if (row.ingest_source !== 'meta_webhook'
    && row.event_key !== buildEventKey(payload as MetaWebhookPayload)) return [];
  return normalizeMetaPayload(payload);
}

function containsShape(event: NormalizedEvent): object {
  const entry = event.kind === 'message'
    ? { id: event.channelId, messaging: [{ message: { mid: event.externalId } }] }
    : { id: event.channelId, changes: [{ value: event.platform === 'instagram'
      ? { id: event.externalId } : { comment_id: event.externalId } }] };
  return { object: event.platform === 'instagram' ? 'instagram' : 'page', entry: [entry] };
}

export class StatisticsStore {
  constructor(private readonly db: Db) {}

  async today(now: Date, platform: InboxStatistics['platform'] = 'all'): Promise<InboxStatistics> {
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_statistics_date');
    if (!['all', 'facebook', 'instagram'].includes(platform)) throw new Error('invalid_statistics_platform');
    // Asia/Shanghai has no daylight-saving transitions: use the same UTC+8 day
    // everywhere, independent of the application host's timezone.
    const day = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const start = new Date(`${day}T00:00:00+08:00`);
    const bounds = [start.toISOString(), now.toISOString(), platform];
    const [events, manual, channelRows, rule] = await Promise.all([
      this.receivedEvents(start, now, platform),
      this.db.query(MANUAL_SQL, bounds),
      this.db.query(`SELECT kind,external_id,name FROM meta_channels
        WHERE ($1::text='all' OR kind=CASE WHEN $1='instagram' THEN 'instagram' ELSE 'facebook_page' END)`, [platform]),
      this.db.query(RULE_SQL, bounds),
    ]);
    // Meta can redeliver an event inside a differently grouped HTTP batch. Check
    // earlier raw batches too, including events whose normalized row originally
    // came from an import. Such a redelivery is not a newly received message.
    await this.removeEarlierAndOwn(events, start);

    const names = new Map(channelRows.rows.map(row => [
      JSON.stringify([row.kind === 'instagram' ? 'instagram' : 'facebook', row.external_id]),
      typeof row.name === 'string' && row.name.trim() ? row.name.trim() : String(row.external_id),
    ]));
    const pages = new Map<string, InboxStatistics['pages'][number]>();
    const received = { total: 0, messages: 0, comments: 0 };
    for (const event of events.values()) {
      const key = JSON.stringify([event.platform, event.channelId]);
      const page = pages.get(key) ?? {
        platform: event.platform, channelId: event.channelId, name: names.get(key) ?? event.channelId,
        total: 0, messages: 0, comments: 0,
      };
      const kind = event.kind === 'message' ? 'messages' : 'comments';
      page.total += 1; page[kind] += 1;
      received.total += 1; received[kind] += 1;
      pages.set(key, page);
    }
    const counts = manual.rows[0] ?? {};
    return {
      day, generatedAt: now.toISOString(), platform, received,
      rule: {
        processed: Number(rule.rows[0]?.processed ?? 0), hidden: Number(rule.rows[0]?.hidden ?? 0),
        automationEnabled: rule.rows[0]?.automation_enabled === true,
      },
      manual: {
        processed: Number(counts.processed ?? 0), replies: Number(counts.replies ?? 0),
        hidden: Number(counts.hidden ?? 0), restored: Number(counts.restored ?? 0), noAction: Number(counts.no_action ?? 0),
        deleted: Number(counts.deleted ?? 0), otherActions: Number(counts.other_actions ?? 0),
      },
      pages: [...pages.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)
        || a.channelId.localeCompare(b.channelId)),
    };
  }

  private async receivedEvents(start: Date, now: Date, platform: InboxStatistics['platform']): Promise<Map<string, NormalizedEvent>> {
    const events = new Map<string, NormalizedEvent>();
    let cursor: { at: unknown; id: unknown } | undefined;
    for (;;) {
      const result = await this.db.query(`SELECT id,event_key,raw_payload,ingest_source,received_at::text AS cursor_at
        FROM webhook_events WHERE received_at >= $1::timestamptz AND received_at <= $2::timestamptz
          AND ($3::text='all' OR platform_object=CASE WHEN $3='instagram' THEN 'instagram' ELSE 'page' END)
          AND (ingest_source='meta_webhook' OR ingest_source IS NULL)
          AND ($4::timestamptz IS NULL OR (received_at,id) > ($4::timestamptz,$5::uuid))
        ORDER BY received_at,id LIMIT 500`,
      [start.toISOString(), now.toISOString(), platform, cursor?.at ?? null, cursor?.id ?? null]);
      for (const row of result.rows) {
        for (const event of verifiedShapeEvents(row)) {
          if (platform === 'all' || event.platform === platform) {
            // Keep only event metadata between batches, not customer message bodies.
            events.set(eventIdentity(event), { ...event, text: null });
          }
        }
      }
      if (result.rows.length < 500) break;
      const last = result.rows.at(-1)!;
      cursor = { at: last.cursor_at, id: last.id };
    }
    return events;
  }

  private async removeEarlierAndOwn(events: Map<string, NormalizedEvent>, start: Date): Promise<void> {
    const candidates = [...events.values()];
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const chunk = candidates.slice(offset, offset + 100);
      const own = await this.db.query(`SELECT platform,channel_id,platform_message_id FROM reply_audit
        WHERE status='sent' AND platform_message_id=ANY($1::text[])`, [chunk.map(event => event.externalId)]);
      for (const row of own.rows) {
        for (const kind of ['comment', 'message']) {
          events.delete(JSON.stringify([row.platform, row.channel_id, kind, row.platform_message_id]));
        }
      }
      let cursor: { at: unknown; id: unknown } | undefined;
      for (;;) {
        const prior = await this.db.query(`SELECT DISTINCT w.id,w.event_key,w.raw_payload,w.ingest_source,w.received_at,
            w.received_at::text AS cursor_at
          FROM jsonb_array_elements($2::jsonb) shape
          JOIN webhook_events w ON w.raw_payload @> shape
          WHERE w.received_at < $1::timestamptz AND (w.ingest_source='meta_webhook' OR w.ingest_source IS NULL)
            AND ($3::timestamptz IS NULL OR (w.received_at,w.id) > ($3::timestamptz,$4::uuid))
          ORDER BY w.received_at,w.id LIMIT 500`,
        [start.toISOString(), JSON.stringify(chunk.map(containsShape)), cursor?.at ?? null, cursor?.id ?? null]);
        for (const row of prior.rows) {
          for (const event of verifiedShapeEvents(row)) events.delete(eventIdentity(event));
        }
        if (prior.rows.length < 500) break;
        const last = prior.rows.at(-1)!;
        cursor = { at: last.cursor_at, id: last.id };
      }
    }
  }
}

const MANUAL_SQL = `WITH actions AS (
  SELECT a.platform,a.channel_id,coalesce(n.kind,'comment') AS kind,a.external_id,'reply' AS action
  FROM reply_audit a LEFT JOIN normalized_events n ON n.id=a.normalized_event_id
  WHERE a.status='sent' AND a.updated_at >= $1::timestamptz AND a.updated_at <= $2::timestamptz
    AND ($3::text='all' OR a.platform=$3)
  UNION ALL
  SELECT platform,channel_id,'comment',external_id,CASE WHEN hidden THEN 'hide' ELSE 'restore' END
  FROM comment_moderation_audit
  WHERE status='sent' AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz
    AND ($3::text='all' OR platform=$3)
  UNION ALL
  SELECT platform,channel_id,'comment',external_id,action FROM comment_action_audit
  WHERE status='sent' AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz
    AND ($3::text='all' OR platform=$3)
  UNION ALL
  SELECT n.platform,n.channel_id,n.kind,n.external_id,'no_action'
  FROM rule_runs r JOIN normalized_events n ON n.id=r.normalized_event_id
  WHERE r.review_status='dismissed' AND r.reviewed_by IS NOT NULL
    AND r.reviewed_at >= $1::timestamptz AND r.reviewed_at <= $2::timestamptz
    AND ($3::text='all' OR n.platform=$3)
)
SELECT count(DISTINCT (platform,channel_id,kind,external_id))::int AS processed,
  count(*) FILTER (WHERE action='reply')::int AS replies,
  count(*) FILTER (WHERE action='hide')::int AS hidden,
  count(*) FILTER (WHERE action='restore')::int AS restored,
  count(*) FILTER (WHERE action='no_action')::int AS no_action,
  count(*) FILTER (WHERE action='delete')::int AS deleted,
  count(*) FILTER (WHERE action IN ('like','unlike','block','unblock'))::int AS other_actions FROM actions`;

const RULE_SQL = `SELECT
  count(*) FILTER (WHERE r.outcome IN ('hidden','already_hidden','kept','review','failed'))::int AS processed,
  count(*) FILTER (WHERE r.outcome='hidden')::int AS hidden,
  EXISTS (SELECT 1 FROM inbox_rules WHERE enabled AND category='moderation'
    AND ($3::text='all' OR platform='all' OR platform=$3)) AS automation_enabled
  FROM rule_runs r JOIN normalized_events n ON n.id=r.normalized_event_id
  WHERE r.status='completed' AND n.ingest_source='meta_webhook' AND n.rule_eligible
    AND n.created_at >= $1::timestamptz AND n.created_at <= $2::timestamptz
    AND r.processed_at <= $2::timestamptz
    AND ($3::text='all' OR n.platform=$3)`;
