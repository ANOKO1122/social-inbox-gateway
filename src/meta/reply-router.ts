import { timingSafeEqual } from 'node:crypto';

import express, { Router, type NextFunction, type Request, type Response } from 'express';

import type {
  ClaimReplyInput,
  ClaimReplyResult,
  CompleteReplyInput,
  StoredNormalizedEvent,
} from '../events/event-repository.js';
import { logSafeError } from '../safe-log.js';
import { localReplyFailure, type GraphReplyClient, type GraphReplyResult } from './reply-client.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TOKEN = /^[A-Za-z0-9_]{1,64}$/;

export interface ReplyEventLookup {
  findNormalizedEventById(id: string): Promise<StoredNormalizedEvent | null>;
}

export interface ReplyStore {
  claimReply(input: ClaimReplyInput): Promise<ClaimReplyResult>;
  completeReply(input: CompleteReplyInput): Promise<void>;
}

export interface ChannelTokenResolver {
  tokenForChannel(channelId: string): Promise<string | undefined>;
  /** Unexpired page tokens, most pages covered first. Absent means one token. */
  tokensForChannel?(channelId: string): Promise<string[]>;
  commentAuthorizations?(channelId: string, platform: 'facebook' | 'instagram'): Promise<CommentAuthorization[]>;
}

export interface CommentAuthorization {
  pageId: string;
  pageToken: string;
  userToken?: string;
  scopes: string[];
}

export interface ReplyRouterDependencies {
  internalApiToken?: string;
  channelTokens: Record<string, string>;
  /** Used only when `channelTokens` has no entry for the event's channel. */
  channelTokenResolver?: ChannelTokenResolver;
  events: ReplyEventLookup;
  replies: ReplyStore;
  client: GraphReplyClient;
}

function jsonError(response: Response, status: number, error: string, type?: string): void {
  if (type) {
    response.status(status).json({ error, type });
    return;
  }
  response.status(status).json({ error });
}

function safeCode(value: string): string {
  return SAFE_TOKEN.test(value) ? value : 'unspecified_error';
}

function safeType(value: string | null | undefined): string | undefined {
  return value && SAFE_TOKEN.test(value) ? value : undefined;
}

function tokensEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer (.+)$/i.exec(header);
  return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonParseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (record.type === 'entity.parse.failed') {
    return true;
  }
  const status = typeof record.status === 'number' ? record.status : record.statusCode;
  return error instanceof SyntaxError && status === 400;
}

function isBodyTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof record.status === 'number' ? record.status : record.statusCode;
  return record.type === 'entity.too.large' || status === 413;
}

export function createReplyRouter(dependencies: ReplyRouterDependencies): Router {
  const router = Router();

  router.post(
    '/:id/replies',
    express.json({ limit: '64kb' }),
    async (request, response) => {
      try {
        await handleReply(dependencies, request, response);
      } catch (error) {
        logSafeError('Meta reply failed', error);
        if (!response.headersSent) {
          jsonError(response, 500, 'reply_failed');
        }
      }
    },
  );

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (isBodyTooLarge(error)) {
      jsonError(response, 413, 'body_too_large');
      return;
    }
    if (isJsonParseError(error)) {
      jsonError(response, 400, 'invalid_json');
      return;
    }
    next(error);
  });

  return router;
}

async function handleReply(
  dependencies: ReplyRouterDependencies,
  request: Request,
  response: Response,
): Promise<void> {
  const expected = dependencies.internalApiToken;
  const provided = bearerToken(request.get('authorization'));
  if (!expected || !provided || !tokensEqual(provided, expected)) {
    jsonError(response, 401, 'unauthorized');
    return;
  }

  if (!isRecord(request.body)) {
    jsonError(response, 400, 'invalid_json');
    return;
  }

  const idempotencyKey = request.body.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    jsonError(response, 400, 'idempotency_key_invalid');
    return;
  }

  const text = request.body.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    jsonError(response, 400, 'text_invalid');
    return;
  }

  const eventId = request.params.id;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
    jsonError(response, 404, 'not_found');
    return;
  }

  const event = await dependencies.events.findNormalizedEventById(eventId);
  if (!event) {
    jsonError(response, 404, 'not_found');
    return;
  }

  const localFailure = localReplyFailure({
    platform: event.platform,
    kind: event.kind,
    channelId: event.channelId,
    senderId: event.senderId,
    externalId: event.externalId,
    text,
  });
  if (localFailure) {
    jsonError(response, 400, localFailure);
    return;
  }

  const mappedToken = dependencies.channelTokens[event.channelId];
  const accessToken = typeof mappedToken === 'string' && mappedToken.length > 0
    ? mappedToken
    : await dependencies.channelTokenResolver?.tokenForChannel(event.channelId);
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    jsonError(response, 422, 'missing_channel_token');
    return;
  }

  const claim = await dependencies.replies.claimReply({
    normalizedEventId: eventId,
    idempotencyKey,
  });

  if (claim.outcome === 'in_progress') {
    jsonError(response, 409, 'reply_in_progress');
    return;
  }
  if (claim.outcome === 'conflict') {
    jsonError(response, 409, 'idempotency_conflict');
    return;
  }
  if (claim.outcome === 'sent') {
    response.status(200).json({ platformMessageId: claim.platformMessageId });
    return;
  }
  if (claim.outcome === 'failed') {
    jsonError(response, 200, safeCode(claim.errorCode), safeType(claim.errorType));
    return;
  }

  // The claim transaction has committed. Graph is called only after that.
  const result = await dependencies.client.send({
    platform: event.platform,
    kind: event.kind,
    channelId: event.channelId,
    senderId: event.senderId,
    externalId: event.externalId,
    text,
    accessToken,
  });

  if (result.ok) {
    await dependencies.replies.completeReply({
      replyId: claim.replyId,
      status: 'sent',
      platformMessageId: result.platformMessageId,
    });
    response.status(200).json({ platformMessageId: result.platformMessageId });
    return;
  }

  await finishFailure(dependencies, response, claim.replyId, result);
}

async function finishFailure(
  dependencies: ReplyRouterDependencies,
  response: Response,
  replyId: string,
  result: Extract<GraphReplyResult, { ok: false }>,
): Promise<void> {
  const errorCode = safeCode(result.code);
  const errorType = safeType(result.type);
  const logged = new Error('redacted');
  logged.name = errorCode;
  logSafeError('Meta reply failed', logged);
  await dependencies.replies.completeReply({
    replyId,
    status: 'failed',
    errorCode,
    errorType: errorType ?? null,
  });
  jsonError(response, 502, errorCode, errorType);
}
