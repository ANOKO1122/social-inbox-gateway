import { isIP } from 'node:net';

export interface AppConfig {
  port: number;
  /** Bind address inside the process/container. Exposure is decided by the compose `ports` mapping. */
  host: string;
  databaseUrl: string;
  metaVerifyToken: string;
  metaAppSecret: string;
  /** Graph version such as `v23.0`. Defaults when `META_GRAPH_VERSION` is unset. */
  metaGraphVersion?: string;
  /** Page or Instagram tokens keyed by `normalized_events.channel_id`. */
  metaChannelTokens?: Record<string, string>;
  /** Absent means `POST /api/events/:id/replies` answers 401. Webhook startup does not require it. */
  internalApiToken?: string;
  /** Absent means the connect page is not mounted. Webhook startup does not require it. */
  connect?: ConnectSettings;
  /** Absent means DingTalk login and the workbench are not mounted. */
  dingtalk?: DingTalkSettings;
  /** Absent means reply suggestions are off. Manual replies still work. */
  dify?: DifySettings;
  ruleAi?: DifySettings;
}

export interface DifySettings {
  /** Workflow API origin, including `/v1`, with no trailing slash. */
  apiBase: string;
  apiKey: string;
}

export interface DingTalkSettings {
  clientId: string;
  clientSecret: string;
  /** Recorded for the operator. OAuth uses `clientId`, not this value. */
  appId?: string;
  redirectUri: string;
}

export interface ConnectSettings {
  appId: string;
  redirectUri: string;
  mountPath: string;
  cookiePath: string;
  tokenKey: Buffer;
  password: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 4010);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_GRAPH_VERSION = 'v23.0';
const GRAPH_VERSION = /^v[0-9]+\.[0-9]+$/;

function parseGraphVersion(value: string | undefined): string {
  if (!value) {
    return DEFAULT_GRAPH_VERSION;
  }

  if (!GRAPH_VERSION.test(value)) {
    throw new Error('META_GRAPH_VERSION');
  }

  return value;
}

function parseChannelTokens(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('META_CHANNEL_TOKENS');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('META_CHANNEL_TOKENS');
  }

  const tokens: Record<string, string> = {};
  for (const [channelId, token] of Object.entries(parsed)) {
    if (channelId.length === 0 || typeof token !== 'string' || token.length === 0) {
      throw new Error('META_CHANNEL_TOKENS');
    }
    tokens[channelId] = token;
  }

  return tokens;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value ? value : undefined;
}

function parseHost(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_HOST;
  }

  if (value !== 'localhost' && isIP(value) === 0) {
    throw new Error('HOST must be an IPv4 or IPv6 address literal or "localhost"');
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const connect = parseConnect(env);
  const dingtalk = parseDingTalk(env);
  if (dingtalk && !connect) {
    throw new Error('META_TOKEN_KEY');
  }

  return {
    port: parsePort(env.PORT),
    host: parseHost(env.HOST),
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    metaVerifyToken: requireEnv(env, 'META_VERIFY_TOKEN'),
    metaAppSecret: requireEnv(env, 'META_APP_SECRET'),
    metaGraphVersion: parseGraphVersion(env.META_GRAPH_VERSION),
    metaChannelTokens: parseChannelTokens(env.META_CHANNEL_TOKENS),
    internalApiToken: optionalEnv(env, 'INTERNAL_API_TOKEN'),
    connect,
    dingtalk,
    dify: parseDify(env),
    ruleAi: optionalEnv(env, 'RULE_AI_API_KEY') ? parseDify({ ...env, DIFY_API_KEY: env.RULE_AI_API_KEY }) : undefined,
  };
}

const APP_ID = /^[0-9]{5,32}$/;
const TOKEN_KEY = /^[0-9a-fA-F]{64}$/;
const CONNECT_PASSWORD = /^[^\u0000-\u001f\u007f]{16,128}$/;

function parseConnect(env: NodeJS.ProcessEnv): ConnectSettings | undefined {
  const appId = optionalEnv(env, 'META_APP_ID');
  const redirectUri = optionalEnv(env, 'META_OAUTH_REDIRECT_URI');
  const tokenKey = optionalEnv(env, 'META_TOKEN_KEY');
  const password = optionalEnv(env, 'CONNECT_PASSWORD');
  if (!appId && !redirectUri && !tokenKey && !password) {
    return undefined;
  }

  if (!appId) {
    throw new Error('Missing required environment variable: META_APP_ID');
  }
  if (!redirectUri) {
    throw new Error('Missing required environment variable: META_OAUTH_REDIRECT_URI');
  }
  if (!tokenKey) {
    throw new Error('Missing required environment variable: META_TOKEN_KEY');
  }
  if (!password) {
    throw new Error('Missing required environment variable: CONNECT_PASSWORD');
  }
  if (!APP_ID.test(appId)) {
    throw new Error('META_APP_ID');
  }
  if (!TOKEN_KEY.test(tokenKey)) {
    throw new Error('META_TOKEN_KEY');
  }
  if (!CONNECT_PASSWORD.test(password)) {
    throw new Error('CONNECT_PASSWORD');
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error('META_OAUTH_REDIRECT_URI');
  }

  const suffix = '/facebook/callback';
  const mountPath = url.pathname.endsWith(suffix) ? url.pathname.slice(0, -suffix.length) : '';
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/[A-Za-z0-9/_-]+$/.test(mountPath) ||
    mountPath.includes('//') ||
    mountPath.endsWith('/')
  ) {
    throw new Error('META_OAUTH_REDIRECT_URI');
  }

  return {
    appId,
    redirectUri,
    mountPath,
    cookiePath: mountPath,
    tokenKey: Buffer.from(tokenKey, 'hex'),
    password,
  };
}

const DINGTALK_CLIENT_ID = /^[A-Za-z0-9]{8,80}$/;
const DINGTALK_APP_ID = /^[A-Za-z0-9_-]{1,80}$/;

function parseDingTalk(env: NodeJS.ProcessEnv): DingTalkSettings | undefined {
  const clientId = optionalEnv(env, 'DINGTALK_CLIENT_ID');
  const clientSecret = optionalEnv(env, 'DINGTALK_CLIENT_SECRET');
  const appId = optionalEnv(env, 'DINGTALK_APP_ID');
  if (!clientId && !clientSecret && !appId) {
    return undefined;
  }
  if (!clientId) {
    throw new Error('Missing required environment variable: DINGTALK_CLIENT_ID');
  }
  if (!clientSecret) {
    throw new Error('Missing required environment variable: DINGTALK_CLIENT_SECRET');
  }
  if (!DINGTALK_CLIENT_ID.test(clientId)) {
    throw new Error('DINGTALK_CLIENT_ID');
  }
  if (clientSecret.length < 8 || clientSecret.length > 256 || /[\u0000-\u001f\u007f]/.test(clientSecret)) {
    throw new Error('DINGTALK_CLIENT_SECRET');
  }
  if (appId && !DINGTALK_APP_ID.test(appId)) {
    throw new Error('DINGTALK_APP_ID');
  }

  return {
    clientId,
    clientSecret,
    appId,
    redirectUri: dingtalkRedirect(env),
  };
}

const DIFY_API_KEY = /^app-[A-Za-z0-9]{16,128}$/;

function parseDify(env: NodeJS.ProcessEnv): DifySettings | undefined {
  const apiBase = optionalEnv(env, 'DIFY_API_BASE');
  const apiKey = optionalEnv(env, 'DIFY_API_KEY');
  if (!apiBase && !apiKey) {
    return undefined;
  }
  if (!apiBase) {
    throw new Error('Missing required environment variable: DIFY_API_BASE');
  }
  if (!apiKey) {
    throw new Error('Missing required environment variable: DIFY_API_KEY');
  }
  if (!DIFY_API_KEY.test(apiKey)) {
    throw new Error('DIFY_API_KEY');
  }

  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error('DIFY_API_BASE');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    path !== '/v1'
  ) {
    throw new Error('DIFY_API_BASE');
  }

  return { apiBase: `${url.origin}/v1`, apiKey };
}

function dingtalkRedirect(env: NodeJS.ProcessEnv): string {
  const oauth = optionalEnv(env, 'META_OAUTH_REDIRECT_URI');
  let origin = '';
  if (oauth) {
    try {
      const url = new URL(oauth);
      if (url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '') {
        origin = url.origin;
      }
    } catch {
      origin = '';
    }
  }
  if (!origin) {
    throw new Error('DINGTALK_REDIRECT_URI');
  }
  return `${origin}/inbox/auth/dingtalk/callback`;
}
