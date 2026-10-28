import { randomBytes, timingSafeEqual } from 'node:crypto';

import express, { Router, type Request, type Response } from 'express';

import type { ConnectSettings } from '../config.js';
import { logSafeError } from '../safe-log.js';
import { completeAuthorization, type AuthorizationStore, type ConnectSummary } from './connect-flow.js';
import { ConnectFlowError, type MetaOauthClient } from './oauth-client.js';
import { noticeFor, renderConnectPage } from './connect-page.js';
import {
  openPayload,
  readCookie,
  sealPayload,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  setCookie,
  signingKey,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
} from './session.js';

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

export interface ConnectRouterDependencies {
  settings: ConnectSettings;
  oauth: MetaOauthClient;
  channels: AuthorizationStore;
  now?: () => Date;
  /** When set, the password form is closed and only this check may open the page. */
  adminGuard?: (request: Request) => Promise<boolean>;
  rememberAuthorizer?: (facebookUserId: string, request: Request) => Promise<void>;
}

function passwordsEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function oneQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeCode(value: string | undefined): string | undefined {
  return value && SAFE_CODE.test(value) ? value : undefined;
}

export function createConnectRouter(dependencies: ConnectRouterDependencies): Router {
  const router = Router();
  const key = signingKey(dependencies.settings.tokenKey);
  const { mountPath, cookiePath, password, redirectUri } = dependencies.settings;
  const now = dependencies.now ?? (() => new Date());

  router.use(express.urlencoded({ extended: false, limit: '2kb' }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    next();
  });

  function seconds(): number {
    return Math.floor(now().getTime() / 1000);
  }

  function loggedIn(request: Request): boolean {
    const raw = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!raw) {
      return false;
    }
    return openPayload(key, raw, seconds())?.kind === 'session';
  }

  async function allowed(request: Request): Promise<boolean> {
    if (dependencies.adminGuard) {
      return dependencies.adminGuard(request);
    }
    return loggedIn(request);
  }

  function redirect(response: Response, query?: string): void {
    const target = query ? `${mountPath}?${query}` : mountPath;
    response.redirect(303, target);
  }

  async function render(response: Response, request: Request, session: boolean): Promise<void> {
    const summary: ConnectSummary = session
      ? await dependencies.channels.summary()
      : { grants: [], channels: [] };
    const error = safeCode(oneQuery(request.query.error));
    const connected = oneQuery(request.query.connected) === '1';
    const notice = error ? noticeFor(error) : (connected ? noticeFor('connected') : undefined);
    response
      .status(200)
      .type('html')
      .send(renderConnectPage(pageView(session, summary, notice)));
  }

  function pageView(loggedIn: boolean, summary: ConnectSummary, notice?: string) {
    return {
      mountPath,
      redirectUri,
      loggedIn,
      summary,
      notice,
      returnHref: dependencies.adminGuard ? '/inbox/workbench' : undefined,
    };
  }

  router.get('/', async (request, response) => {
    const session = await allowed(request);
    if (dependencies.adminGuard && !session) {
      response.redirect(303, '/inbox/auth/dingtalk/start');
      return;
    }
    await render(response, request, session);
  });

  router.post('/login', (request, response) => {
    if (dependencies.adminGuard) {
      response.redirect(303, '/inbox/auth/dingtalk/start');
      return;
    }
    const provided = isRecord(request.body) && typeof request.body.password === 'string'
      ? request.body.password
      : '';
    if (!passwordsEqual(provided, password)) {
      response
        .status(401)
        .type('html')
        .send(renderConnectPage(pageView(false, { grants: [], channels: [] }, noticeFor('login_failed'))));
      return;
    }

    const token = sealPayload(key, { kind: 'session', exp: seconds() + SESSION_TTL_SECONDS });
    response.append('Set-Cookie', setCookie(SESSION_COOKIE, token, cookiePath, SESSION_TTL_SECONDS));
    redirect(response);
  });

  router.post('/logout', (_request, response) => {
    response.append('Set-Cookie', setCookie(SESSION_COOKIE, '', cookiePath, 0));
    redirect(response);
  });

  router.get('/facebook/start', async (request, response) => {
    if (!(await allowed(request))) {
      redirect(response, 'error=login_required');
      return;
    }

    const nonce = randomBytes(32).toString('base64url');
    const token = sealPayload(key, {
      kind: 'state',
      exp: seconds() + STATE_TTL_SECONDS,
      nonce,
    });
    response.append('Set-Cookie', setCookie(STATE_COOKIE, token, cookiePath, STATE_TTL_SECONDS));
    response.redirect(303, dependencies.oauth.buildAuthorizationUrl(nonce, request.query.comment_actions === 'instagram' ? 'instagram' : request.query.comment_actions === 'facebook' ? 'facebook' : undefined));
  });

  router.get('/facebook/callback', async (request, response) => {
    if (!(await allowed(request))) {
      redirect(response, 'error=login_required');
      return;
    }

    const rawState = readCookie(request.headers.cookie, STATE_COOKIE);
    const state = rawState ? openPayload(key, rawState, seconds()) : undefined;
    response.append('Set-Cookie', setCookie(STATE_COOKIE, '', cookiePath, 0));
    const queryState = oneQuery(request.query.state);
    if (!state || state.kind !== 'state' || !queryState || !sameString(state.nonce, queryState)) {
      redirect(response, 'error=state_mismatch');
      return;
    }

    const facebookError = safeCode(oneQuery(request.query.error));
    if (facebookError) {
      redirect(response, `error=${facebookError}`);
      return;
    }

    const code = oneQuery(request.query.code);
    if (!code) {
      redirect(response, 'error=missing_code');
      return;
    }

    try {
      const facebookUserId = await completeAuthorization(dependencies.oauth, dependencies.channels, code, now());
      await dependencies.rememberAuthorizer?.(facebookUserId, request);
      redirect(response, 'connected=1');
    } catch (error) {
      const failure = error instanceof ConnectFlowError ? error.code : 'connect_failed';
      if (!(error instanceof ConnectFlowError)) {
        logSafeError('Facebook connect callback failed', error);
      }
      redirect(response, `error=${safeCode(failure) ?? 'connect_failed'}`);
    }
  });

  return router;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
