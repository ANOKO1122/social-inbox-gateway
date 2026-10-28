import express, { type Express, type Request } from 'express';

import type { AppConfig } from './config.js';
import { createConnectRouter } from './connect/connect-router.js';
import type { AuthorizationStore } from './connect/connect-flow.js';
import type { MetaOauthClient } from './connect/oauth-client.js';
import { createWorkbenchRouter, type WorkbenchDependencies } from './staff/workbench-router.js';
import { createGraphReplyClient, type GraphReplyClient } from './meta/reply-client.js';
import type { ChannelTokenResolver } from './meta/reply-router.js';
import {
  createReplyRouter,
  type ReplyEventLookup,
  type ReplyStore,
} from './meta/reply-router.js';
import {
  createMetaWebhookRouter,
  type RawEventStore,
} from './meta/webhook-router.js';

export interface AppDependencies {
  config: AppConfig;
  /** Required on purpose: a verified webhook must never be accepted without being stored. */
  eventStore: RawEventStore;
  replyEvents?: ReplyEventLookup;
  replyStore?: ReplyStore;
  replyClient?: GraphReplyClient;
  channelTokenResolver?: ChannelTokenResolver;
  connect?: {
    oauth: MetaOauthClient;
    channels: AuthorizationStore & ChannelTokenResolver;
    adminGuard?: (request: Request) => Promise<boolean>;
    rememberAuthorizer?: (facebookUserId: string, request: Request) => Promise<void>;
  };
  workbench?: WorkbenchDependencies;
}

function replyEventsOf(store: RawEventStore, override: ReplyEventLookup | undefined): ReplyEventLookup {
  if (override) {
    return override;
  }
  const candidate = store as Partial<ReplyEventLookup>;
  if (typeof candidate.findNormalizedEventById === 'function') {
    return candidate as ReplyEventLookup;
  }
  return {
    async findNormalizedEventById() {
      return null;
    },
  };
}

function replyStoreOf(store: RawEventStore, override: ReplyStore | undefined): ReplyStore {
  if (override) {
    return override;
  }
  const candidate = store as Partial<ReplyStore>;
  if (typeof candidate.claimReply === 'function' && typeof candidate.completeReply === 'function') {
    return candidate as ReplyStore;
  }
  return {
    async claimReply() {
      throw new Error('reply store is not configured');
    },
    async completeReply() {
      throw new Error('reply store is not configured');
    },
  };
}

export function createApp(deps: AppDependencies): Express {
  if (!deps.eventStore) {
    throw new Error('createApp requires an eventStore dependency');
  }

  if (deps.config.connect && !deps.connect) {
    throw new Error('createApp requires connect dependencies when connect is configured');
  }

  if (deps.config.dingtalk && !deps.workbench) {
    throw new Error('createApp requires workbench dependencies when DingTalk is configured');
  }

  const app = express();
  const graphVersion = deps.config.metaGraphVersion ?? 'v23.0';

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use(
    '/webhooks/meta',
    createMetaWebhookRouter({
      verifyToken: deps.config.metaVerifyToken,
      appSecret: deps.config.metaAppSecret,
      eventStore: deps.eventStore,
    }),
  );

  app.use(
    '/api/events',
    createReplyRouter({
      internalApiToken: deps.config.internalApiToken,
      channelTokens: deps.config.metaChannelTokens ?? {},
      channelTokenResolver: deps.channelTokenResolver ?? deps.connect?.channels,
      events: replyEventsOf(deps.eventStore, deps.replyEvents),
      replies: replyStoreOf(deps.eventStore, deps.replyStore),
      client: deps.replyClient ?? createGraphReplyClient({ graphVersion }),
    }),
  );

  if (deps.config.connect && deps.connect) {
    app.use(
      deps.config.connect.mountPath,
      createConnectRouter({
        settings: deps.config.connect,
        oauth: deps.connect.oauth,
        channels: deps.connect.channels,
        adminGuard: deps.connect.adminGuard,
        rememberAuthorizer: deps.connect.rememberAuthorizer,
      }),
    );
  }

  if (deps.workbench) {
    app.use('/inbox', createWorkbenchRouter(deps.workbench));
  }

  return app;
}
