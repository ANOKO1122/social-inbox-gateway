import { REQUIRED_SCOPES, COMMENT_ACTION_SCOPES, LOGIN_SCOPES } from './scopes.js';

const GRAPH_VERSION = /^v[0-9]+\.[0-9]+$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const CODE = /^[A-Za-z0-9._-]{8,2048}$/;
const OBJECT_ID = /^[0-9]{5,32}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const SCOPE = /^[a-z_]{1,64}$/;
const SAFE_ERROR_TYPE = /^[A-Za-z0-9_]{1,64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const TOKEN_MIN = 20;
const TOKEN_MAX = 4096;
/** Used when Meta omits expires_in or sends 0. About 60 days. */
const DEFAULT_LONG_LIVED_SECONDS = 60 * 24 * 60 * 60;
/** Reminder date cap. A larger or non-numeric value still keeps the token. */
const MAX_REMINDER_SECONDS = 90 * 24 * 60 * 60;
// Bound runaway pagination, but never return a silently truncated account list.
const MAX_PAGE_REQUESTS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

export const PAGE_SUBSCRIBED_FIELDS = 'feed,messages,message_echoes,messaging_referrals,messaging_postbacks';

export class ConnectFlowError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ConnectFlowError';
    this.code = code;
  }
}

export interface FacebookPageAccount {
  id: string;
  name: string;
  accessToken: string;
  instagram: { id: string; username: string } | null;
}

export interface MetaOauthClient {
  buildAuthorizationUrl(state: string, commentActions?: 'facebook' | 'instagram'): string;
  exchangeCode(code: string): Promise<string>;
  exchangeLongLived(token: string): Promise<{ accessToken: string; expiresIn: number }>;
  fetchUserId(token: string): Promise<string>;
  fetchGrantedScopes(token: string): Promise<string[]>;
  listPages(token: string): Promise<FacebookPageAccount[]>;
  subscribePage(pageId: string, pageToken: string): Promise<{ ok: true } | { ok: false; code: string }>;
}

export interface MetaOauthClientOptions {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}

function fail(code: string): never {
  throw new ConnectFlowError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertGraphVersion(graphVersion: string): void {
  if (!GRAPH_VERSION.test(graphVersion)) {
    fail('invalid_graph_version');
  }
}

function assertHttpsRedirect(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    fail('invalid_redirect');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.endsWith('/facebook/callback')
  ) {
    fail('invalid_redirect');
  }
}

function assertToken(token: string): void {
  if (
    token.length < TOKEN_MIN ||
    token.length > TOKEN_MAX ||
    CONTROL_CHARACTER.test(token) ||
    /\s/.test(token)
  ) {
    fail('invalid_token');
  }
}

function graphUrl(graphVersion: string, path: string, query?: Record<string, string>): URL {
  assertGraphVersion(graphVersion);
  const url = new URL(`https://graph.facebook.com/${graphVersion}/${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || url.port !== '') {
    fail('invalid_graph_host');
  }
  return url;
}

function concatBytes(chunks: Uint8Array[], received: number): Uint8Array {
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const room = MAX_BODY_BYTES - received;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        received += room;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return concatBytes(chunks, received);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function graphErrorCode(bytes: Uint8Array): string {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed) || !isRecord(parsed.error)) {
    return 'graph_http_error';
  }
  const { code, type } = parsed.error;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 999_999) {
    return `graph_${code}`;
  }
  if (typeof type === 'string' && SAFE_ERROR_TYPE.test(type)) {
    return 'graph_error';
  }
  return 'graph_http_error';
}

async function requestGraph(
  fetchImpl: typeof fetch,
  url: URL,
  token: string | undefined,
  method: 'GET' | 'POST',
  body?: URLSearchParams,
): Promise<unknown> {
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || url.port !== '') {
    fail('invalid_graph_host');
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      fail('timeout');
    }
    fail('graph_unreachable');
  }

  if (response.status >= 300 && response.status < 400) {
    fail('graph_redirect');
  }

  const bytes = await readLimited(response);
  if (response.status < 200 || response.status >= 300) {
    fail(graphErrorCode(bytes));
  }

  const parsed = parseJson(bytes);
  if (parsed === undefined) {
    fail('invalid_graph_response');
  }
  return parsed;
}

function accessTokenOf(parsed: unknown): string {
  if (!isRecord(parsed) || typeof parsed.access_token !== 'string') {
    fail('invalid_graph_response');
  }
  assertToken(parsed.access_token);
  return parsed.access_token;
}

function lifetimeSeconds(value: unknown): number {
  let seconds: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    seconds = Math.trunc(value);
  } else if (typeof value === 'string' && /^[0-9]{1,10}$/.test(value)) {
    seconds = Number(value);
  }
  if (seconds === undefined || seconds <= 0) {
    return DEFAULT_LONG_LIVED_SECONDS;
  }
  return Math.min(seconds, MAX_REMINDER_SECONDS);
}

function cleanName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : fallback;
}

function pageFrom(value: unknown): FacebookPageAccount | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !OBJECT_ID.test(value.id)) {
    return undefined;
  }
  if (typeof value.access_token !== 'string') {
    return undefined;
  }
  try {
    assertToken(value.access_token);
  } catch {
    return undefined;
  }

  let instagram: FacebookPageAccount['instagram'] = null;
  const ig = value.instagram_business_account;
  if (isRecord(ig) && typeof ig.id === 'string' && OBJECT_ID.test(ig.id)) {
    const username = typeof ig.username === 'string' ? ig.username : ig.id;
    instagram = { id: ig.id, username: cleanName(username, ig.id) };
  }

  return {
    id: value.id,
    name: cleanName(typeof value.name === 'string' ? value.name : value.id, value.id),
    accessToken: value.access_token,
    instagram,
  };
}

export function createMetaOauthClient(options: MetaOauthClientOptions): MetaOauthClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!OBJECT_ID.test(options.appId)) {
    throw new ConnectFlowError('invalid_app_id');
  }
  assertHttpsRedirect(options.redirectUri);
  assertGraphVersion(options.graphVersion);

  return {
    buildAuthorizationUrl(state: string, commentActions?: 'facebook' | 'instagram'): string {
      if (!STATE.test(state)) {
        fail('invalid_state');
      }
      const url = new URL(`https://www.facebook.com/${options.graphVersion}/dialog/oauth`);
      url.searchParams.set('client_id', options.appId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', (commentActions ? [...REQUIRED_SCOPES, ...COMMENT_ACTION_SCOPES[commentActions]] : LOGIN_SCOPES).join(','));
      if (url.hostname !== 'www.facebook.com' || url.protocol !== 'https:' || url.username !== '') {
        fail('invalid_graph_host');
      }
      return url.toString();
    },

    async exchangeCode(code: string): Promise<string> {
      if (!CODE.test(code)) {
        fail('invalid_code');
      }
      const url = graphUrl(options.graphVersion, 'oauth/access_token', {
        client_id: options.appId,
        redirect_uri: options.redirectUri,
        client_secret: options.appSecret,
        code,
      });
      return accessTokenOf(await requestGraph(fetchImpl, url, undefined, 'GET'));
    },

    async exchangeLongLived(token: string): Promise<{ accessToken: string; expiresIn: number }> {
      assertToken(token);
      const url = graphUrl(options.graphVersion, 'oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: options.appId,
        client_secret: options.appSecret,
        fb_exchange_token: token,
      });
      const parsed = await requestGraph(fetchImpl, url, undefined, 'GET');
      const accessToken = accessTokenOf(parsed);
      const expiresIn = lifetimeSeconds(isRecord(parsed) ? parsed.expires_in : undefined);
      return { accessToken, expiresIn };
    },

    async fetchUserId(token: string): Promise<string> {
      assertToken(token);
      const url = graphUrl(options.graphVersion, 'me', { fields: 'id' });
      const parsed = await requestGraph(fetchImpl, url, token, 'GET');
      if (!isRecord(parsed) || typeof parsed.id !== 'string' || !OBJECT_ID.test(parsed.id)) {
        fail('invalid_graph_response');
      }
      return parsed.id;
    },

    async fetchGrantedScopes(token: string): Promise<string[]> {
      assertToken(token);
      const url = graphUrl(options.graphVersion, 'me/permissions');
      const parsed = await requestGraph(fetchImpl, url, token, 'GET');
      if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
        fail('invalid_graph_response');
      }
      const granted: string[] = [];
      for (const item of parsed.data) {
        if (!isRecord(item) || item.status !== 'granted' || typeof item.permission !== 'string') {
          continue;
        }
        if (SCOPE.test(item.permission) && !granted.includes(item.permission)) {
          granted.push(item.permission);
        }
      }
      return granted;
    },

    async listPages(token: string): Promise<FacebookPageAccount[]> {
      assertToken(token);
      const pages: FacebookPageAccount[] = [];
      const seen = new Set<string>();
      let after: string | undefined;
      const seenCursors = new Set<string>();

      for (let request = 0; request < MAX_PAGE_REQUESTS; request += 1) {
        const query: Record<string, string> = {
          fields: 'id,name,access_token,instagram_business_account{id,username}',
          limit: '25',
        };
        if (after) {
          query.after = after;
        }
        const url = graphUrl(options.graphVersion, 'me/accounts', query);
        const parsed = await requestGraph(fetchImpl, url, token, 'GET');
        if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
          fail('invalid_graph_response');
        }

        for (const item of parsed.data) {
          const page = pageFrom(item);
          if (!page || seen.has(page.id)) {
            continue;
          }
          seen.add(page.id);
          pages.push(page);
        }

        const paging = isRecord(parsed.paging) ? parsed.paging : undefined;
        if (!paging?.next) {
          return pages;
        }
        const cursors = paging && isRecord(paging.cursors) ? paging.cursors : undefined;
        const nextAfter = cursors && typeof cursors.after === 'string' ? cursors.after : undefined;
        if (!nextAfter || !CURSOR.test(nextAfter) || seenCursors.has(nextAfter)) {
          fail('invalid_graph_pagination');
        }
        seenCursors.add(nextAfter);
        after = nextAfter;
      }

      fail('graph_pagination_limit');
    },

    async subscribePage(pageId: string, pageToken: string): Promise<{ ok: true } | { ok: false; code: string }> {
      if (!OBJECT_ID.test(pageId)) {
        return { ok: false, code: 'invalid_object_id' };
      }
      try {
        assertToken(pageToken);
      } catch {
        return { ok: false, code: 'invalid_token' };
      }

      const url = graphUrl(options.graphVersion, `${pageId}/subscribed_apps`);
      const body = new URLSearchParams({ subscribed_fields: PAGE_SUBSCRIBED_FIELDS });
      try {
        const parsed = await requestGraph(fetchImpl, url, pageToken, 'POST', body);
        if (isRecord(parsed) && parsed.success === true) {
          return { ok: true };
        }
        return { ok: false, code: 'invalid_graph_response' };
      } catch (error) {
        if (error instanceof ConnectFlowError) {
          return { ok: false, code: error.code };
        }
        return { ok: false, code: 'graph_unreachable' };
      }
    },
  };
}
