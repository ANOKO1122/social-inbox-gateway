import { randomUUID } from 'node:crypto';

import type { ChannelDb } from '../connect/channel-repository.js';
import type { RuleJudge } from '../dify/rule-judge.js';
import type { GraphReplyClient, VisibilityResult } from '../meta/reply-client.js';
import type { ChannelTokenResolver } from '../meta/reply-router.js';
import { logSafeError } from '../safe-log.js';
import { evaluateRule, type Rule, type RulePreview, type RuleStore } from './rule-store.js';

type Decision = 'hide' | 'keep' | 'review' | 'skip';
type Outcome = 'hidden' | 'already_hidden' | 'kept' | 'review' | 'skipped' | 'failed';
type Row = Record<string, unknown>;

interface Run {
  id: string;
  eventId: string;
  ruleIds: string[];
  createdAt: Date | string;
  claimToken: string;
  writeStarted: boolean;
}

interface Comment {
  platform: 'facebook' | 'instagram';
  channelId: string;
  externalId: string;
  text: string;
}

interface Match {
  rule: Rule;
  revision: string;
  preview: RulePreview;
}

export interface RuleRunnerOptions {
  db: ChannelDb;
  rules: Pick<RuleStore, 'list'>;
  client: GraphReplyClient;
  tokens: ChannelTokenResolver;
  channelTokens?: Record<string, string>;
  judge?: RuleJudge;
  refreshContext?: (input: {
    eventId: string;
    platform: 'facebook' | 'instagram';
    channelId: string;
    externalId: string;
    accessToken: string;
  }) => Promise<void>;
  pollMs?: number;
}

const AUTH_FAILURE = /^(10|102|104|190|200)$/;
const LEASE_MS = 5 * 60_000;

/** A single-flight, durable consumer. It never scans normalized_events for work. */
export class RuleRunner {
  private timer?: NodeJS.Timeout;
  private running?: Promise<boolean>;
  private started = false;
  private stopping = false;

  constructor(private readonly options: RuleRunnerOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  processNext(): Promise<boolean> {
    if (this.running || this.stopping) return Promise.resolve(false);
    const pending = this.consume();
    this.running = pending;
    void pending.finally(() => {
      if (this.running === pending) this.running = undefined;
    }).catch(() => undefined);
    return pending;
  }

  private schedule(delay: number): void {
    if (!this.started || this.stopping) return;
    this.timer = setTimeout(async () => {
      let consumed = false;
      try { consumed = await this.processNext(); }
      catch (error) { logSafeError('rule runner poll failed', error); }
      this.schedule(consumed ? 100 : Math.max(250, this.options.pollMs ?? 2000));
    }, delay);
    this.timer.unref();
  }

  private async consume(): Promise<boolean> {
    const claimToken = randomUUID();
    const claimed = await this.options.db.query(`WITH next_run AS MATERIALIZED (
      SELECT id FROM rule_runs
      WHERE status = 'pending'
         OR (status = 'processing' AND claimed_at < now() - $2::int * interval '1 millisecond')
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE rule_runs q SET status = 'processing', claimed_at = clock_timestamp(),
      claim_token = $1, attempt_count = attempt_count + 1
      FROM next_run n WHERE q.id = n.id RETURNING q.*`, [claimToken, LEASE_MS]);
    const row = claimed.rows[0];
    if (!row) return false;
    const run: Run = {
      id: String(row.id), eventId: String(row.normalized_event_id),
      ruleIds: row.rule_ids as string[], createdAt: row.created_at as Date | string,
      claimToken, writeStarted: row.write_started_at != null,
    };
    const heartbeat = setInterval(() => {
      void this.options.db.query(`UPDATE rule_runs SET claimed_at = clock_timestamp()
        WHERE id = $1 AND claim_token = $2 AND status = 'processing'`, [run.id, claimToken])
        .catch((error) => logSafeError('rule runner lease refresh failed', error));
    }, 30_000);
    heartbeat.unref();
    try {
      await this.process(run);
    } catch (error) {
      logSafeError('rule runner processing failed', error);
      await this.finish(run, 'review', 'failed', '规则处理发生异常，已转人工；请检查评论当前状态。');
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async process(run: Run): Promise<void> {
    const result = await this.options.db.query(`SELECT n.*,
      (EXISTS (SELECT 1 FROM reply_audit a WHERE a.status = 'sent'
        AND a.platform = n.platform AND a.platform_message_id = n.external_id)
        OR EXISTS (SELECT 1 FROM official_replies own WHERE own.platform = n.platform AND own.kind = n.kind
          AND own.channel_id = n.channel_id AND own.external_id = n.external_id)) AS own_reply,
      EXISTS (SELECT 1 FROM comment_revisions revision WHERE revision.platform = n.platform
        AND revision.channel_id = n.channel_id AND revision.external_id = n.external_id) AS revised
      FROM normalized_events n WHERE n.id = $1`, [run.eventId]);
    const row = result.rows[0];
    if (!row || row.ingest_source !== 'meta_webhook' || row.rule_eligible !== true || row.kind !== 'comment') {
      await this.finish(run, 'skip', 'skipped', '不是新接收的已验签 Webhook 评论，跳过。');
      return;
    }
    if (row.sender_id === row.channel_id || row.own_reply === true) {
      await this.finish(run, 'skip', 'skipped', '主页自己的回复不参与规则处理。');
      return;
    }
    if (row.revised === true && !run.writeStarted) {
      await this.finish(run, 'skip', 'skipped', '评论已在平台编辑或删除，原内容的规则任务不再执行。');
      return;
    }
    if ((row.platform !== 'facebook' && row.platform !== 'instagram') || typeof row.body !== 'string' || !row.body.trim()) {
      await this.finish(run, 'skip', 'skipped', '评论没有可检查的文字。');
      return;
    }
    const comment: Comment = {
      platform: row.platform, channelId: String(row.channel_id), externalId: String(row.external_id), text: row.body,
    };
    const matches = await this.matches(run, comment);
    if (!matches.length && !run.writeStarted) {
      await this.finish(run, 'skip', 'skipped', '没有命中当前仍开启的规则，或规则在评论进入后才开启。');
      return;
    }
    if (matches.length && !run.writeStarted) {
      // Capture actual matches before remote reads so failures remain attributable.
      // A recovered write keeps the original attribution, even if rules changed.
      await this.options.db.query(`UPDATE rule_runs SET matched_rule_ids = $3::uuid[],
        rule_id = COALESCE((SELECT id FROM inbox_rules WHERE id = $4::uuid FOR KEY SHARE), rule_id),
        rule_name = $5, matched_keywords = $6::text[]
        WHERE id = $1 AND claim_token = $2 AND status = 'processing'`,
      [run.id, run.claimToken, matches.map((match) => match.rule.id), matches[0].rule.id,
        this.ruleNames(matches), this.keywords(matches)]);
    }
    // A previous worker may have stopped after Graph accepted a write. Resolve
    // that uncertainty by GET only, even if the original rule was disabled.
    const inspection = await this.inspect(comment, run.eventId, matches.length > 0 && !run.writeStarted);
    if (!inspection.result.ok) {
      await this.finish(run, 'review', 'failed', '无法确认平台当前的隐藏状态，未发送隐藏请求，请人工检查。', matches);
      return;
    }
    const visibility = inspection.result;
    await this.rememberVisibility(comment, visibility.hidden, inspection.observedAt);
    await this.options.db.query(`UPDATE rule_runs SET visibility_before = COALESCE(visibility_before, $3)
      WHERE id = $1 AND claim_token = $2 AND status = 'processing'`, [run.id, run.claimToken, visibility.hidden]);
    if (visibility.hidden) {
      await this.finish(run, 'skip', 'already_hidden', run.writeStarted
        ? '恢复检查时评论已隐藏，未重复发送；不计为本规则新隐藏。'
        : '平台已隐藏这条评论，可能由官方审核或人工处理；跳过 AI 和隐藏请求。', matches);
      return;
    }
    if (run.writeStarted) {
      await this.finish(run, 'review', 'failed', '上次隐藏请求结果未能确认，当前评论可见；为避免重复执行，交人工处理。', matches);
      return;
    }
    if (!await this.current(run, matches)) {
      await this.finish(run, 'skip', 'skipped', '规则已关闭或修改，本次待处理任务不再自动执行。', matches);
      return;
    }

    const requiredReview = matches.find((match) => match.preview.next === 'review');
    if (requiredReview) {
      await this.finish(run, 'review', 'review', `${requiredReview.rule.name}：命中关键词，按配置交人工处理。`, matches);
      return;
    }
    const decisions: Array<{ decision: Exclude<Decision, 'skip'>; reason: string }> = [];
    let context: string | undefined;
    for (const match of matches) {
      const { preview, rule } = match;
      if (preview.next === 'review') {
        decisions.push({ decision: 'review', reason: `${rule.name}：命中关键词，按配置交人工处理。` });
        // A human-review requirement cannot be overridden by another rule.
        break;
      }
      if (preview.next === 'hide') {
        decisions.push({ decision: 'hide', reason: `${rule.name}：${preview.matchedGroups.length ? '命中关键词条件组' : '整条评论匹配确定短句'}。` });
        continue;
      }
      if (preview.next !== 'ai' || !this.options.judge || comment.text.length > 4000) {
        decisions.push({ decision: 'review', reason: '规则需要 AI 复核，但服务未配置、内容超出限制或动作尚未支持，交人工处理。' });
        break;
      }
      if (!await this.current(run, matches)) {
        await this.finish(run, 'skip', 'skipped', '规则已关闭或修改，已停止本次处理。', matches);
        return;
      }
      context ??= await this.cachedContext(run.eventId, comment);
      const judgment = await this.options.judge.judge({
        rule, text: comment.text, context, matchedKeywords: preview.matchedKeywords, staffId: `rule-run-${run.id}`,
      });
      const decision = judgment.decision === 'reply' || !rule.allowedActions.includes(judgment.decision)
        ? 'review' : judgment.decision;
      decisions.push({ decision, reason: `${rule.name}：${judgment.reason}` });
      if (decision === 'review') break;
    }
    if (!await this.current(run, matches)) {
      await this.finish(run, 'skip', 'skipped', '规则已关闭或修改，已停止本次处理。', matches);
      return;
    }
    const unique = new Set(decisions.map((item) => item.decision));
    const reason = decisions.map((item) => item.reason).join('\n').slice(0, 1600);
    if (unique.size !== 1 || unique.has('review')) {
      await this.finish(run, 'review', 'review', unique.size > 1
        ? `多条规则判断不一致，交人工处理。\n${reason}` : reason || '无法明确判断，交人工处理。', matches);
      return;
    }
    if (unique.has('keep')) {
      await this.finish(run, 'keep', 'kept', reason, matches);
      return;
    }
    if (!visibility.canHide || !this.options.client.setHidden || !inspection.accessToken) {
      await this.finish(run, 'review', 'failed', '当前没有隐藏这条评论的权限或能力，请人工处理。', matches);
      return;
    }
    // Fence the write with both the claim token and every matched rule revision.
    // A toggle/edit during AI cannot make an old decision execute afterward.
    const admitted = await this.options.db.query(`UPDATE rule_runs q
      SET write_started_at = clock_timestamp(), rule_id = $3, rule_name = $4,
          matched_keywords = $5::text[], matched_rule_ids = $7::uuid[], decision = 'hide', reason = $6
      WHERE q.id = $1 AND q.claim_token = $2 AND q.status = 'processing'
        AND q.write_started_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM normalized_events n JOIN comment_revisions revision
          ON revision.platform = n.platform AND revision.channel_id = n.channel_id AND revision.external_id = n.external_id
          WHERE n.id = q.normalized_event_id)
        AND (SELECT count(*) FROM inbox_rules r
          JOIN unnest($7::uuid[], $8::text[]) AS chosen(id, revision) ON chosen.id = r.id
          WHERE r.enabled AND r.category = 'moderation' AND r.enabled_at <= q.created_at
            AND md5(to_jsonb(r)::text) = chosen.revision) = $9
      RETURNING q.id`, [run.id, run.claimToken, matches[0].rule.id, this.ruleNames(matches),
      this.keywords(matches), reason, matches.map((match) => match.rule.id), matches.map((match) => match.revision), matches.length]);
    if (!admitted.rows.length) {
      await this.finish(run, 'skip', 'skipped', '规则或任务状态已改变，本次未发送隐藏请求。', matches);
      return;
    }
    const changedAt = new Date();
    const hidden = await this.options.client.setHidden({
      platform: comment.platform, externalId: comment.externalId,
      accessToken: inspection.accessToken, hidden: true,
    });
    if (!hidden.ok || !hidden.hidden) {
      await this.finish(run, 'review', 'failed', '隐藏请求未能确认成功，已转人工；不会自动重复发送，请检查平台当前状态。', matches);
      return;
    }
    await this.rememberVisibility(comment, true, changedAt);
    const wasChanged = (hidden as VisibilityResult & { changed?: boolean }).changed !== false;
    await this.finish(run, wasChanged ? 'hide' : 'skip', wasChanged ? 'hidden' : 'already_hidden',
      wasChanged ? reason : '执行前再次检查时，评论已被其他渠道隐藏；没有重复隐藏。', matches);
  }

  private async matches(run: Run, comment: Comment): Promise<Match[]> {
    const versions = await this.options.db.query(`SELECT id, md5(to_jsonb(r)::text) AS revision
      FROM inbox_rules r WHERE id = ANY($1::uuid[]) AND enabled AND category = 'moderation'
        AND enabled_at <= $2`, [run.ruleIds, run.createdAt]);
    if (!versions.rows.length) return [];
    const revisions = new Map(versions.rows.map((row) => [String(row.id), String(row.revision)]));
    const rules = (await this.options.rules.list()).filter((rule) => revisions.has(rule.id) && rule.category === 'moderation');
    const matches = rules.map((rule) => ({
      rule, revision: revisions.get(rule.id)!,
      preview: evaluateRule(rule, comment.text, comment.platform, comment.channelId),
    })).filter((match) => match.preview.matched && match.preview.next !== 'skip');
    if (matches.length && !await this.current(run, matches)) throw new Error('RuleConfigurationChanged');
    return matches;
  }

  private async current(run: Run, matches: Match[]): Promise<boolean> {
    if (!matches.length) return false;
    const result = await this.options.db.query(`SELECT count(*)::int AS count FROM inbox_rules r
      JOIN unnest($1::uuid[], $2::text[]) AS chosen(id, revision) ON chosen.id = r.id
      WHERE r.enabled AND r.category = 'moderation' AND r.enabled_at <= $3
        AND md5(to_jsonb(r)::text) = chosen.revision
        AND EXISTS (SELECT 1 FROM rule_runs q WHERE q.id = $4 AND q.claim_token = $5 AND q.status = 'processing')`,
    [matches.map((match) => match.rule.id), matches.map((match) => match.revision), run.createdAt, run.id, run.claimToken]);
    return result.rows[0]?.count === matches.length;
  }

  private async inspect(comment: Comment, eventId: string, refresh: boolean): Promise<{
    result: VisibilityResult; accessToken?: string; observedAt: Date;
  }> {
    if (!this.options.client.visibility) return { result: { ok: false, code: 'visibility_unavailable' }, observedAt: new Date() };
    const stored = this.options.tokens.tokensForChannel
      ? await this.options.tokens.tokensForChannel(comment.channelId)
      : [await this.options.tokens.tokenForChannel(comment.channelId)].filter((token): token is string => !!token);
    const candidates = [...new Set([this.options.channelTokens?.[comment.channelId], ...stored]
      .filter((token): token is string => !!token))];
    if (refresh && candidates[0] && this.options.refreshContext) {
      try {
        await this.options.refreshContext({ eventId, platform: comment.platform, channelId: comment.channelId,
          externalId: comment.externalId, accessToken: candidates[0] });
      } catch (error) { logSafeError('rule runner context refresh failed', error); }
    }
    // Timestamp this individual inspection after the optional bulk refresh so
    // an older batch observation cannot replace a newer Graph visibility read.
    const observedAt = new Date();
    let result: VisibilityResult = { ok: false, code: 'missing_token' };
    for (const accessToken of candidates) {
      result = await this.options.client.visibility({ platform: comment.platform, externalId: comment.externalId, accessToken });
      if (result.ok) return { result, accessToken, observedAt };
      if (!AUTH_FAILURE.test(result.code)) break;
    }
    return { result, observedAt };
  }

  private async rememberVisibility(comment: Comment, hidden: boolean, observedAt: Date): Promise<void> {
    await this.options.db.query(`INSERT INTO comment_visibility(platform, channel_id, external_id, hidden, checked_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (platform, channel_id, external_id) DO UPDATE
      SET hidden = EXCLUDED.hidden, checked_at = EXCLUDED.checked_at
      WHERE comment_visibility.checked_at <= EXCLUDED.checked_at`,
    [comment.platform, comment.channelId, comment.externalId, hidden, observedAt]);
  }

  private async cachedContext(eventId: string, comment: Comment): Promise<string> {
    const result = await this.options.db.query(`WITH event_post AS (
      SELECT COALESCE(c->'value'->>'post_id', c->'value'->'media'->>'id') AS post_id
      FROM normalized_events n JOIN webhook_events w ON w.id = n.webhook_event_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.raw_payload->'entry', '[]'::jsonb)) e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e->'changes', '[]'::jsonb)) c
      WHERE n.id = $1 AND COALESCE(c->'value'->>'comment_id', c->'value'->>'id') = n.external_id
      LIMIT 1
    ) SELECT cache.payload->>'postText' AS context FROM comment_context cache
      JOIN normalized_events anchor ON anchor.id = cache.normalized_event_id
      WHERE anchor.platform = $2 AND anchor.channel_id = $3
        AND (cache.normalized_event_id = $1 OR cache.post_id = (SELECT post_id FROM event_post))
      ORDER BY (cache.normalized_event_id = $1) DESC, cache.fetched_at DESC LIMIT 1`,
    [eventId, comment.platform, comment.channelId]);
    const context = result.rows[0]?.context;
    return typeof context === 'string' ? context.slice(0, 2000) : '';
  }

  private ruleNames(matches: Match[]): string | null {
    return matches.length ? matches.map((match) => match.rule.name).join('；').slice(0, 1000) : null;
  }

  private keywords(matches: Match[]): string[] {
    return [...new Set(matches.flatMap((match) => match.preview.matchedKeywords))].slice(0, 200);
  }

  private async finish(run: Run, decision: Decision, outcome: Outcome, reason: string, matches: Match[] = []): Promise<void> {
    await this.options.db.query(`UPDATE rule_runs SET status = 'completed', decision = $3, outcome = $4,
      reason = $5, processed_at = clock_timestamp(),
      rule_id = CASE WHEN $10::boolean THEN rule_id
        ELSE COALESCE((SELECT id FROM inbox_rules WHERE id = $6::uuid FOR KEY SHARE), rule_id) END,
      rule_name = CASE WHEN $10::boolean THEN rule_name ELSE COALESCE($7, rule_name) END,
      matched_keywords = CASE WHEN NOT $10::boolean AND cardinality($8::text[]) > 0 THEN $8::text[] ELSE matched_keywords END,
      matched_rule_ids = CASE WHEN NOT $10::boolean AND cardinality($9::uuid[]) > 0 THEN $9::uuid[] ELSE matched_rule_ids END,
      review_status = CASE WHEN $3 = 'review' THEN 'open' ELSE 'resolved' END
      WHERE id = $1 AND claim_token = $2 AND status = 'processing'`,
    [run.id, run.claimToken, decision, outcome, reason.slice(0, 1600), matches[0]?.rule.id ?? null,
      this.ruleNames(matches), this.keywords(matches), matches.map((match) => match.rule.id), run.writeStarted]);
  }
}
