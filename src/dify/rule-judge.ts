import { DEFAULT_RULE_ALLOWED_ACTIONS, type RuleInput } from '../staff/rule-store.js';

export interface RuleJudgment { reviewedBy: 'ai' | 'system'; decision: 'hide' | 'keep' | 'review' | 'reply'; reason: string; reply: string; sources: string[] }
export interface RuleJudge { judge(input: { rule: RuleInput; text: string; context: string; matchedKeywords: string[]; staffId: string }): Promise<RuleJudgment> }
const human = (reason: string): RuleJudgment => ({ reviewedBy: 'system', decision: 'review', reason, reply: '', sources: [] });

export function createRuleJudge(options: { apiBase: string; apiKey: string; fetchImpl?: typeof fetch }): RuleJudge {
  return { async judge(input) {
    // No retrieval-backed knowledge base is connected yet. Never present model guesses as sourced answers.
    if (input.rule.category === 'reply') return human('尚未接入产品知识库。此规则已命中回复意图，但尺码、版型或订单信息缺少可核实依据，建议交人工；不生成猜测性回复或追问。');
    if (!input.rule.aiInstruction.trim()) return human('尚未填写本规则的 AI 判断标准，请先补充后再试跑，当前建议交人工。');
    const allowedActions = input.rule.allowedActions ?? DEFAULT_RULE_ALLOWED_ACTIONS;
    if (!allowedActions.includes('review')) return human('规则未保留转人工处理，无法安全判断，请检查允许 AI 选择的动作。');
    try {
      const response = await (options.fetchImpl ?? fetch)(`${options.apiBase}/workflows/run`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: { text: input.text, rule_name: input.rule.name, goal: input.rule.category,
          matched_keywords: input.matchedKeywords.join('\n').slice(0, 2000), rule_instructions: input.rule.aiInstruction,
          allowed_actions: JSON.stringify(allowedActions),
          post_text: input.context }, response_mode: 'blocking', user: input.staffId }),
      });
      if (!response.ok) { await response.body?.cancel(); return human('AI 服务暂时不可用，建议交人工。'); }
      const reader = response.body?.getReader();
      if (!reader) return human('AI 未返回有效结果，建议交人工。');
      const decoder = new TextDecoder(); let body = ''; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 128 * 1024) { await reader.cancel(); return human('AI 结果超出限制，建议交人工。'); }
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
      const data = JSON.parse(body).data;
      if (data?.status !== 'succeeded' || typeof data.outputs?.text !== 'string') return human('AI 未完成判断，建议交人工。');
      const content = data.outputs.text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const result = JSON.parse(content);
      if (!['hide','keep','review'].includes(result.decision) || typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 1600) return human('AI 返回格式不符合约定，建议交人工。');
      if (!allowedActions.includes(result.decision)) return human('AI 建议的动作不在本规则允许的范围内，已转人工处理；未执行该动作。');
      return { reviewedBy: 'ai', decision: result.decision, reason: result.reason, reply: '', sources: [] };
    } catch { return human('AI 请求超时或结果无法解析，建议交人工。'); }
  } };
}
