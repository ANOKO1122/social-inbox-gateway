import { StatisticsStore } from './staff/statistics-store.js';
import { SavedReplyStore } from './staff/saved-replies.js';
import { CommentActionsStore } from './staff/comment-actions.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ChannelRepository } from './connect/channel-repository.js';
import { createMetaOauthClient } from './connect/oauth-client.js';
import { createPool } from './db/pool.js';
import { EventRepository } from './events/event-repository.js';
import { createGraphReplyClient } from './meta/reply-client.js';
import { createCommentContextClient } from './meta/comment-context.js';
import { createShutdown, registerShutdownSignals, startServer } from './server-lifecycle.js';
import { RuleSamples } from './staff/rule-samples.js';
import { RuleStore } from './staff/rule-store.js';
import { RuleLogStore } from './staff/rule-log-store.js';
import { RuleRunner } from './staff/rule-runner.js';
import { RuleContextRefresh } from './staff/rule-context-refresh.js';
import { createRuleJudge } from './dify/rule-judge.js';
import { createSuggestionClient } from './dify/suggestion.js';
import { CommentContextStore } from './staff/comment-context-store.js';
import { createDingTalkClient } from './staff/dingtalk-client.js';
import { StaffRepository } from './staff/staff-repository.js';
import { SuggestionStore } from './staff/suggestion-store.js';
import { createStaffReader } from './staff/workbench-router.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const events = new EventRepository(pool);
const graphVersion = config.metaGraphVersion ?? 'v23.0';
const channels = config.connect ? new ChannelRepository(pool, config.connect.tokenKey) : undefined;
const staff = config.dingtalk ? new StaffRepository(pool) : undefined;
const contexts = config.dingtalk ? new CommentContextStore(pool) : undefined;
const graph = createGraphReplyClient({ graphVersion });
const rules = new RuleStore(pool);
const ruleJudge = config.ruleAi ? createRuleJudge(config.ruleAi) : undefined;
const commentContext = createCommentContextClient({ graphVersion });
const ruleContexts = contexts ? new RuleContextRefresh({ db: pool, client: commentContext, contexts }) : undefined;
const ruleRunner = channels ? new RuleRunner({ db: pool, rules, client: graph, tokens: channels,
  channelTokens: config.metaChannelTokens ?? {}, judge: ruleJudge,
  refreshContext: ruleContexts ? (input) => ruleContexts.refresh(input) : undefined }) : undefined;
const readStaff = config.dingtalk && config.connect && staff
  ? createStaffReader(config.connect.tokenKey, staff)
  : undefined;
const app = createApp({
  config,
  eventStore: events,
  replyEvents: events,
  replyStore: events,
  replyClient: graph,
  connect: config.connect && channels
    ? {
        oauth: createMetaOauthClient({
          appId: config.connect.appId,
          appSecret: config.metaAppSecret,
          redirectUri: config.connect.redirectUri,
          graphVersion,
        }),
        channels,
        adminGuard: readStaff
          ? async (request) => (await readStaff(request))?.role === 'admin'
          : undefined,
        rememberAuthorizer: readStaff
          ? async (facebookUserId, request) => {
              const user = await readStaff(request);
              if (user) {
                await channels?.attachAuthorizer(facebookUserId, user.id);
              }
            }
          : undefined,
      }
    : undefined,
  workbench: config.dingtalk && config.connect && staff && channels
    ? {
        tokenKey: config.connect.tokenKey,
        dingtalk: createDingTalkClient({
          clientId: config.dingtalk.clientId,
          clientSecret: config.dingtalk.clientSecret,
          redirectUri: config.dingtalk.redirectUri,
        }),
        staff,
        rules,
        ruleLogs: new RuleLogStore(pool),
        statistics: new StatisticsStore(pool),
        savedReplies: new SavedReplyStore(pool),
        commentActions: new CommentActionsStore(pool),
        ruleSamples: new RuleSamples(pool),
        ruleJudge,
        replies: events,
        tokens: channels,
        channelTokens: config.metaChannelTokens ?? {},
        client: graph,
        contexts,
        commentContext,
        suggestions: config.dify ? createSuggestionClient(config.dify) : undefined,
        suggestionStore: config.dify ? new SuggestionStore(pool) : undefined,
      }
    : undefined,
});

const server = await startServer({ app, host: config.host, port: config.port });
ruleRunner?.start();
registerShutdownSignals(createShutdown({ server, pool, stopBackground: () => ruleRunner?.stop() ?? Promise.resolve() }));
console.log(`Listening on ${config.host}:${config.port}`);
