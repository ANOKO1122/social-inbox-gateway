import type { ChannelDb } from '../connect/channel-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID = /^[0-9]{5,32}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

export type RuleAllowedAction = 'hide' | 'keep' | 'review';
export const DEFAULT_RULE_ALLOWED_ACTIONS: readonly RuleAllowedAction[] = ['hide', 'keep', 'review'];

export interface Rule {
  id: string;
  name: string;
  category: 'moderation' | 'reply';
  platform: 'all' | 'facebook' | 'instagram';
  channelIds: string[];
  matchMode: 'any' | 'all';
  keywords: string[];
  keywordGroups: string[][];
  directPhrases?: string[];
  directAction?: 'hide' | 'review';
  exclusions: string[];
  wordBoundary: boolean;
  aiEnabled: boolean;
  aiInstruction: string;
  allowedActions: RuleAllowedAction[];
  action: 'hide' | 'review' | 'reply';
  status: 'disabled' | 'observe';
  enabled?: boolean;
  enabledAt?: string | null;
  priority: number;
  updatedAt?: string;
}

export type RuleInput = Omit<Rule, 'id' | 'updatedAt' | 'enabled' | 'enabledAt' | 'keywordGroups' | 'allowedActions'> & {
  id?: string;
  keywordGroups?: string[][];
  allowedActions?: RuleAllowedAction[];
};

type ValidatedRuleInput = RuleInput & {
  keywordGroups: string[][];
  directPhrases: string[];
  directAction: 'hide' | 'review';
  allowedActions: RuleAllowedAction[];
};

export interface RulePreview {
  matched: boolean;
  excluded: boolean;
  matchedKeywords: string[];
  matchedGroups: number[];
  groupResults: {
    index: number;
    matched: boolean;
    matchedKeywords: string[];
    missingKeywords: string[];
  }[];
  excludedKeywords: string[];
  reason: string;
  next: 'skip' | 'ai' | 'hide' | 'review' | 'reply';
}

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

function invalid(message: string): never {
  throw new RuleValidationError(message);
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('规则格式不正确。');
  }
  return input as Record<string, unknown>;
}

function text(input: unknown, label: string, max: number, empty = false): string {
  if (typeof input !== 'string' || input.length > max || CONTROL.test(input)) {
    invalid(`${label}格式不正确，最多 ${max} 个字符。`);
  }
  const result = input.trim();
  if (!empty && !result) invalid(`请填写${label}。`);
  return result;
}

function choice<T extends string>(input: unknown, values: readonly T[], label: string): T {
  if (typeof input !== 'string' || !values.includes(input as T)) invalid(`${label}不正确。`);
  return input as T;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') invalid(`${label}格式不正确。`);
  return input;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function normalizedPhrase(value: string): string {
  return normalized(value).trim().replace(/\s+/gu, ' ');
}

function terms(input: unknown, label: string, required: boolean): string[] {
  if (!Array.isArray(input) || input.length > 100) invalid(`${label}最多填写 100 项。`);
  const unique = new Map<string, string>();
  for (const item of input) {
    const term = text(item, label, 160);
    const key = normalized(term);
    if (!unique.has(key)) unique.set(key, term);
  }
  const result = [...unique.values()];
  if (required && !result.length) invalid('请至少填写一个关键词。');
  return result;
}

function conditionGroups(input: unknown): string[][] {
  if (!Array.isArray(input) || !input.length || input.length > 100) {
    invalid('请添加至少一个触发条件组，最多 100 组。');
  }
  let count = 0;
  return input.map((group, index) => {
    if (!Array.isArray(group) || !group.length) invalid(`条件组 ${index + 1} 至少需要一个关键词。`);
    count += group.length;
    if (count > 100) invalid('所有触发条件组合计最多填写 100 个关键词。');
    return terms(group, `条件组 ${index + 1} 的关键词`, true);
  });
}

function groupsFor(rule: Pick<RuleInput, 'keywordGroups' | 'keywords' | 'matchMode'>): string[][] {
  return rule.keywordGroups ?? (rule.matchMode === 'all' ? [rule.keywords] : rule.keywords.map((term) => [term]));
}

function parseRule(input: unknown, stored = false): ValidatedRuleInput {
  const value = record(input);
  let id: string | undefined;
  if (value.id !== undefined && value.id !== '') {
    if (typeof value.id !== 'string' || !UUID.test(value.id)) invalid('规则编号不正确。');
    id = value.id;
  }
  const category = choice(value.category ?? 'moderation', ['moderation', 'reply'] as const, '规则用途');
  const action = choice(value.action ?? 'review', ['hide', 'review', 'reply'] as const, '处理动作');
  if ((category === 'reply') !== (action === 'reply')) invalid('规则用途和处理动作不一致。');
  const directPhrases = [...new Map(terms(value.directPhrases ?? [], '确定短句', false)
    .map((phrase) => [normalizedPhrase(phrase), phrase])).values()];
  if (category === 'reply' && directPhrases.length) invalid('确定短句仅适用于评论审核规则。');
  const channelIds = value.channelIds ?? [];
  if (!Array.isArray(channelIds) || channelIds.length > 200 ||
      channelIds.some((item) => typeof item !== 'string' || !CHANNEL_ID.test(item))) {
    invalid('主页编号格式不正确，最多选择 200 个主页。');
  }
  const priority = value.priority ?? 100;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 1000) {
    invalid('优先级必须是 1 到 1000 的整数。');
  }
  const aiEnabled = boolean(value.aiEnabled ?? false, 'AI 判断');
  if (category === 'reply' && !aiEnabled) invalid('AI 回复规则需要开启 AI 介入。');
  const aiInstruction = text(value.aiInstruction ?? '', '本规则的 AI 判断标准', 4000, true);
  if (!stored && category === 'moderation' && aiEnabled && !aiInstruction) {
    invalid('请填写本规则的 AI 判断标准，说明哪些情况隐藏、保留或转人工。');
  }
  const allowedActions = value.allowedActions ?? DEFAULT_RULE_ALLOWED_ACTIONS;
  if (!Array.isArray(allowedActions) || !allowedActions.length || allowedActions.length > 3 ||
      allowedActions.some((item) => !DEFAULT_RULE_ALLOWED_ACTIONS.includes(item as RuleAllowedAction))) {
    invalid('允许 AI 选择的动作不正确，请选择隐藏评论、保留评论或转人工处理。');
  }
  if (!allowedActions.includes('review')) invalid('必须保留“转人工处理”，用于无法判断、服务异常或动作不允许时兜底。');
  let matchMode: 'any' | 'all';
  let keywords: string[];
  let keywordGroups: string[][];
  if (value.keywordGroups !== undefined) {
    keywordGroups = conditionGroups(value.keywordGroups);
    keywords = terms(keywordGroups.flat(), '关键词', true);
    // These legacy fields remain available to older readers; group conditions are authoritative.
    matchMode = keywordGroups.length === 1 && keywordGroups[0].length > 1 ? 'all' : 'any';
  } else {
    matchMode = choice(value.matchMode ?? 'any', ['any', 'all'] as const, '匹配方式');
    keywords = terms(value.keywords, '关键词', true);
    keywordGroups = groupsFor({ keywords, matchMode });
  }
  return {
    ...(id ? { id } : {}),
    name: text(value.name, '规则名称', 80),
    category,
    platform: choice(value.platform ?? 'all', ['all', 'facebook', 'instagram'] as const, '平台'),
    channelIds: [...new Set(channelIds as string[])],
    matchMode,
    keywords,
    keywordGroups,
    directPhrases,
    directAction: choice(value.directAction ?? 'hide', ['hide', 'review'] as const, '确定短句的处理动作'),
    exclusions: terms(value.exclusions ?? [], '排除词', false),
    wordBoundary: boolean(value.wordBoundary ?? false, '完整词匹配'),
    aiEnabled,
    aiInstruction,
    allowedActions: [...new Set(allowedActions as RuleAllowedAction[])],
    action,
    status: choice(value.status ?? 'disabled', ['disabled', 'observe'] as const, '规则状态'),
    priority,
  };
}

export function validateRule(input: unknown): ValidatedRuleInput {
  return parseRule(input);
}

function contains(haystack: string, term: string, boundary: boolean): boolean {
  const needle = normalized(term);
  let position = haystack.indexOf(needle);
  while (position >= 0) {
    if (!boundary) return true;
    const before = Array.from(haystack.slice(Math.max(0, position - 2), position)).at(-1) ?? '';
    const after = Array.from(haystack.slice(position + needle.length, position + needle.length + 2))[0] ?? '';
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) return true;
    position = haystack.indexOf(needle, position + 1);
  }
  return false;
}

// Pure matching: callers decide whether to preview the result or execute enabled rules.
export function evaluateRule(
  rule: RuleInput,
  comment: string,
  platform: 'facebook' | 'instagram',
  channelId: string,
): RulePreview {
  const result: RulePreview = {
    matched: false, excluded: false, matchedKeywords: [], matchedGroups: [], groupResults: [],
    excludedKeywords: [], reason: '', next: 'skip',
  };
  if (rule.platform !== 'all' && rule.platform !== platform) {
    return { ...result, reason: '该评论不在规则的平台范围内。' };
  }
  if (rule.channelIds.length && !rule.channelIds.includes(channelId)) {
    return { ...result, reason: '该评论不在规则的主页范围内。' };
  }
  const body = normalized(comment);
  result.excludedKeywords = rule.exclusions.filter((term) => contains(body, term, rule.wordBoundary));
  if (result.excludedKeywords.length) {
    return { ...result, excluded: true, reason: '命中排除词，跳过此规则；排除条件优先。' };
  }
  const directPhrase = rule.category === 'moderation'
    ? rule.directPhrases?.find((phrase) => normalizedPhrase(phrase) === normalizedPhrase(comment))
    : undefined;
  if (directPhrase !== undefined) {
    return {
      ...result,
      matched: true,
      matchedKeywords: [directPhrase],
      next: rule.directAction ?? 'hide',
      reason: '整条评论完整匹配确定短句，直接采用所选动作，不调用 AI。',
    };
  }
  const groups = groupsFor(rule);
  result.groupResults = groups.map((group, index) => {
    const matchedKeywords = group.filter((term) => contains(body, term, rule.wordBoundary));
    const matchedTerms = new Set(matchedKeywords);
    const missingKeywords = group.filter((term) => !matchedTerms.has(term));
    return { index: index + 1, matched: group.length > 0 && !missingKeywords.length, matchedKeywords, missingKeywords };
  });
  result.matchedKeywords = terms(result.groupResults.flatMap((group) => group.matchedKeywords), '关键词', false);
  result.matchedGroups = result.groupResults.filter((group) => group.matched).map((group) => group.index);
  if (!result.matchedGroups.length) {
    return { ...result, reason: '没有完整命中任何条件组；同一组内的关键词必须全部出现。' };
  }
  return {
    ...result,
    matched: true,
    next: rule.aiEnabled ? 'ai' : rule.action,
    reason: rule.aiEnabled
      ? `已完整命中条件组 ${result.matchedGroups.join('、')}，可继续交给 AI 复核；条件命中不代表最终处理决定。`
      : `已完整命中条件组 ${result.matchedGroups.join('、')}，采用关键词命中后的处理动作。`,
  };
}

function fromRow(row: Record<string, unknown>): Rule {
  // Existing rules remain readable even when their AI standard has not been filled in yet.
  const input = parseRule({
    id: row.id, name: row.name, category: row.category, platform: row.platform,
    channelIds: row.channel_ids, matchMode: row.match_mode, keywords: row.keywords,
    keywordGroups: row.keyword_groups == null || (Array.isArray(row.keyword_groups) && !row.keyword_groups.length)
      ? undefined : row.keyword_groups,
    directPhrases: row.direct_phrases ?? [],
    directAction: row.direct_action ?? 'hide',
    exclusions: row.exclusions, wordBoundary: row.word_boundary, aiEnabled: row.ai_enabled,
    aiInstruction: row.ai_instruction, allowedActions: row.allowed_actions ?? undefined,
    action: row.action, status: row.status, priority: row.priority,
  }, true);
  return {
    ...input,
    id: String(row.id),
    enabled: row.enabled === true,
    enabledAt: row.enabled_at == null ? null
      : row.enabled_at instanceof Date ? row.enabled_at.toISOString() : String(row.enabled_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class RuleStore {
  constructor(private readonly db: Pick<ChannelDb, 'query'>) {}

  async list(): Promise<Rule[]> {
    const result = await this.db.query('SELECT * FROM inbox_rules ORDER BY priority ASC, updated_at DESC, id ASC');
    return result.rows.map(fromRow);
  }

  async save(input: unknown): Promise<Rule> {
    const rule = validateRule(input);
    const values: unknown[] = [
      rule.name, rule.category, rule.platform, rule.channelIds, rule.matchMode,
      rule.keywords, rule.exclusions, rule.wordBoundary, rule.aiEnabled, rule.aiInstruction,
      rule.action, rule.status, rule.priority, JSON.stringify(rule.keywordGroups), rule.allowedActions,
      rule.directPhrases, rule.directAction,
    ];
    const result = rule.id
      ? await this.db.query(`UPDATE inbox_rules SET
          name=$1, category=$2, platform=$3, channel_ids=$4, match_mode=$5,
          keywords=$6, exclusions=$7, word_boundary=$8, ai_enabled=$9, ai_instruction=$10,
          action=$11, status=$12, priority=$13, keyword_groups=$14::jsonb, allowed_actions=$15::text[],
          direct_phrases=$16::text[], direct_action=$17, updated_at=now()
          WHERE id=$18 AND ($2='moderation' OR NOT enabled) RETURNING *`, [...values, rule.id])
      : await this.db.query(`INSERT INTO inbox_rules
          (name, category, platform, channel_ids, match_mode, keywords, exclusions,
           word_boundary, ai_enabled, ai_instruction, action, status, priority, keyword_groups, allowed_actions,
           direct_phrases, direct_action)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::text[],$16::text[],$17) RETURNING *`, values);
    if (!result.rows[0]) invalid('该规则已被删除，或仍在运行中；改为 AI 回复用途前请先停用。');
    return fromRow(result.rows[0]);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Rule> {
    if (typeof id !== 'string' || !UUID.test(id)) invalid('规则编号不正确。');
    boolean(enabled, '启用状态');
    const result = await this.db.query(`UPDATE inbox_rules SET
        enabled=$2,
        enabled_at=CASE WHEN $2 AND NOT enabled THEN clock_timestamp() ELSE enabled_at END,
        updated_at=CASE WHEN enabled IS DISTINCT FROM $2 THEN now() ELSE updated_at END
        WHERE id=$1 AND (NOT $2 OR category='moderation') RETURNING *`, [id, enabled]);
    if (!result.rows[0]) invalid('该规则已被删除，或属于暂不支持自动发送的 AI 回复规则。');
    return fromRow(result.rows[0]);
  }

  async remove(id: string): Promise<boolean> {
    if (!UUID.test(id)) invalid('规则编号不正确。');
    const result = await this.db.query('DELETE FROM inbox_rules WHERE id=$1 RETURNING id', [id]);
    return result.rows.length > 0;
  }

  preview(input: unknown): RulePreview {
    const value = record(input);
    const rule = validateRule(value.rule);
    const comment = text(value.text, '测试评论', 20000);
    const platform = choice(value.platform, ['facebook', 'instagram'] as const, '测试平台');
    const channelId = value.channelId ?? '';
    if (typeof channelId !== 'string' || (channelId !== '' && !CHANNEL_ID.test(channelId))) {
      invalid('测试主页编号不正确。');
    }
    return evaluateRule(rule, comment, platform, channelId);
  }
}
