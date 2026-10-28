import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { buildEventKey } from '../events/event-key.js';
import type { EventRepository } from '../events/event-repository.js';
import { normalizeMetaPayload } from '../events/normalize.js';
import type { MetaWebhookPayload } from '../events/types.js';
import { logSafeError } from '../safe-log.js';
import { exceedsMaxDepth, sanitizeForJsonb } from './payload-sanitize.js';
import { verifyMetaSignature } from './signature.js';

/** Minimal storage contract the receive chain needs (satisfied by EventRepository). */
export type RawEventStore = Pick<EventRepository, 'storeVerifiedWebhook'>;

const UNKNOWN_PLATFORM_OBJECT = 'unknown';

/** Upper bound for a webhook POST body; larger bodies get 413 and are never stored. */
const MAX_BODY_SIZE = '1mb';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
    const candidate = typeof status === 'number' ? status : statusCode;

    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }

  return 500;
}

function platformObjectOf(payload: Record<string, unknown>): string {
  // An unknown object must not make us drop a signature-verified payload.
  return typeof payload.object === 'string' && payload.object !== ''
    ? payload.object
    : UNKNOWN_PLATFORM_OBJECT;
}

export interface MetaWebhookRouterDependencies {
  verifyToken: string;
  appSecret: string;
  eventStore: RawEventStore;
}

export function createMetaWebhookRouter(
  dependencies: MetaWebhookRouterDependencies,
): Router {
  const router = Router();

  router.get('/', (request, response) => {
    const mode = request.query['hub.mode'];
    const verifyToken = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    if (
      mode !== 'subscribe' ||
      verifyToken !== dependencies.verifyToken ||
      typeof challenge !== 'string'
    ) {
      response.sendStatus(403);
      return;
    }

    response.status(200).type('text/plain').send(challenge);
  });

  router.post(
    '/',
    express.raw({ type: '*/*', limit: MAX_BODY_SIZE }),
    async (request, response) => {
      const rawBody = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      const signature = request.get('x-hub-signature-256');

      if (!verifyMetaSignature(rawBody, signature, dependencies.appSecret)) {
        response.sendStatus(401);
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        response.sendStatus(400);
        return;
      }

      if (!isPlainObject(payload)) {
        response.sendStatus(400);
        return;
      }

      if (exceedsMaxDepth(payload)) {
        response.sendStatus(400);
        return;
      }

      let eventKey: string | undefined;
      try {
        // The key is derived from the ORIGINAL payload and only the stored
        // copy is cleaned of NUL and lone surrogates. Meta retries resend
        // identical bytes, so the key stays stable no matter how cleaning
        // evolves.
        eventKey = buildEventKey(payload as unknown as MetaWebhookPayload);
        const storedPayload = sanitizeForJsonb(payload) as Record<string, unknown>;

        await dependencies.eventStore.storeVerifiedWebhook({
          platformObject: platformObjectOf(storedPayload),
          eventKey,
          rawPayload: storedPayload,
          events: normalizeMetaPayload(storedPayload),
        });
      } catch (error) {
        // Never answer 200 when persistence failed: 500 makes Meta retry, a
        // 200 would silently lose the event. Log through the whitelist only
        // (error type, SQLSTATE, event key): never the error message, the
        // payload (customer messages are personal data), the signature or
        // connection details.
        logSafeError('Failed to store Meta webhook', error, eventKey);
        response.sendStatus(500);
        return;
      }

      response.sendStatus(200);
    },
  );

  // Errors raised before the handler runs (body-parser): 413 for oversized
  // bodies, other 4xx as-is, anything else 500. Always without an HTML body
  // and without error details.
  router.use(
    (error: unknown, _request: Request, response: Response, next: NextFunction) => {
      if (response.headersSent) {
        next(error);
        return;
      }

      const status = errorStatus(error);

      if (status === 413) {
        response.status(413).end();
        return;
      }

      if (status >= 400 && status < 500) {
        response.sendStatus(status);
        return;
      }

      logSafeError('Unexpected error on Meta webhook route', error);
      response.sendStatus(500);
    },
  );

  return router;
}
