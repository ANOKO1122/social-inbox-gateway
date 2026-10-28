import type { StatisticsStore } from './statistics-store.js';
import { renderStatisticsPage } from './statistics-page.js';
import { SavedReplyStore, SavedReplyValidationError, savedReplyListOptions } from './saved-replies.js';
import { renderSavedRepliesPage } from './saved-replies-page.js';
import { CommentActionsStore, actionAuthorizations } from './comment-actions.js';
import type { RuleSamples } from './rule-samples.js';
import { RuleStore, RuleValidationError, validateRule } from './rule-store.js';
import { renderRulesPage } from './rules-page.js';
import type { RuleLogStore } from './rule-log-store.js';
import { renderRuleLogsPage } from './rule-logs-page.js';
import type { RuleJudge } from '../dify/rule-judge.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import express, { Router, type Request, type Response } from 'express';

import {
  openPayload,
  readCookie,
  sealPayload,
  SESSION_TTL_SECONDS,
  setCookie,
  STAFF_COOKIE,
  staffSigningKey,
  STATE_TTL_SECONDS,
} from '../connect/session.js';
import { logSafeError } from '../safe-log.js';
import { localReplyFailure, type GraphReplyClient, type CommentAction, type CommentActionResult } from '../meta/reply-client.js';
import type { ChannelTokenResolver, ReplyStore } from '../meta/reply-router.js';
import { CommentContextError, orderPulledComments, type CommentContextClient, type CommentContextView, type PulledComment } from '../meta/comment-context.js';
import type { CommentContextRecords } from './comment-context-store.js';
import { SuggestionError, type SuggestionRequest, type SuggestionResult } from '../dify/suggestion.js';
import { DingTalkError, type DingTalkClient } from './dingtalk-client.js';
import type { SuggestionRecords } from './suggestion-store.js';
import type { InboxComment, InboxPage, InboxPageOptions, InboxQueue, Staff, StaffStore } from './staff-repository.js';
import { InboxPageValidationError, inboxPageOptions, presentThread } from './staff-repository.js';
import { formatBeijing } from './beijing-time.js';
import {
  pageNonce,
  renderAdmin,
  renderAudit,
  renderLoginError,
  renderWorkbench,
} from './workbench-page.js';

const STAFF_STATE_COOKIE = 'sig_staff_state';
const COOKIE_PATH = '/inbox';
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMENT_ID = /^[0-9_]{8,80}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const AUTH_RETRY = /^(graph_10|graph_102|graph_104|graph_190|graph_200|missing_token|invalid_token)$/;
const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;
const STATE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

const NOTICES: Record<string, string> = {
  sent: '已发送。',
  failed: '发送未成功，草稿已保留。请检查评论是否仍存在或授权是否有效。',
  missing_channel_token: '这个主页还没有可用授权。',
  in_progress: '正在发送。',
  conflict: '这条回复已经提交过。',
  saved: '已保存。',
  last_admin: '不能停用或降级最后一位管理员。',
  text_invalid: '回复内容不符合长度要求。',
};

export interface WorkbenchDependencies {
  tokenKey: Buffer;
  dingtalk: DingTalkClient;
  staff: StaffStore;
  replies: ReplyStore;
  tokens: ChannelTokenResolver;
  channelTokens: Record<string, string>;
  client: GraphReplyClient;
  contexts?: CommentContextRecords;
  commentContext?: CommentContextClient;
  suggestions?: { draft(input: SuggestionRequest): Promise<SuggestionResult> };
  suggestionStore?: SuggestionRecords;
  rules?: RuleStore;
  ruleLogs?: RuleLogStore;
  ruleSamples?: RuleSamples;
  ruleJudge?: RuleJudge;
  statistics?: StatisticsStore;
  savedReplies?: SavedReplyStore;
  commentActions?: CommentActionsStore;
  now?: () => Date;
}

export function createStaffReader(
  tokenKey: Buffer,
  staff: StaffStore,
  now: () => Date = () => new Date(),
): (request: Request) => Promise<Staff | null> {
  const key = staffSigningKey(tokenKey);
  return async (request) => {
    const raw = readCookie(request.headers.cookie, STAFF_COOKIE);
    if (!raw) {
      return null;
    }
    const payload = openPayload(key, raw, seconds(now()));
    if (!payload || payload.kind !== 'staff') {
      return null;
    }
    return staff.byUnionId(payload.unionId);
  };
}

export function createWorkbenchRouter(dependencies: WorkbenchDependencies): Router {
  const router = Router();
  const key = staffSigningKey(dependencies.tokenKey);
  const now = dependencies.now ?? (() => new Date());
  const readStaff = createStaffReader(dependencies.tokenKey, dependencies.staff, now);

  router.use(express.urlencoded({ extended: false, limit: '16kb' }));

  router.get('/auth/dingtalk/start', (_request, response) => {
    const nonce = randomBytes(16).toString('base64url');
    const token = sealPayload(key, { kind: 'state', exp: seconds(now()) + STATE_TTL_SECONDS, nonce });
    response.append('Set-Cookie', setCookie(STAFF_STATE_COOKIE, token, COOKIE_PATH, STATE_TTL_SECONDS));
    response.redirect(303, dependencies.dingtalk.buildAuthorizationUrl(nonce));
  });

  router.get('/auth/dingtalk/callback', async (request, response) => {
    const nonce = pageNonce();
    const rawState = readCookie(request.headers.cookie, STAFF_STATE_COOKIE);
    const state = rawState ? openPayload(key, rawState, seconds(now())) : undefined;
    response.append('Set-Cookie', setCookie(STAFF_STATE_COOKIE, '', COOKIE_PATH, 0));
    const queryState = oneQuery(request.query.state);
    if (!state || state.kind !== 'state' || !queryState || !STATE_NONCE.test(queryState) || !sameString(state.nonce, queryState)) {
      html(response, 400, renderLoginError(nonce, '登录状态对不上，请重试。'), nonce);
      return;
    }
    const code = oneQuery(request.query.code);
    if (!code || oneQuery(request.query.error)) {
      html(response, 400, renderLoginError(nonce, '钉钉登录没有完成。'), nonce);
      return;
    }
    try {
      const profile = await dependencies.dingtalk.exchangeCode(code);
      const login = await dependencies.staff.login(profile.unionId, profile.name);
      if (login.status === 'disabled') {
        html(response, 403, renderLoginError(nonce, '这个账号已停用。'), nonce);
        return;
      }
      const session = sealPayload(key, {
        kind: 'staff',
        exp: seconds(now()) + SESSION_TTL_SECONDS,
        unionId: login.staff.unionId,
      });
      response.append('Set-Cookie', setCookie(STAFF_COOKIE, session, COOKIE_PATH, SESSION_TTL_SECONDS));
      response.redirect(303, '/inbox/workbench');
    } catch (error) {
      const logged = new Error('redacted');
      logged.name = error instanceof DingTalkError && SAFE_CODE.test(error.code) ? error.code : 'DingTalkError';
      logSafeError('DingTalk login failed', logged);
      html(response, 502, renderLoginError(nonce, '钉钉登录没有完成。'), nonce);
    }
  });

  router.post('/auth/logout', (_request, response) => {
    response.append('Set-Cookie', setCookie(STAFF_COOKIE, '', COOKIE_PATH, 0));
    response.redirect(303, '/inbox/auth/dingtalk/start');
  });

  router.get(['/workbench', '/workbench/facebook', '/workbench/instagram'], async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) {
      response.redirect(303, '/inbox/auth/dingtalk/start');
      return;
    }
    const nonce = pageNonce();
    let filters: InboxPageOptions;
    try { filters = inboxPageOptions(request.query, true); }
    catch (error) {
      if (!(error instanceof InboxPageValidationError)) throw error;
      html(response, 400, renderLoginError(nonce, '筛选参数无效，请重新打开收件箱。'), nonce);
      return;
    }
    const eventId = oneQuery(request.query.event);
    const requested = eventId && EVENT_ID.test(eventId)
      ? await dependencies.staff.commentFor(staff, eventId)
      : null;
    const explicitPlatform = request.path.endsWith('/instagram') ? 'instagram' : request.path.endsWith('/facebook') ? 'facebook' : null;
    const platform = explicitPlatform ?? requested?.platform ?? 'facebook';
    const queue = inboxQueue(request.query.queue);
    const page = await listInboxPage(dependencies.staff, staff, platform, oneQuery(request.query.source), queue, filters);
    const comments = page.rows;
    let selected = (requested && (requested.platform ?? 'facebook') === platform ? requested : null) ?? comments[0] ?? null;
    const fullThread = selected ? await dependencies.staff.threadFor(staff, selected) : [];
    const thread = queue === 'review' ? fullThread.filter(isPendingReview) : fullThread;
    if (queue === 'review' && selected && !thread.some(item => item.id === selected?.id)) {
      selected = thread[0] ?? selected;
    }
    const focusList = oneQuery(request.query.list) === '1' && !requested;
    const noticeCode = oneQuery(request.query.notice);
    html(response, 200, renderWorkbench({
      staff,
      platform,
      queue,
      comments,
      inboxPage: { total: page.total, hasMore: page.hasMore, nextCursor: page.nextCursor, endCursor: page.endCursor },
      inboxFilters: { q: filters.q ?? '', kind: filters.kind ?? 'all', state: filters.state ?? 'all' },
      selected,
      thread,
      focusList,
      notice: noticeCode ? NOTICES[noticeCode] : undefined,
      nonce,
    }), nonce);
  });

  router.get('/workbench/queue', async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) { response.status(401).json({}); return; }
    let filters: InboxPageOptions;
    try { filters = inboxPageOptions(request.query); }
    catch (error) {
      if (!(error instanceof InboxPageValidationError)) throw error;
      response.status(400).json({ error: 'invalid_filters' });
      return;
    }
    const platform = oneQuery(request.query.platform) === 'instagram' ? 'instagram' : 'facebook';
    const page = await listInboxPage(dependencies.staff, staff, platform, oneQuery(request.query.source), inboxQueue(request.query.queue), filters);
    response.json({ total: page.total, hasMore: page.hasMore, nextCursor: page.nextCursor, endCursor: page.endCursor,
      rows: page.rows.map(({ id, platform, kind, channelId, channelName, senderId, senderName,
      externalId, body, occurredAt, postId, postTitle, pendingCount, threadCount, adSource }) =>
      ({ id, platform, kind, channelId, channelName, senderId, senderName, externalId, body, occurredAt,
        postId, postTitle, pendingCount, threadCount, adSource })) });
  });

  router.get('/workbench/context', async (request, response) => {
    const staff = await readStaff(request);
    const empty = { status: 'unavailable' as const, postText: null, postUrl: null, lines: [] as [] };
    if (!staff) {
      response.status(401).json(empty);
      return;
    }
    const eventId = oneQuery(request.query.event);
    if (!eventId || !EVENT_ID.test(eventId)) {
      response.status(404).json(empty);
      return;
    }
    const comment = await dependencies.staff.commentFor(staff, eventId);
    if (!comment) {
      response.status(404).json(empty);
      return;
    }
    const reviewOnly = inboxQueue(request.query.queue) === 'review';
    const fullThread = await dependencies.staff.threadFor(staff, comment);
    const thread = reviewOnly ? fullThread.filter(isPendingReview) : fullThread;
    const currentId = reviewOnly && !thread.some(item => item.id === comment.id) ? thread[0]?.id ?? comment.id : comment.id;
    const localLines = threadLines(thread, currentId);
    if (comment.kind === 'message' || !comment.postId) {
      response.json({ status: 'ok', postText: null, postUrl: null, lines: localLines, kind: comment.kind, platform: comment.platform ?? 'facebook' });
      return;
    }
    const cached = await dependencies.contexts?.cachedPost(comment.postId, now());
    const tokens = [
      ...(dependencies.channelTokens[comment.channelId] ? [dependencies.channelTokens[comment.channelId]] : []),
      ...(dependencies.tokens.tokensForChannel
        ? await dependencies.tokens.tokensForChannel(comment.channelId)
        : await singleToken(dependencies.tokens, comment.channelId)),
    ];
    let view: CommentContextView = cached ?? {
      status: 'unavailable',
      postText: null,
      postUrl: comment.platform === 'instagram' ? null : `https://www.facebook.com/${comment.postId}`,
      lines: [],
    };
    if (!cached && dependencies.commentContext) {
      for (const accessToken of tokens) {
        try {
          view = await dependencies.commentContext.load({
            platform: comment.platform ?? 'facebook',
            postId: comment.postId,
            commentId: comment.externalId,
            accessToken,
          });
          break;
        } catch (error) {
          if (error instanceof CommentContextError && /^(graph_10|graph_102|graph_104|graph_190|graph_200)$/.test(error.code)) {
            continue;
          }
          logSafeError('Comment context failed', error);
          break;
        }
      }
    }
    if (reviewOnly) {
      if (!cached) await dependencies.contexts?.save(eventId, view, comment.postId);
      const cachedById = new Map(cached?.comments?.map(item => [item.id, item]));
      const lines = localLines.map(line => {
        const pulled = cachedById.get(line.externalId);
        return pulled ? { ...line, likeCount: pulled.likeCount, commentCount: pulled.commentCount, mentions: pulled.mentions } : line;
      });
      response.json({ status: view.status, postText: view.postText ?? comment.postTitle, postUrl: view.postUrl,
        lines: await commentActionLines(dependencies, comment, lines), kind: 'comment', platform: comment.platform ?? 'facebook' });
      return;
    }
    let comments = cached?.comments;
    if (comment.platform !== 'instagram' && !comments && dependencies.commentContext) {
      for (const accessToken of tokens) {
        try {
          const pulled = await dependencies.commentContext.loadThread({
            postId: comment.postId,
            accessToken,
          });
          if (pulled) {
            comments = pulled;
            break;
          }
        } catch (error) {
          if (error instanceof CommentContextError && /^(graph_10|graph_102|graph_104|graph_190|graph_200)$/.test(error.code)) {
            continue;
          }
          logSafeError('Comment thread failed', error);
          break;
        }
      }
    }
    if (comments) {
      view = { ...view, comments };
    }
    if (!cached || (comment.platform !== 'instagram' && !cached.comments)) {
      await dependencies.contexts?.save(eventId, view, comment.postId);
    }
    const lines = comments && comments.length > 0 ? pulledLines(comments, thread, comment) : localLines;
    response.json({ ...view, lines: await commentActionLines(dependencies, comment, lines), kind: 'comment', platform: comment.platform ?? 'facebook' });
  });

  router.post('/workbench/suggest', async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) {
      response.status(401).json({ message: '请先登录。' });
      return;
    }
    const eventId = oneField(request.body, 'eventId');
    if (!eventId || !EVENT_ID.test(eventId)) {
      response.status(404).json({ message: '没有这条消息。' });
      return;
    }
    if (!dependencies.suggestions || !dependencies.suggestionStore) {
      response.status(503).json({ message: '建议服务还没有接上。可以手写回复。' });
      return;
    }
    const comment = await dependencies.staff.commentFor(staff, eventId);
    if (!comment) {
      response.status(404).json({ message: '没有这条消息。' });
      return;
    }
    const thread = await dependencies.staff.threadFor(staff, comment);
    const presented = presentThread(thread);
    const note = presented.notes.get(comment.id);
    const cached = comment.postId ? await dependencies.contexts?.cachedPost(comment.postId, now()) : undefined;
    const targetId = oneField(request.body, 'targetId');
    const pulled = targetId && targetId !== comment.externalId ? cached?.comments?.find((item) => item.id === targetId) : undefined;
    const target = await replyTarget(dependencies, staff, comment, targetId, now());
    if (!target || target.deleted || target.isOwn) {
      response.status(400).json({ message: '评论已删除或不可回复，不能生成建议。' }); return;
    }
    try {
      const result = await dependencies.suggestions.draft({
        staffId: staff.id,
        platform: comment.platform ?? 'facebook',
        kind: comment.kind === 'message' ? 'message' : 'comment',
        text: (target.body || '').slice(0, 4000),
        postText: cached?.postText ?? comment.postTitle,
        replyTo: pulled ? null : note?.replyTo ?? null,
        context: presented.ordered.slice(-12).map((item) => {
          const line = presented.notes.get(item.id);
          const name = item.senderName || (item.kind === 'message' ? '私信' : '评论');
          return `${item.id === comment.id ? '>' : '-'} ${name}: ${(line?.text || item.body).slice(0, 300)}`;
        }).join('\n').slice(0, 4000),
      });
      const limit = comment.platform === 'instagram' ? (comment.kind === 'message' ? 1000 : 2200) : (comment.kind === 'message' ? 2000 : 8000);
      const suggestedReply = result.suggestedReply.slice(0, limit);
      let id: string | null = null;
      try {
        id = await dependencies.suggestionStore.save({
          eventId: comment.id,
          staffId: staff.id,
          intent: result.intent,
          suggestedReply,
          needsHuman: result.needsHuman,
          sources: result.sources,
        });
      } catch (error) {
        logSafeError('Suggestion save failed', error);
      }
      response.json({
        id,
        suggestedReply,
        needsHuman: result.needsHuman,
        sources: result.sources,
      });
    } catch (error) {
      logSafeError('Suggestion failed', error);
      const message = error instanceof SuggestionError && error.code === 'timeout'
        ? '建议生成超时。可以手写回复。'
        : error instanceof SuggestionError && error.code === 'model_auth'
          ? '模型密钥无效或没有权限，草稿写不出来。可以到知识库里更新这个模型的密钥，也可以手写回复。'
          : '这次没有生成建议。可以手写回复。';
      response.status(502).json({ message });
    }
  });

  router.post('/workbench/react', async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) { response.status(401).json({ message: '请重新登录。' }); return; }
    const eventId = oneField(request.body, 'eventId');
    const reaction = oneField(request.body, 'reaction');
    if (!eventId || !EVENT_ID.test(eventId) || reaction === undefined) { response.status(400).json({ message: '操作参数无效。' }); return; }
    const comment = await dependencies.staff.commentFor(staff, eventId);
    if (!comment || comment.kind !== 'message' || comment.isOwn) { response.status(404).json({ message: '没有这条私信的操作权限。' }); return; }
    const allowed = comment.platform === 'instagram' ? ['', '❤️'] : ['', '❤️', '👍', '😊', '😂', '😮', '😢', '🎉'];
    if (!allowed.includes(reaction) || !dependencies.client.react || !dependencies.staff.saveReaction) {
      response.status(400).json({ message: '平台不支持这个表情回应。' }); return;
    }
    const candidates = [...(dependencies.channelTokens[comment.channelId] ? [dependencies.channelTokens[comment.channelId]] : []),
      ...(dependencies.tokens.tokensForChannel ? await dependencies.tokens.tokensForChannel(comment.channelId) : await singleToken(dependencies.tokens, comment.channelId))];
    let result: { ok: true } | { ok: false; code: string } = { ok: false, code: 'missing_token' };
    for (const accessToken of candidates) {
      result = await dependencies.client.react({ platform: comment.platform ?? 'facebook', kind: 'message', channelId: comment.channelId,
        senderId: comment.senderId, externalId: comment.externalId, accessToken, reaction });
      if (result.ok || !/^(10|102|104|190|200)$/.test(result.code)) break;
    }
    if (!result.ok) { response.status(502).json({ message: '表情回应失败，请确认消息仍存在且在平台允许的回应时间内。', code: result.code }); return; }
    await dependencies.staff.saveReaction(staff, comment, reaction);
    response.json({ status: 'ok', reaction });
  });

  router.post('/workbench/moderate' , async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) { response.status(401).json({ message: '请重新登录。' }); return; }
    const eventId = oneField(request.body, 'eventId');
    const action = oneField(request.body, 'action');
    if (!eventId || !EVENT_ID.test(eventId) || !['inspect','hide','show'].includes(action ?? '')) {
      response.status(400).json({ message: '操作参数无效。' }); return;
    }
    const anchor = await dependencies.staff.commentFor(staff, eventId);
    if (!anchor || anchor.kind !== 'comment') { response.status(404).json({ message: '没有这条评论的操作权限。' }); return; }
    const comment = await replyTarget(dependencies, staff, anchor, oneField(request.body, 'targetId'), now());
    if (!comment || comment.isOwn || comment.deleted || !dependencies.client.visibility || !dependencies.client.setHidden || !dependencies.staff.recordModeration) {
      response.status(400).json({ message: '这条评论不支持隐藏操作。' }); return;
    }
    const candidates = [...(dependencies.channelTokens[comment.channelId] ? [dependencies.channelTokens[comment.channelId]] : []),
      ...(dependencies.tokens.tokensForChannel ? await dependencies.tokens.tokensForChannel(comment.channelId) : await singleToken(dependencies.tokens, comment.channelId))];
    const observedAt = now();
    let result: { ok: true; hidden: boolean; canHide: boolean } | { ok: false; code: string } = { ok: false, code: 'missing_token' };
    for (const accessToken of candidates) {
      const input = { platform: comment.platform ?? 'facebook' as const, externalId: comment.externalId, accessToken };
      result = action === 'inspect' ? await dependencies.client.visibility(input)
        : await dependencies.client.setHidden({ ...input, hidden: action === 'hide' });
      if (result.ok || !/^(10|102|104|190|200)$/.test(result.code)) break;
    }
    if (action !== 'inspect') await dependencies.staff.recordModeration(staff, comment, action === 'hide', result.ok ? undefined : result.code);
    else if (result.ok) await dependencies.staff.saveVisibility?.(comment, result.hidden, observedAt);
    if (!result.ok) {
      response.status(502).json({ message: '未能更改或读取可见性。评论可能已删除、无权限或平台暂时不可用。', code: result.code }); return;
    }
    response.json({ status: 'ok', hidden: result.hidden, canHide: result.canHide });
  });

  const activeCommentActions = new Set<string>();
  router.post('/workbench/comment-action', async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) { response.status(401).json({ message: '请重新登录。' }); return; }
    if (!sameOrigin(request)) { response.status(403).json({ message: '请求来源不正确。' }); return; }
    const eventId = oneField(request.body, 'eventId');
    const action = oneField(request.body, 'action') as CommentAction | undefined;
    if (!eventId || !EVENT_ID.test(eventId) || !action || !['like','unlike','delete','block','unblock'].includes(action)) {
      response.status(400).json({ message: '操作参数无效。' }); return;
    }
    const anchor = await dependencies.staff.commentFor(staff, eventId);
    if (!anchor || anchor.kind !== 'comment') { response.status(404).json({ message: '没有这条评论的操作权限。' }); return; }
    const comment = await replyTarget(dependencies, staff, anchor, oneField(request.body, 'targetId'), now());
    if (!comment || comment.isOwn || (comment.deleted && action !== 'block' && action !== 'unblock')) { response.status(400).json({ message: '评论已删除或不可操作。' }); return; }
    if (!dependencies.client.commentAction || !dependencies.commentActions || (action === 'delete' && !dependencies.staff.saveDeleted)) {
      response.status(503).json({ message: '评论操作暂不可用。' }); return;
    }
    const platform = comment.platform ?? 'facebook';
    const grants = actionAuthorizations(await dependencies.tokens.commentAuthorizations?.(comment.channelId, platform) ?? [], platform, action);
    if (!grants.length) { response.status(403).json({ message: '缺少本操作所需授权，请管理员在主页授权中补充评论操作权限。' }); return; }
    const blocking = action === 'block' || action === 'unblock';
    const hasConversation = blocking && (await dependencies.commentActions.senderStates(platform, comment.channelId)).has(comment.senderId);
    if (blocking && !hasConversation) { response.status(400).json({ message: '无法确认该评论作者的用户身份，请在官方平台屏蔽。' }); return; }
    const operationKey = [platform, comment.channelId, blocking ? comment.senderId : comment.externalId].join(':');
    if (activeCommentActions.has(operationKey)) { response.status(409).json({ message: '该对象正在处理中，请稍后重试。' }); return; }
    activeCommentActions.add(operationKey);
    try {
      let result: CommentActionResult = { ok: false, code: 'missing_token' };
      for (const grant of grants) {
        result = await dependencies.client.commentAction({ platform, channelId:comment.channelId, externalId:comment.externalId,
          senderId:comment.senderId, action, linkedPageId:grant.pageId, senderHasConversation:hasConversation,
          accessToken: platform === 'instagram' && (action === 'like' || action === 'unlike') ? grant.userToken! : grant.pageToken });
        if (result.ok || !/^(10|102|104|190|200)$/.test(result.code)) break;
      }
      await dependencies.commentActions.record(staff, comment, action, result.ok ? undefined : result.code);
      if (!result.ok) {
        response.status(502).json({ message: /^(10|190|200)$/.test(result.code)
          ? '平台未授权此操作，请确认主页角色、应用权限和授权状态。'
          : '平台未确认操作成功，请在原平台核实后重试。', code:result.code }); return;
      }
      if (action === 'delete') await dependencies.staff.saveDeleted!(comment, now());
      response.json({ status:'ok', action });
    } finally { activeCommentActions.delete(operationKey); }
  });

  router.post('/workbench/reply', async (request, response) => {
    const wantsJson = request.get('Accept') === 'application/json';
    const finish = (notice: string, eventId?: string) => {
      if (wantsJson) response.json({ status: notice, message: NOTICES[notice] ?? '发送失败，请重试。', eventId });
      else response.redirect(303, `/inbox/workbench?${eventId ? `event=${eventId}&` : ''}notice=${notice}`);
    };
    const staff = await readStaff(request);
    if (!staff) {
      if (wantsJson) response.status(401).json({ status: 'failed', message: '登录已过期，请刷新页面重新登录。' });
      else response.redirect(303, '/inbox/auth/dingtalk/start');
      return;
    }
    const eventId = oneField(request.body, 'eventId');
    const idempotencyKey = oneField(request.body, 'idempotencyKey');
    const text = oneField(request.body, 'text');
    const suggestionField = oneField(request.body, 'suggestionId');
    const suggestionId = suggestionField && EVENT_ID.test(suggestionField) ? suggestionField : undefined;
    if (!eventId || !EVENT_ID.test(eventId) || !idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey) || text === undefined) {
      finish('text_invalid');
      return;
    }
    const anchor = await dependencies.staff.commentFor(staff, eventId);
    if (!anchor || anchor.isOwn) {
      finish('failed');
      return;
    }
    const comment = await replyTarget(dependencies, staff, anchor, oneField(request.body, 'targetId'), now());
    if (!comment || comment.deleted || comment.isOwn) {
      finish('failed', eventId);
      return;
    }
    const local = localReplyFailure({
      platform: comment.platform ?? 'facebook',
      kind: comment.kind === 'message' ? 'message' : 'comment',
      channelId: comment.channelId,
      senderId: comment.kind === 'message' ? comment.senderId : anchor.senderId,
      externalId: comment.externalId,
      text,
    });
    if (local) {
      finish(local === 'text_invalid' ? 'text_invalid' : 'failed', eventId);
      return;
    }
    try {
      const notice = await sendReply(dependencies, staff, comment, text, idempotencyKey, suggestionId);
      finish(notice, comment.id);
    } catch (error) {
      logSafeError('Workbench reply failed', error);
      finish('failed', eventId);
    }
  });

  router.post('/review/resolve', express.json({ limit: '4kb' }), async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) { response.status(401).json({ message: '请重新登录。' }); return; }
    const origin = request.get('Origin');
    if (origin) {
      try { if (new URL(origin).host !== request.get('Host')) { response.status(403).json({ message: '请求来源不正确。' }); return; } }
      catch { response.status(403).json({ message: '请求来源不正确。' }); return; }
    }
    const eventId = oneField(request.body, 'eventId');
    if (!eventId || !EVENT_ID.test(eventId) || oneField(request.body, 'resolution') !== 'no_action') {
      response.status(400).json({ message: '操作参数无效。' }); return;
    }
    if (!dependencies.staff.resolveReview) { response.status(503).json({ message: '人工审核暂不可用。' }); return; }
    const result = await dependencies.staff.resolveReview(staff, eventId);
    if (result === 'not_found') { response.status(404).json({ message: '没有这条评论的操作权限。' }); return; }
    if (result === 'not_open') { response.status(409).json({ message: '这条评论已处理，请刷新列表。' }); return; }
    response.json({ status: 'ok' });
  });

  router.get('/workbench/events', async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) {
      response.status(401).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    let since = new Date(now().getTime() - 5_000);
    request.on('close', () => {
      closed = true;
    });
    const tick = async () => {
      if (closed) {
        return;
      }
      try {
        const current = await dependencies.staff.byUnionId(staff.unionId);
        if (!current) {
          closed = true;
          response.end();
          return;
        }
        const rows = await dependencies.staff.commentsAfter(current, since);
        for (const row of rows) {
          if (row.occurredAt > since) {
            since = row.occurredAt;
          }
          response.write(`event: comment\ndata: ${JSON.stringify({
            id: row.id,
            platform: row.platform ?? 'facebook',
            isOwn: row.isOwn,
            adSource: row.adSource,
            externalId: row.externalId,
            kind: row.kind,
            channelId: row.channelId,
            channelName: row.channelName,
            senderId: row.senderId,
            senderName: row.senderName,
            postId: row.postId,
            body: row.body.slice(0, 200),
          })}\n\n`);
        }
      } catch (error) {
        logSafeError('Workbench events failed', error);
        closed = true;
        response.end();
        return;
      }
      if (!closed) {
        setTimeout(() => {
          void tick();
        }, 2_000);
      }
    };
    const heartbeat = setInterval(() => {
      if (closed) {
        clearInterval(heartbeat);
        return;
      }
      response.write(': ping\n\n');
    }, 15_000);
    response.on('close', () => clearInterval(heartbeat));
    void tick();
  });

  router.get('/auth/dify-gate', async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) {
      response.status(401).end();
      return;
    }
    if (staff.role !== 'admin') {
      response.status(403).end();
      return;
    }
    response.status(204).end();
  });

  router.get('/admin', async (request, response) => {
    const staff = await requireAdmin(readStaff, request, response);
    if (!staff) {
      return;
    }
    const nonce = pageNonce();
    const noticeCode = oneQuery(request.query.notice);
    html(response, 200, renderAdmin({
      staff,
      accounts: await dependencies.staff.accounts(),
      pages: await dependencies.staff.knownPages(),
      nonce,
      notice: noticeCode ? NOTICES[noticeCode] : undefined,
    }), nonce);
  });

  router.get('/admin/statistics', async (request, response) => {
    const staff = await requireAdmin(readStaff, request, response);
    if (!staff) return;
    if (!dependencies.statistics) { response.status(503).send('统计服务尚未配置。'); return; }
    const requestedPlatform = oneQuery(request.query.platform);
    const platform = requestedPlatform === 'facebook' || requestedPlatform === 'instagram' ? requestedPlatform : 'all';
    const nonce = pageNonce();
    try {
      const stats = await dependencies.statistics.today(now(), platform);
      html(response, 200, renderStatisticsPage({ staff, nonce, stats }), nonce);
    } catch (error) {
      logSafeError('Inbox statistics unavailable', error);
      html(response, 503, renderLoginError(nonce, '统计暂时读取失败，请稍后刷新页面。'), nonce);
    }
  });

  router.get('/admin/rules', async (request, response) => {
    const staff = await requireAdmin(readStaff, request, response);
    if (!staff) return;
    if (!dependencies.rules) { response.status(503).send('规则管理尚未配置。'); return; }
    const nonce = pageNonce();
    html(response, 200, renderRulesPage({ staff, nonce, rules: await dependencies.rules.list(),
      pages: await dependencies.staff.knownPages(), aiReady: !!dependencies.ruleJudge }), nonce);
  });

  router.get('/admin/rules/:ruleId/logs', async (request, response) => {
    const staff = await requireAdmin(readStaff, request, response);
    if (!staff) return;
    if (!dependencies.ruleLogs) { response.status(503).send('规则日志暂不可用。'); return; }
    const nonce = pageNonce();
    try {
      const data = await dependencies.ruleLogs.list(request.params.ruleId, {
        outcome: request.query.outcome, page: request.query.page,
      });
      if (!data) { response.status(404).send('该规则不存在，可能已被删除。'); return; }
      html(response, 200, renderRuleLogsPage({ staff, nonce, data }), nonce);
    } catch (error) {
      if (error instanceof RuleValidationError) { response.status(400).send(error.message); return; }
      logSafeError('Rule logs unavailable', error);
      html(response, 503, renderLoginError(nonce, '规则日志暂时读取失败，请稍后刷新。'), nonce);
    }
  });

  router.get('/admin/saved-replies', async (request, response) => {
    const staff = await requireAdmin(readStaff, request, response);
    if (!staff) return;
    if (!dependencies.savedReplies) { response.status(503).send('话术库暂不可用。'); return; }
    const nonce = pageNonce();
    html(response, 200, renderSavedRepliesPage({ staff, nonce,
      replies: await dependencies.savedReplies.list({ includeDisabled: true }) }), nonce);
  });

  router.get('/workbench/saved-replies', async (request, response) => {
    if (!await readStaff(request)) { response.status(401).json({ message: '请重新登录。' }); return; }
    if (!dependencies.savedReplies) { response.status(503).json({ message: '话术库暂不可用。' }); return; }
    try {
      response.json({ replies: await dependencies.savedReplies.list(savedReplyListOptions(request.query)) });
    } catch (error) {
      if (error instanceof SavedReplyValidationError) { response.status(400).json({ message: error.message }); return; }
      throw error;
    }
  });

  router.post('/admin/saved-replies/:operation', express.json({ limit: '48kb' }), async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) { response.status(401).json({ message: '请重新登录。' }); return; }
    if (staff.role !== 'admin') { response.status(403).json({ message: '仅管理员可维护共享话术。' }); return; }
    if (!sameOrigin(request)) { response.status(403).json({ message: '请求来源不正确。' }); return; }
    if (!dependencies.savedReplies) { response.status(503).json({ message: '话术库暂不可用。' }); return; }
    try {
      const reply = request.params.operation === 'save' ? await dependencies.savedReplies.save(request.body?.reply)
        : request.params.operation === 'toggle' ? await dependencies.savedReplies.setEnabled(request.body?.id, request.body?.enabled) : undefined;
      if (reply === undefined) { response.status(404).json({ message: '操作不存在。' }); return; }
      if (!reply) { response.status(404).json({ message: '话术不存在，请刷新列表。' }); return; }
      response.json({ reply });
    } catch (error) {
      if (error instanceof SavedReplyValidationError) { response.status(400).json({ message: error.message }); return; }
      throw error;
    }
  });

  const judging = new Set<string>();
  router.post('/admin/rules/:operation', express.json({ limit: '64kb' }), async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) { response.status(401).json({ message: '请重新登录。' }); return; }
    if (staff.role !== 'admin') { response.status(403).json({ message: '仅管理员可配置和试跑规则。' }); return; }
    const origin = request.get('Origin');
    if (origin) {
      try { if (new URL(origin).host !== request.get('Host')) { response.status(403).json({ message: '请求来源不正确。' }); return; } }
      catch { response.status(403).json({ message: '请求来源不正确。' }); return; }
    }
    if (!dependencies.rules) { response.status(503).json({ message: '规则管理尚未配置。' }); return; }
    try {
      const operation = request.params.operation;
      if (operation === 'toggle') {
        response.json({ rule: await dependencies.rules.setEnabled(request.body?.id, request.body?.enabled) }); return;
      }
      if (operation === 'sample') {
        if (!dependencies.ruleSamples) { response.status(503).json({ message: '评论抽样暂不可用。' }); return; }
        response.json(await dependencies.ruleSamples.random(request.body)); return;
      }
      if (operation === 'save') { response.json({ rule: await dependencies.rules.save(request.body?.rule) }); return; }
      if (operation === 'delete') {
        const id = oneField(request.body, 'id');
        if (!id) throw new RuleValidationError('规则编号不正确。');
        response.json({ removed: await dependencies.rules.remove(id) }); return;
      }
      if (operation !== 'preview') { response.status(404).json({ message: '操作不存在。' }); return; }
      const match = dependencies.rules.preview(request.body);
      if (typeof request.body.text !== 'string' || request.body.text.length > 4000
        || (request.body.context !== undefined && (typeof request.body.context !== 'string' || request.body.context.length > 2000))) {
        throw new RuleValidationError('测试评论最多 4000 字，上下文最多 2000 字。');
      }
      if (request.body.ai !== true || !match.matched || match.next !== 'ai') { response.json({ match }); return; }
      if (!dependencies.ruleJudge) { response.status(503).json({ message: 'AI 判断接口尚未配置。' }); return; }
      if (judging.has(staff.id) || judging.size >= 2) { response.status(429).json({ message: '已有 AI 试跑进行中，请稍后再试。' }); return; }
      judging.add(staff.id);
      try {
        const ai = await dependencies.ruleJudge.judge({ rule: validateRule(request.body.rule),
          text: request.body.text, context: request.body.context ?? '', matchedKeywords: match.matchedKeywords, staffId: staff.id });
        response.json({ match, ai });
      } finally { judging.delete(staff.id); }
    } catch (error) {
      if (error instanceof RuleValidationError) { response.status(400).json({ message: error.message }); return; }
      logSafeError('Rule configuration failed', error);
      response.status(500).json({ message: '规则处理失败，请稍后重试。' });
    }
  });

  router.post('/admin/access', async (request, response) => {
    const staff = await requireAdmin(readStaff, request, response);
    if (!staff) {
      return;
    }
    const staffId = oneField(request.body, 'staffId');
    const role = oneField(request.body, 'role');
    if (!staffId || (role !== 'admin' && role !== 'agent')) {
      response.redirect(303, '/inbox/admin');
      return;
    }
    try {
      await dependencies.staff.saveAccess({
        actor: staff,
        staffId,
        role,
        disabled: oneField(request.body, 'disabled') === '1',
        pageIds: manyFields(request.body, 'pageId'),
      });
      response.redirect(303, '/inbox/admin?notice=saved');
    } catch (error) {
      const notice = error instanceof Error && error.message === 'last_admin' ? 'last_admin' : 'failed';
      if (notice === 'failed') {
        logSafeError('Staff access update failed', error);
      }
      response.redirect(303, `/inbox/admin?notice=${notice}`);
    }
  });

  router.get('/admin/audit', async (request, response) => {
    const staff = await readStaff(request);
    if (!staff) {
      response.redirect(303, '/inbox/auth/dingtalk/start');
      return;
    }
    const nonce = pageNonce();
    html(response, 200, renderAudit({
      staff,
      rows: [...await dependencies.staff.listAudit(staff), ...await dependencies.staff.listModeration?.(staff) ?? [], ...await dependencies.commentActions?.audit(staff) ?? []].sort((a,b) => b.createdAt.getTime()-a.createdAt.getTime()).slice(0,100),
      nonce,
    }), nonce);
  });

  return router;
}

async function requireAdmin(
  readStaff: (request: Request) => Promise<Staff | null>,
  request: Request,
  response: Response,
): Promise<Staff | null> {
  const staff = await readStaff(request);
  if (!staff) {
    response.redirect(303, '/inbox/auth/dingtalk/start');
    return null;
  }
  if (staff.role !== 'admin') {
    response.redirect(303, '/inbox/workbench');
    return null;
  }
  return staff;
}

async function sendReply(
  dependencies: WorkbenchDependencies,
  staff: Staff,
  comment: InboxComment,
  text: string,
  idempotencyKey: string,
  suggestionId?: string,
): Promise<string> {
  const audit = await dependencies.staff.beginAudit({ staff, comment, replyBody: text.trim(), idempotencyKey });
  if ('conflict' in audit) {
    return 'conflict';
  }
  if (audit.status === 'sent' && audit.platformMessageId) {
    await rememberSuggestion(dependencies, staff, comment, suggestionId);
    return 'sent';
  }
  if (audit.status === 'failed') {
    return 'failed';
  }

  const claim = await dependencies.replies.claimReply({
    normalizedEventId: comment.id,
    idempotencyKey,
  });
  if (claim.outcome === 'sent') {
    await dependencies.staff.finishAudit(audit.id, { status: 'sent', platformMessageId: claim.platformMessageId });
    await rememberSuggestion(dependencies, staff, comment, suggestionId);
    return 'sent';
  }
  if (claim.outcome === 'failed') {
    await dependencies.staff.finishAudit(audit.id, { status: 'failed', errorCode: claim.errorCode });
    return 'failed';
  }
  if (claim.outcome === 'in_progress') {
    return 'in_progress';
  }
  if (claim.outcome === 'conflict') {
    return 'conflict';
  }

  const mapped = dependencies.channelTokens[comment.channelId];
  const stored = dependencies.tokens.tokensForChannel
    ? await dependencies.tokens.tokensForChannel(comment.channelId)
    : [];
  const fallback = stored.length > 0
    ? stored
    : await singleToken(dependencies.tokens, comment.channelId);
  const candidates = [
    ...(typeof mapped === 'string' && mapped.length > 0 ? [mapped] : []),
    ...fallback,
  ];
  if (candidates.length === 0) {
    await dependencies.replies.completeReply({
      replyId: claim.replyId,
      status: 'failed',
      errorCode: 'missing_channel_token',
      errorType: null,
    });
    await dependencies.staff.finishAudit(audit.id, { status: 'failed', errorCode: 'missing_channel_token' });
    return 'missing_channel_token';
  }

  let failureCode = 'graph_error';
  for (const accessToken of candidates) {
    const result = await dependencies.client.send({
      platform: comment.platform ?? 'facebook',
      kind: comment.kind === 'message' ? 'message' : 'comment',
      channelId: comment.channelId,
      senderId: comment.senderId,
      externalId: comment.externalId,
      text,
      accessToken,
    });
    if (result.ok) {
      await dependencies.replies.completeReply({
        replyId: claim.replyId,
        status: 'sent',
        platformMessageId: result.platformMessageId,
      });
      await dependencies.staff.finishAudit(audit.id, { status: 'sent', platformMessageId: result.platformMessageId });
      await rememberSuggestion(dependencies, staff, comment, suggestionId);
      return 'sent';
    }
    failureCode = SAFE_CODE.test(result.code) ? result.code : 'graph_error';
    if (!AUTH_RETRY.test(failureCode)) {
      break;
    }
  }

  await dependencies.replies.completeReply({
    replyId: claim.replyId,
    status: 'failed',
    errorCode: failureCode,
    errorType: null,
  });
  await dependencies.staff.finishAudit(audit.id, { status: 'failed', errorCode: failureCode });
  return 'failed';
}

async function rememberSuggestion(
  dependencies: WorkbenchDependencies,
  staff: Staff,
  comment: InboxComment,
  suggestionId: string | undefined,
): Promise<void> {
  if (!suggestionId || !dependencies.suggestionStore) {
    return;
  }
  try {
    await dependencies.suggestionStore.markAdopted({
      id: suggestionId,
      eventId: comment.id,
      staffId: staff.id,
    });
  } catch (error) {
    logSafeError('Suggestion adopt failed', error);
  }
}

async function replyTarget(
  dependencies: WorkbenchDependencies,
  staff: Staff,
  anchor: InboxComment,
  targetId: string | undefined,
  now: Date,
): Promise<InboxComment | null> {
  if (!targetId || targetId === anchor.externalId) {
    return anchor;
  }
  if (anchor.kind !== 'comment' || !anchor.postId || !COMMENT_ID.test(targetId)) return null;
  const existing = (await dependencies.staff.threadFor(staff, anchor)).find(item => item.externalId === targetId);
  if (existing) return existing;
  if (anchor.platform === 'instagram') return null;
  const cached = await dependencies.contexts?.cachedPost(anchor.postId, now);
  const pulled = cached?.comments?.find((item) => item.id === targetId);
  if (!pulled) {
    return null;
  }
  const opened = await dependencies.staff.openPulledComment(staff, {
    channelId: anchor.channelId,
    postId: anchor.postId,
    externalId: pulled.id,
    parentId: pulled.parentId,
    body: pulled.text,
    occurredAt: new Date(pulled.createdAt),
  });
  return opened && opened.channelId === anchor.channelId && (opened.platform ?? 'facebook') === (anchor.platform ?? 'facebook')
    && opened.postId === anchor.postId ? opened : null;
}

function isPendingReview(item: InboxComment): boolean {
  return item.kind === 'comment' && !item.isOwn
    && item.ruleReview?.decision === 'review' && item.ruleReview.status === 'open';
}

function threadLines(thread: InboxComment[], currentId: string) {
  const presented = presentThread(thread);
  const byExternalId = new Map(thread.map(item => [item.externalId, item]));
  return presented.ordered.map((item) => {
    const note = presented.notes.get(item.id) ?? { depth: 0, replyTo: null, text: item.body };
    let parentId = item.parentId !== item.postId ? item.parentId : null;
    if (item.platform === 'instagram' && item.kind === 'comment') {
      // Instagram reply links name the top-level comment, even when replying to a reply.
      const visited = new Set([item.externalId]);
      while (parentId) {
        if (visited.has(parentId)) { parentId = null; break; }
        visited.add(parentId);
        const parent = byExternalId.get(parentId);
        if (!parent?.parentId || parent.parentId === item.postId) break;
        parentId = parent.parentId;
      }
    }
    return {
      id: item.id,
      name: item.senderName || (item.kind === 'message' ? '私信' : '评论'),
      text: (note.text || item.body).slice(0, 8000) || '（没有文字）',
      time: formatBeijing(item.occurredAt),
      current: item.id === currentId,
      reply: note.depth > 0,
      depth: note.depth,
      replyTo: note.replyTo,
      externalId: item.externalId,
      parentId,
      senderId: item.senderId,
      replyState: item.replyStatus === 'sent' ? '已回复' : item.replyStatus === 'failed' ? '失败' : '未回复',
      hidden: item.hidden,
      deleted: item.deleted,
      ruleReview: item.ruleReview,
      reaction: item.reaction,
      own: item.isOwn === true,
      operatorName: item.operatorName,
      state: item.deleted ? '已删除' : item.hidden ? '已隐藏' : item.ruleReview?.status === 'dismissed' ? '无需处理'
        : item.ruleReview?.decision === 'review' && item.ruleReview.status === 'open' ? '待人工审核'
        : item.replyStatus === 'sent' ? '已回复' : item.replyStatus === 'failed' ? '失败' : '未回复',
    };
  });
}

function pulledLines(comments: PulledComment[], thread: InboxComment[], current: InboxComment) {
  const local = new Map(thread.map((item) => [item.externalId, item]));
  const pulled = orderPulledComments(comments).map(({ comment, depth }) => {
    const known = local.get(comment.id);
    const parent = comment.parentId ? local.get(comment.parentId) : undefined;
    return {
      id: known?.id,
      name: known?.senderName || '评论',
      text: (known ? known.body : comment.text) || '（没有文字）',
      time: formatBeijing(new Date(comment.createdAt)),
      current: comment.id === current.externalId,
      reply: depth > 0,
      depth,
      replyTo: parent?.senderName ?? null,
      externalId: comment.id,
      senderId: known?.senderId ?? '',
      state: known?.deleted ? '已删除' : (known?.hidden ?? comment.hidden) ? '已隐藏' : known?.ruleReview?.status === 'dismissed' ? '无需处理'
        : known?.ruleReview?.decision === 'review' && known.ruleReview.status === 'open' ? '待人工审核'
        : known?.replyStatus === 'sent' ? '已回复' : known?.replyStatus === 'failed' ? '失败' : '未回复',
      hidden: known?.hidden ?? comment.hidden,
      deleted: known?.deleted,
      ruleReview: known?.ruleReview,
      likeCount: comment.likeCount,
      commentCount: comment.commentCount,
      mentions: comment.mentions,
    };
  });
  const localLines = threadLines(thread, current.id);
  const own = new Map(localLines.filter(line => line.own).map(line => [line.externalId, line]));
  const merged = pulled.filter(line => !own.has(line.externalId));
  const ids = new Set(merged.map(line => line.externalId));
  const result: (typeof pulled[number] | typeof localLines[number])[] = [...merged,
    ...localLines.filter(line => !line.own && !ids.has(line.externalId))];
  for (const line of [...own.values()].reverse()) {
    const source = thread.find(item => item.externalId === line.externalId);
    const parent = result.findIndex(item => item.externalId === source?.parentId);
    result.splice(parent < 0 ? result.length : parent + 1, 0, line);
  }
  return result;
}

async function commentActionLines<T extends { externalId: string; senderId: string; text: string; own?: boolean; deleted?: boolean }>(
  dependencies: WorkbenchDependencies, comment: InboxComment, lines: T[],
): Promise<T[]> {
  if (!dependencies.commentActions || comment.kind !== 'comment') return lines;
  const platform = comment.platform ?? 'facebook';
  const [grants, states, senders, revisions] = await Promise.all([
    dependencies.tokens.commentAuthorizations?.(comment.channelId, platform) ?? [],
    dependencies.commentActions.states(platform, comment.channelId),
    dependencies.commentActions.senderStates(platform, comment.channelId),
    dependencies.commentActions.revisions(platform, comment.channelId, lines.map(line => line.externalId)),
  ]);
  const canLike = actionAuthorizations(grants, platform, 'like').length > 0;
  const canDelete = actionAuthorizations(grants, platform, 'delete').length > 0;
  const canBlock = actionAuthorizations(grants, platform, 'block').length > 0;
  return lines.map(line => {
    const revision = revisions.get(line.externalId);
    const deleted = revision?.deleted ?? line.deleted;
    return { ...line, deleted, ...(revision ? { text: revision.body === null ? line.text : revision.body || '（没有文字）' } : {}),
      ...(deleted ? { state: '已删除' } : {}), actions: line.own ? undefined : {
        canLike:canLike && !deleted, canDelete:canDelete && !deleted, canBlock:canBlock && senders.has(line.senderId),
        liked:states.get(line.externalId)?.liked ?? false, blocked:senders.get(line.senderId)?.blocked ?? false,
      } };
  });
}

async function singleToken(tokens: ChannelTokenResolver, channelId: string): Promise<string[]> {
  const token = await tokens.tokenForChannel(channelId);
  return token ? [token] : [];
}

function sameString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function listInboxPage(store: StaffStore, staff: Staff, platform: 'facebook' | 'instagram',
  source: string | undefined, queue: InboxQueue, options: InboxPageOptions): Promise<InboxPage> {
  if (store.listInboxPage) return store.listInboxPage(staff, platform, source, queue, options);
  // Keep older stores and lightweight integrations compatible with the paged endpoint.
  const query = (options.q ?? '').toLocaleLowerCase();
  const rows = (await store.listComments(staff, platform, source, queue)).filter(row =>
    (!options.kind || options.kind === 'all' || row.kind === options.kind)
    && (options.state !== 'open' || (row.pendingCount ?? (row.replyStatus === 'sent' ? 0 : 1)) > 0)
    && (!query || [row.channelName, row.channelId, row.senderName, row.senderId, row.postTitle,
      row.postId, row.externalId, row.body].join(' ').toLocaleLowerCase().includes(query)));
  return { rows, total: rows.length, hasMore: false, nextCursor: null, endCursor: null };
}

function inboxQueue(value: unknown): 'all' | 'review' | 'rule_hidden' | 'dismissed' {
  return value === 'review' || value === 'rule_hidden' || value === 'dismissed' ? value : 'all';
}

function oneQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sameOrigin(request: Request): boolean {
  if (request.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === request.get('Host'); } catch { return false; }
}

function oneField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function manyFields(body: unknown, name: string): string[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const value = (body as Record<string, unknown>)[name];
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function html(response: Response, status: number, body: string, nonce: string): void {
  response.status(status);
  response.set('Content-Type', 'text/html; charset=utf-8');
  response.set('Content-Security-Policy', [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  response.set('Referrer-Policy', 'no-referrer');
  response.set('X-Content-Type-Options', 'nosniff');
  response.send(body);
}
