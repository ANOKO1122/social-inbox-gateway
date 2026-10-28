import type { ChannelDb } from '../connect/channel-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface SavedReply {
  id: string;
  title: string;
  body: string;
  platform: 'all' | 'facebook' | 'instagram';
  kind: 'all' | 'comment' | 'message';
  enabled: boolean;
  updatedAt: string;
}

export type SavedReplyInput = Omit<SavedReply, 'id' | 'updatedAt'> & { id?: string };

export interface SavedReplyListOptions {
  q?: string;
  platform?: SavedReply['platform'];
  kind?: SavedReply['kind'];
  includeDisabled?: boolean;
}

export class SavedReplyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedReplyValidationError';
  }
}

function invalid(message: string): never {
  throw new SavedReplyValidationError(message);
}

function text(input: unknown, label: string, max: number): string {
  if (typeof input !== 'string' || input.length > max || CONTROL.test(input)) {
    invalid(`${label}格式不正确，最多 ${max} 个字符。`);
  }
  const value = input.trim();
  if (!value) invalid(`请填写${label}。`);
  return value;
}

function choice<T extends string>(input: unknown, values: readonly T[], label: string): T {
  if (typeof input !== 'string' || !values.includes(input as T)) invalid(`${label}不正确。`);
  return input as T;
}

function replyId(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) invalid('话术编号不正确。');
  return input;
}

function enabled(input: unknown): boolean {
  if (typeof input !== 'boolean') invalid('启用状态格式不正确。');
  return input;
}

export function validateSavedReply(input: unknown): SavedReplyInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('话术格式不正确。');
  const value = input as Record<string, unknown>;
  const title = text(value.title, '话术标题', 80);
  if (/[\t\r\n]/.test(title)) invalid('话术标题请填写为一行。');
  return {
    ...(value.id === undefined ? {} : { id: replyId(value.id) }),
    title,
    body: text(value.body, '话术内容', 8000),
    platform: choice(value.platform, ['all', 'facebook', 'instagram'] as const, '适用平台'),
    kind: choice(value.kind, ['all', 'comment', 'message'] as const, '适用类型'),
    enabled: enabled(value.enabled),
  };
}

/** Only public search filters are read here; callers control whether disabled replies are included. */
export function savedReplyListOptions(input: Record<string, unknown>): SavedReplyListOptions {
  if (input.q !== undefined && (typeof input.q !== 'string' || input.q.length > 200 || CONTROL.test(input.q))) {
    invalid('搜索内容格式不正确，最多 200 个字符。');
  }
  return {
    q: typeof input.q === 'string' ? input.q.trim() : '',
    platform: choice(input.platform ?? 'all', ['all', 'facebook', 'instagram'] as const, '适用平台'),
    kind: choice(input.kind ?? 'all', ['all', 'comment', 'message'] as const, '适用类型'),
  };
}

function fromRow(row: Record<string, unknown>): SavedReply {
  return {
    ...validateSavedReply(row),
    id: replyId(row.id),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class SavedReplyStore {
  constructor(private readonly db: Pick<ChannelDb, 'query'>) {}

  async list(options: SavedReplyListOptions = {}): Promise<SavedReply[]> {
    const filters = savedReplyListOptions({ q: options.q, platform: options.platform, kind: options.kind });
    const result = await this.db.query(`SELECT * FROM saved_replies
      WHERE ($1::boolean OR enabled)
        AND ($2='all' OR platform IN ('all', $2))
        AND ($3='all' OR kind IN ('all', $3))
        AND ($4='' OR strpos(lower(title), lower($4)) > 0 OR strpos(lower(body), lower($4)) > 0)
      ORDER BY enabled DESC, updated_at DESC, id ASC`,
    [options.includeDisabled === true, filters.platform, filters.kind, filters.q]);
    return result.rows.map(fromRow);
  }

  async save(input: unknown): Promise<SavedReply | null> {
    const reply = validateSavedReply(input);
    const values = [reply.title, reply.body, reply.platform, reply.kind, reply.enabled];
    const result = reply.id
      ? await this.db.query(`UPDATE saved_replies SET title=$1, body=$2, platform=$3,
          kind=$4, enabled=$5, updated_at=now() WHERE id=$6 RETURNING *`, [...values, reply.id])
      : await this.db.query(`INSERT INTO saved_replies (title, body, platform, kind, enabled)
          VALUES ($1,$2,$3,$4,$5) RETURNING *`, values);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async setEnabled(id: string, value: boolean): Promise<SavedReply | null> {
    const result = await this.db.query(`UPDATE saved_replies SET enabled=$2,
        updated_at=CASE WHEN enabled IS DISTINCT FROM $2 THEN now() ELSE updated_at END
        WHERE id=$1 RETURNING *`, [replyId(id), enabled(value)]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
}
