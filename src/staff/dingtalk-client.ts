const CLIENT_ID = /^[A-Za-z0-9]{8,80}$/;
const AUTH_CODE = /^[A-Za-z0-9_-]{8,512}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const UNION_ID = /^[A-Za-z0-9_-]{4,128}$/;
const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;
const TIMEOUT_MS = 10_000;

export class DingTalkError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'DingTalkError';
    this.code = code;
  }
}

export interface DingTalkProfile {
  unionId: string;
  name: string;
}

export interface DingTalkClient {
  buildAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<DingTalkProfile>;
}

export interface DingTalkClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

function fail(code: string): never {
  throw new DingTalkError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRedirect(redirectUri: string): void {
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
    !url.pathname.endsWith('/inbox/auth/dingtalk/callback')
  ) {
    fail('invalid_redirect');
  }
}

function allowed(url: URL, host: string): void {
  if (url.protocol !== 'https:' || url.hostname !== host || url.port !== '' || url.username !== '') {
    fail('invalid_dingtalk_host');
  }
}

function cleanName(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 64 * 1024) {
    fail('invalid_dingtalk_response');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail('invalid_dingtalk_response');
  }
}

function errorCode(parsed: unknown, status: number): string {
  if (!isRecord(parsed)) {
    return 'dingtalk_error';
  }
  const code = parsed.code ?? parsed.error;
  if (typeof code === 'string' && SAFE_CODE.test(code)) {
    return code;
  }
  if (typeof code === 'number' && Number.isInteger(code)) {
    return `dingtalk_${code}`;
  }
  return status === 401 ? 'dingtalk_unauthorized' : 'dingtalk_error';
}

export function createDingTalkClient(options: DingTalkClientOptions): DingTalkClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!CLIENT_ID.test(options.clientId) || options.clientSecret.length < 8) {
    throw new DingTalkError('invalid_dingtalk_config');
  }
  assertRedirect(options.redirectUri);

  return {
    buildAuthorizationUrl(state: string): string {
      if (!STATE.test(state)) {
        fail('invalid_state');
      }
      const url = new URL('https://login.dingtalk.com/oauth2/auth');
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('scope', 'openid');
      url.searchParams.set('state', state);
      url.searchParams.set('prompt', 'consent');
      allowed(url, 'login.dingtalk.com');
      if (url.searchParams.get('client_secret') || url.toString().includes(options.clientSecret)) {
        fail('invalid_dingtalk_host');
      }
      return url.toString();
    },

    async exchangeCode(code: string): Promise<DingTalkProfile> {
      if (!AUTH_CODE.test(code)) {
        fail('invalid_code');
      }
      const tokenUrl = new URL('https://api.dingtalk.com/v1.0/oauth2/userAccessToken');
      allowed(tokenUrl, 'api.dingtalk.com');
      let tokenResponse: Response;
      try {
        tokenResponse = await fetchImpl(tokenUrl, {
          method: 'POST',
          redirect: 'manual',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            code,
            grantType: 'authorization_code',
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'dingtalk_unreachable');
      }
      const tokenBody = await readJson(tokenResponse);
      if (tokenResponse.status < 200 || tokenResponse.status >= 300 || !isRecord(tokenBody)) {
        fail(errorCode(tokenBody, tokenResponse.status));
      }
      const accessToken = tokenBody.accessToken;
      if (typeof accessToken !== 'string' || accessToken.length < 8) {
        fail('invalid_dingtalk_response');
      }

      const meUrl = new URL('https://api.dingtalk.com/v1.0/contact/users/me');
      allowed(meUrl, 'api.dingtalk.com');
      let meResponse: Response;
      try {
        meResponse = await fetchImpl(meUrl, {
          redirect: 'manual',
          headers: {
            Accept: 'application/json',
            'x-acs-dingtalk-access-token': accessToken,
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'dingtalk_unreachable');
      }
      const me = await readJson(meResponse);
      if (meResponse.status < 200 || meResponse.status >= 300 || !isRecord(me)) {
        fail(errorCode(me, meResponse.status));
      }
      if (typeof me.unionId !== 'string' || !UNION_ID.test(me.unionId)) {
        fail('invalid_dingtalk_profile');
      }
      return { unionId: me.unionId, name: cleanName(me.nick, '钉钉用户') };
    },
  };
}
