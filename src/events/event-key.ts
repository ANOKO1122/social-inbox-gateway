/*
 * Event keys are payload-level: one key per whole webhook POST body. They only
 * guarantee idempotency for the same batch being delivered again.
 *
 * normalized_events already keeps the first row for (platform, kind, external_id)
 * and does not overwrite it. Repeated `edited` events, and `reaction` events from
 * different users on the same comment, can still share one event_key, so the
 * later raw payload is dropped.
 *
 * That collision comes from the token for `changes`: it is only [field, verb, item]
 * plus the highest-priority id. The hash algorithm is unchanged.
 */

import { createHash } from 'node:crypto';

import type { MetaWebhookPayload } from './types.js';

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

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function firstId(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const id = nonEmptyString(candidate);

    if (id !== null) {
      return id;
    }
  }

  return null;
}

/**
 * One token per event found in entry[].messaging[] and entry[].changes[].
 *
 * - Event with a platform id: the structured `[kind, id]`, where kind is
 *   `'message'` for messaging events and `[field, verb, item]` for changes.
 * - Event without a platform id: the key-sorted canonical JSON of the event.
 *
 * Tokens are de-duplicated and sorted by their serialised form so the result
 * does not depend on the order in which events arrive.
 */
function collectEventTokens(payload: UnknownRecord): unknown[] {
  const tokens = new Map<string, unknown>();
  const add = (token: unknown): void => {
    tokens.set(JSON.stringify(token), token);
  };

  for (const entry of asArray(payload.entry)) {
    if (!isRecord(entry)) {
      continue;
    }

    for (const event of asArray(entry.messaging)) {
      if (!isRecord(event)) {
        continue;
      }

      const mid = isRecord(event.message) ? nonEmptyString(event.message.mid) : null;

      add(mid !== null ? ['message', mid] : canonicalJson(event));
    }

    for (const change of asArray(entry.changes)) {
      if (!isRecord(change)) {
        continue;
      }

      const value = isRecord(change.value) ? change.value : {};
      const id = firstId(value.comment_id, value.id, value.mid);
      const kind = [stringOrNull(change.field), stringOrNull(value.verb), stringOrNull(value.item)];

      add(id !== null ? [kind, id] : canonicalJson(change));
    }
  }

  return [...tokens.keys()].sort().map((key) => tokens.get(key));
}

/**
 * JSON serialisation with object keys sorted recursively. Array order is
 * preserved. Keys are emitted via JSON.stringify so an own `__proto__` key
 * is kept like any other key.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }

  if (isRecord(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);

    return `{${members.join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const IDS_DOMAIN = 'ids:v1';
const JSON_DOMAIN = 'json:v1';

/**
 * Builds one deterministic idempotency key for a whole Meta webhook payload.
 *
 * - If the payload contains any event: SHA-256 of
 *   `JSON.stringify(['ids:v1', object, sortedEventTokens])`.
 * - If no event is recognised (unknown structure): SHA-256 of
 *   `JSON.stringify(['json:v1', canonicalPayloadJson])`.
 *
 * Hash material is always a structured JSON array (never hand-joined with
 * separators), so distinct inputs cannot collide through delimiter ambiguity.
 * Never depends on receive time, randomness or original object key order.
 */
export function buildEventKey(payload: MetaWebhookPayload): string {
  if (isRecord(payload)) {
    const tokens = collectEventTokens(payload);

    if (tokens.length > 0) {
      const object = typeof payload.object === 'string' ? payload.object : '';

      return sha256Hex(JSON.stringify([IDS_DOMAIN, object, tokens]));
    }
  }

  return sha256Hex(JSON.stringify([JSON_DOMAIN, canonicalJson(payload)]));
}
