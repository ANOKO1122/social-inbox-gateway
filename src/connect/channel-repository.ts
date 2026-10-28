import { decryptToken, encryptToken } from './token-box.js';
import type {
  AuthorizationStore,
  ChannelSummary,
  ConnectSummary,
  GrantSummary,
  SaveAuthorization,
  SaveChannel,
} from './connect-flow.js';
import { PAGE_SUBSCRIBED_FIELDS } from './oauth-client.js';
import type { CommentAuthorization } from '../meta/reply-router.js';

const OBJECT_ID = /^[0-9]{5,32}$/;
const SCOPE = /^[a-z_]{1,64}$/;
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

interface Row {
  [column: string]: unknown;
}

interface DbClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(err?: Error | boolean): void;
}

export interface ChannelDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  connect(): Promise<DbClient>;
}

function invalid(): never {
  throw new Error('invalid_authorization');
}

function cleanScopes(scopes: string[]): string {
  const unique = [...new Set(scopes.filter((scope) => SCOPE.test(scope)))].sort();
  return unique.join(',');
}

function storedChannel(channel: SaveChannel): {
  kind: SaveChannel['kind'];
  externalId: string;
  name: string;
  pageId: string;
  token: string;
  subscribedFields: string | null;
  subscriptionError: string | null;
} {
  if (channel.kind !== 'facebook_page' && channel.kind !== 'instagram') {
    invalid();
  }
  if (!OBJECT_ID.test(channel.externalId) || !OBJECT_ID.test(channel.pageId)) {
    invalid();
  }
  if (
    channel.name.length === 0 ||
    channel.name.length > 200 ||
    CONTROL_CHARACTER.test(channel.name) ||
    channel.accessToken.length === 0 ||
    CONTROL_CHARACTER.test(channel.accessToken)
  ) {
    invalid();
  }

  const subscriptionError = channel.subscriptionError === null
    ? null
    : (SAFE_CODE.test(channel.subscriptionError) ? channel.subscriptionError : 'graph_error');
  const subscribed = channel.subscribed && subscriptionError === null;

  return {
    kind: channel.kind,
    externalId: channel.externalId,
    name: channel.name,
    pageId: channel.pageId,
    token: channel.accessToken,
    subscribedFields: subscribed ? PAGE_SUBSCRIBED_FIELDS : null,
    subscriptionError: subscribed ? null : subscriptionError,
  };
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return undefined;
}

export class ChannelRepository implements AuthorizationStore {
  constructor(
    private readonly db: ChannelDb,
    private readonly tokenKey: Buffer,
  ) {}

  async save(input: SaveAuthorization): Promise<void> {
    if (!OBJECT_ID.test(input.facebookUserId) || Number.isNaN(input.userTokenExpiresAt.getTime())) {
      invalid();
    }
    if (input.userToken.length === 0 || CONTROL_CHARACTER.test(input.userToken)) {
      invalid();
    }

    const channels = input.channels.map(storedChannel);
    const scopes = cleanScopes(input.scopes);
    const client = await this.db.connect();
    let rollbackError: Error | undefined;

    try {
      await client.query('BEGIN');
      const grant = await client.query(
        `INSERT INTO meta_user_grants (
           facebook_user_id, encrypted_user_token, user_token_expires_at, scopes
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (facebook_user_id) DO UPDATE SET
           encrypted_user_token = EXCLUDED.encrypted_user_token,
           user_token_expires_at = EXCLUDED.user_token_expires_at,
           scopes = EXCLUDED.scopes,
           updated_at = now()
         RETURNING id`,
        [
          input.facebookUserId,
          encryptToken(this.tokenKey, input.userToken),
          input.userTokenExpiresAt,
          scopes,
        ],
      );
      const grantId = grant.rows[0]?.id;
      if (typeof grantId !== 'string' || grantId.length === 0) {
        throw new Error('invalid_authorization');
      }

      for (const channel of channels) {
        await client.query(
          `INSERT INTO meta_channels (
             grant_id, kind, external_id, name, page_id, encrypted_access_token,
             subscribed_fields, subscription_error
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (kind, external_id) DO UPDATE SET
             grant_id = EXCLUDED.grant_id,
             name = EXCLUDED.name,
             page_id = EXCLUDED.page_id,
             encrypted_access_token = EXCLUDED.encrypted_access_token,
             subscribed_fields = EXCLUDED.subscribed_fields,
             subscription_error = EXCLUDED.subscription_error,
             updated_at = now()`,
          [
            grantId,
            channel.kind,
            channel.externalId,
            channel.name,
            channel.pageId,
            encryptToken(this.tokenKey, channel.token),
            channel.subscribedFields,
            channel.subscriptionError,
          ],
        );
      }

      await client.query(
        `DELETE FROM meta_channels
         WHERE grant_id = $1
           AND NOT ((kind || ':' || external_id) = ANY($2::text[]))`,
        [grantId, channels.map((channel) => `${channel.kind}:${channel.externalId}`)],
      );
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error
          ? rollbackFailure
          : new Error('rollback');
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

  async tokenForChannel(channelId: string): Promise<string | undefined> {
    const tokens = await this.tokensForChannel(channelId);
    return tokens[0];
  }

  async tokensForChannel(channelId: string): Promise<string[]> {
    if (!OBJECT_ID.test(channelId)) {
      return [];
    }

    const result = await this.db.query(
      `SELECT c.encrypted_access_token
       FROM meta_channels c
       JOIN meta_user_grants g ON g.id = c.grant_id
       WHERE c.external_id = $1
         AND g.user_token_expires_at > now()
       ORDER BY (
         SELECT count(*)::int FROM meta_channels c2 WHERE c2.grant_id = g.id
       ) DESC, g.updated_at DESC
       LIMIT 8`,
      [channelId],
    );
    const tokens: string[] = [];
    for (const row of result.rows) {
      const stored = row.encrypted_access_token;
      if (typeof stored !== 'string' || stored.length === 0) {
        continue;
      }
      try {
        tokens.push(decryptToken(this.tokenKey, stored));
      } catch {
        continue;
      }
    }
    return tokens;
  }

  async commentAuthorizations(channelId: string, platform: 'facebook' | 'instagram'): Promise<CommentAuthorization[]> {
    if (!OBJECT_ID.test(channelId)) return [];
    const result = await this.db.query(`SELECT c.page_id, c.encrypted_access_token,
        g.encrypted_user_token, g.scopes FROM meta_channels c JOIN meta_user_grants g ON g.id=c.grant_id
      WHERE c.external_id=$1 AND c.kind=$2 AND g.user_token_expires_at>now()
      ORDER BY g.updated_at DESC LIMIT 8`, [channelId, platform === 'instagram' ? 'instagram' : 'facebook_page']);
    return result.rows.flatMap(row => {
      try {
        if (typeof row.page_id !== 'string' || typeof row.encrypted_access_token !== 'string') return [];
        const authorization: CommentAuthorization = { pageId: row.page_id,
          pageToken: decryptToken(this.tokenKey, row.encrypted_access_token),
          scopes: typeof row.scopes === 'string' ? row.scopes.split(',') : [] };
        if (typeof row.encrypted_user_token === 'string') authorization.userToken = decryptToken(this.tokenKey, row.encrypted_user_token);
        return [authorization];
      } catch { return []; }
    });
  }

  async summary(): Promise<ConnectSummary> {
    const result = await this.db.query(
      `SELECT
         g.facebook_user_id,
         g.user_token_expires_at,
         g.scopes,
         c.kind,
         c.external_id,
         c.name,
         c.page_id,
         c.subscribed_fields,
         c.subscription_error
       FROM meta_user_grants g
       LEFT JOIN meta_channels c ON c.grant_id = g.id
       ORDER BY g.user_token_expires_at DESC, c.kind, c.external_id`,
      [],
    );

    const grants = new Map<string, GrantSummary>();
    const channels: ChannelSummary[] = [];

    for (const row of result.rows) {
      const facebookUserId = row.facebook_user_id;
      const expiresAt = asDate(row.user_token_expires_at);
      if (typeof facebookUserId !== 'string' || !expiresAt) {
        continue;
      }
      if (!grants.has(facebookUserId)) {
        const scopes = typeof row.scopes === 'string' && row.scopes.length > 0
          ? row.scopes.split(',').filter((scope) => SCOPE.test(scope))
          : [];
        grants.set(facebookUserId, { facebookUserId, expiresAt, scopes });
      }

      if (row.kind !== 'facebook_page' && row.kind !== 'instagram') {
        continue;
      }
      if (typeof row.external_id !== 'string' || typeof row.name !== 'string' || typeof row.page_id !== 'string') {
        continue;
      }
      const subscriptionError = typeof row.subscription_error === 'string' ? row.subscription_error : null;
      channels.push({
        kind: row.kind,
        externalId: row.external_id,
        name: row.name,
        pageId: row.page_id,
        subscribed: row.subscribed_fields === PAGE_SUBSCRIBED_FIELDS && subscriptionError === null,
        subscriptionError,
      });
    }

    return { grants: [...grants.values()], channels };
  }

  async attachAuthorizer(facebookUserId: string, staffUserId: string): Promise<void> {
    if (!/^[0-9]{5,32}$/.test(facebookUserId) || !/^[0-9a-f-]{36}$/i.test(staffUserId)) {
      return;
    }
    await this.db.query(
      `UPDATE meta_user_grants
       SET authorized_by = $2, updated_at = now()
       WHERE facebook_user_id = $1`,
      [facebookUserId, staffUserId],
    );
  }
}
