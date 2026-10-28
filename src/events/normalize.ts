import { millisecondsToIso, secondsToIso } from './timestamp.js';
import type { NormalizedEvent } from './types.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function normalizeFacebookComment(channelId: string, entry: UnknownRecord, change: unknown): NormalizedEvent | null {
  if (!isRecord(change) || change.field !== 'feed' || !isRecord(change.value)) {
    return null;
  }

  const value = change.value;

  if (value.item !== 'comment' || value.verb !== 'add') {
    return null;
  }

  const externalId = nonEmptyString(value.comment_id);
  const senderId = isRecord(value.from) ? nonEmptyString(value.from.id) : null;
  // entry.time is only a fallback for an absent created_time; a present but
  // implausible created_time means the event is skipped, not silently re-dated.
  const occurredAt =
    value.created_time === undefined || value.created_time === null
      ? secondsToIso(entry.time)
      : secondsToIso(value.created_time);

  // Skip the page's own comments so an auto-reply can never answer itself.
  if (externalId === null || senderId === null || senderId === channelId || occurredAt === null) {
    return null;
  }

  const parentId = nonEmptyString(value.parent_id);

  return {
    platform: 'facebook',
    kind: 'comment',
    channelId,
    senderId,
    externalId,
    // Meta sets parent_id to the post ID for top-level comments.
    parentId: parentId === nonEmptyString(value.post_id) ? null : parentId,
    text: nonEmptyString(value.message),
    occurredAt,
  };
}

function isEchoOrUnknown(isEcho: unknown): boolean {
  return isEcho !== undefined && isEcho !== null && isEcho !== false;
}

/**
 * Private messages have the same structure on both platforms. Only items with
 * a `message.mid` are messages; delivery, read, postback etc. are skipped.
 */
function normalizeMessagingItem(
  platform: NormalizedEvent['platform'],
  channelId: string,
  item: unknown,
): NormalizedEvent | null {
  if (!isRecord(item) || !isRecord(item.message)) {
    return null;
  }

  const message = item.message;
  const externalId = nonEmptyString(message.mid);
  const senderId = isRecord(item.sender) ? nonEmptyString(item.sender.id) : null;
  const occurredAt = millisecondsToIso(item.timestamp);

  // is_echo marks messages sent by the page/account itself. It fails closed:
  // anything other than absent, false or null (e.g. 'true', 'false', 1) is
  // treated as an echo, because wrongly dropping a message is safer than
  // auto-replying to our own. The sender check is a second guard.
  if (
    externalId === null ||
    senderId === null ||
    occurredAt === null ||
    message.is_deleted === true ||
    message.is_edited === true ||
    isEchoOrUnknown(message.is_echo) ||
    senderId === channelId
  ) {
    return null;
  }

  return {
    platform,
    kind: 'message',
    channelId,
    senderId,
    externalId,
    parentId: null,
    text: nonEmptyString(message.text),
    occurredAt,
  };
}

function normalizeInstagramComment(channelId: string, entry: UnknownRecord, change: unknown): NormalizedEvent | null {
  if (!isRecord(change) || change.field !== 'comments' || !isRecord(change.value)) {
    return null;
  }

  const value = change.value;
  // Revision callbacks are handled separately and must never create customer events.
  if (value.verb !== undefined && value.verb !== 'add') return null;
  const externalId = nonEmptyString(value.id);
  const senderId = isRecord(value.from) ? nonEmptyString(value.from.id) : null;
  // The Instagram comments webhook carries no timestamp of its own.
  const occurredAt = secondsToIso(entry.time);

  // Skip the account's own comments so an auto-reply can never answer itself.
  if (externalId === null || senderId === null || senderId === channelId || occurredAt === null) {
    return null;
  }

  return {
    platform: 'instagram',
    kind: 'comment',
    channelId,
    senderId,
    externalId,
    parentId: nonEmptyString(value.parent_id),
    text: nonEmptyString(value.text),
    occurredAt,
  };
}

/** Runs `normalizeItem` over every item; unrecognised or malformed items are dropped one by one. */
function collectEvents(items: unknown, normalizeItem: (item: unknown) => NormalizedEvent | null): NormalizedEvent[] {
  return asArray(items).flatMap((item) => {
    const event = normalizeItem(item);

    return event === null ? [] : [event];
  });
}

function normalizeFacebook(entry: UnknownRecord): NormalizedEvent[] {
  const channelId = nonEmptyString(entry.id);

  if (channelId === null) {
    return [];
  }

  return [
    ...collectEvents(entry.messaging, (item) => normalizeMessagingItem('facebook', channelId, item)),
    ...collectEvents(entry.changes, (change) => normalizeFacebookComment(channelId, entry, change)),
  ];
}

function normalizeInstagram(entry: UnknownRecord): NormalizedEvent[] {
  const channelId = nonEmptyString(entry.id);

  if (channelId === null) {
    return [];
  }

  return [
    ...collectEvents(entry.messaging, (item) => normalizeMessagingItem('instagram', channelId, item)),
    ...collectEvents(entry.changes, (change) => normalizeInstagramComment(channelId, entry, change)),
  ];
}

export function normalizeMetaPayload(payload: unknown): NormalizedEvent[] {
  if (!isRecord(payload)) {
    return [];
  }

  let adapter: (entry: UnknownRecord) => NormalizedEvent[];

  if (payload.object === 'page') {
    adapter = normalizeFacebook;
  } else if (payload.object === 'instagram') {
    adapter = normalizeInstagram;
  } else {
    return [];
  }

  return asArray(payload.entry).flatMap((entry) => (isRecord(entry) ? adapter(entry) : []));
}
