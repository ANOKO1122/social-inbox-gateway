/**
 * Loosely typed shape of a Meta webhook POST body. Only the fields the
 * gateway already relies on are named; every other field is preserved as-is.
 */
export interface MetaWebhookPayload {
  object: string;
  entry: MetaWebhookEntry[];
  [key: string]: unknown;
}

export interface MetaWebhookEntry {
  id?: string;
  time?: number;
  messaging?: MetaMessagingEvent[];
  changes?: MetaChange[];
  [key: string]: unknown;
}

export interface MetaMessagingEvent {
  message?: {
    mid?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MetaChange {
  field?: string;
  value?: {
    id?: string;
    mid?: string;
    comment_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Platform-neutral event produced by `normalizeMetaPayload`. The raw payload
 * is intentionally not carried here; it is stored separately in webhook_events.
 */
export interface NormalizedEvent {
  platform: 'facebook' | 'instagram';
  kind: 'comment' | 'message';
  /** entry.id: the Facebook Page ID or Instagram account ID that received the event. */
  channelId: string;
  senderId: string;
  /** message.mid for messages, the comment ID for comments. */
  externalId: string;
  /** Parent comment ID for replies; null for top-level comments and messages. */
  parentId: string | null;
  /** null when the event has no text (e.g. attachment-only messages). */
  text: string | null;
  /** ISO 8601 UTC. */
  occurredAt: string;
}
