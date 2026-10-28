import { secondsToIso } from './timestamp.js';

export interface CommentVisibilityUpdate {
  platform: 'facebook' | 'instagram';
  channelId: string;
  externalId: string;
  hidden: boolean;
  observedAt: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[0-9_]{5,80}$/.test(value);

/** Missing visibility is unknown, never an indication that a comment is public. */
export function extractCommentVisibility(payload: unknown): CommentVisibilityUpdate[] {
  if (!record(payload) || !['page', 'instagram'].includes(String(payload.object)) || !Array.isArray(payload.entry)) return [];
  const platform = payload.object === 'page' ? 'facebook' : 'instagram';
  const updates: CommentVisibilityUpdate[] = [];
  for (const entry of payload.entry) {
    if (!record(entry) || !identifier(entry.id) || !Array.isArray(entry.changes)) continue;
    const observedAt = secondsToIso(entry.time);
    if (!observedAt) continue;
    for (const change of entry.changes) {
      if (!record(change) || !record(change.value)) continue;
      const value = change.value;
      if (platform === 'facebook' ? change.field !== 'feed' || value.item !== 'comment' : change.field !== 'comments') continue;
      const externalId = platform === 'facebook' ? value.comment_id : value.id;
      if (!identifier(externalId)) continue;
      const hidden = platform === 'facebook' && value.verb === 'hide' ? true
        : platform === 'facebook' && value.verb === 'unhide' ? false
        : platform === 'facebook' ? value.is_hidden : value.hidden;
      if (typeof hidden === 'boolean') updates.push({ platform, channelId: entry.id, externalId, hidden, observedAt });
    }
  }
  return updates;
}
