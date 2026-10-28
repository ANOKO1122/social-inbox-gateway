import type { Staff } from './staff-repository.js';
import type { RuleLogItem, RuleLogOutcome, RuleLogPage } from './rule-log-store.js';
import { formatBeijing } from './beijing-time.js';
import { shell } from './workbench-page.js';

const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const count = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const outcomes: Array<{ value: 'all' | RuleLogOutcome; label: string }> = [
  { value: 'all', label: '全部结果' }, { value: 'hidden', label: '本规则隐藏' },
  { value: 'already_hidden', label: '平台已隐藏' }, { value: 'review', label: '转人工' },
  { value: 'kept', label: '保留评论' }, { value: 'failed', label: '异常转人工' },
  { value: 'skipped', label: '已跳过' },
];

function content(text: string, limit: number, label: string): string {
  const value = text || '（没有文字）';
  if (value.length <= limit) return `<p class="rule-log-text">${esc(value)}</p>`;
  return `<p class="rule-log-text">${esc(value.slice(0, limit))}…</p>
    <details class="rule-log-detail"><summary>${label}</summary><p class="rule-log-text">${esc(value)}</p></details>`;
}

function reviewState(item: RuleLogItem): string {
  if (item.decision !== 'review') return '';
  const label = item.reviewStatus === 'open' ? '待人工审核'
    : item.reviewStatus === 'dismissed' ? '已标记无需处理' : '人工已处理';
  return `<span class="rule-log-sub">${label}${item.reviewedAt ? ` · ${esc(formatBeijing(new Date(item.reviewedAt)))}` : ''}</span>`;
}

export function renderRuleLogsPage(input: { staff: Staff; nonce: string; data: RuleLogPage }): string {
  const { data } = input;
  const url = (outcome: RuleLogPage['outcome'], page = 1) =>
    `/inbox/admin/rules/${encodeURIComponent(data.rule.id)}/logs?outcome=${outcome}&page=${page}`;
  const label = outcomes.find(item => item.value === data.outcome)?.label ?? '全部结果';
  const rows = data.items.map(item => {
    const result = outcomes.find(outcome => outcome.value === item.outcome)?.label ?? '已处理';
    const when = item.processedAt ? formatBeijing(new Date(item.processedAt)) : '时间未记录';
    return `<tr data-log-outcome="${item.outcome}">
      <td><a class="rule-log-time" href="${esc(item.inboxUrl)}" title="在收件箱定位这条评论">${esc(when)}</a></td>
      <td><strong>${esc(item.channelName)}</strong><span class="rule-log-sub">${item.platform === 'instagram' ? 'Instagram' : 'Facebook'}</span></td>
      <td><span class="rule-log-author">${esc(item.senderName || '未提供用户名')}</span>${content(item.text, 260, '展开完整评论')}
        ${item.postText ? `<details class="rule-log-detail"><summary>查看帖子正文</summary><p class="rule-log-text">${esc(item.postText)}</p></details>` : ''}
      </td>
      <td><span class="rule-log-outcome outcome-${item.outcome}">${result}</span>${reviewState(item)}
        ${content(item.reason || '没有补充原因。', 240, '展开完整原因')}
        ${item.matchedKeywords.length ? `<details class="rule-log-detail"><summary>命中词 · ${item.matchedKeywords.length}</summary><p class="rule-log-text">${esc(item.matchedKeywords.join('、'))}</p></details>` : ''}
      </td>
      <td><div class="rule-log-actions"><a class="rule-log-button" href="${esc(item.inboxUrl)}">收件箱定位</a>${item.sourceUrl ? `<a class="rule-log-source" href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${item.sourceLabel}</a>` : '<span class="rule-log-sub">暂无源链接</span>'}</div></td>
    </tr>`;
  }).join('');
  const pages = Math.max(1, data.totalPages);
  const start = data.items.length ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = start ? start + data.items.length - 1 : 0;
  return shell({ title: `${data.rule.name} · 处理日志`, nonce: input.nonce, staff: input.staff, section: 'admin', body: `
<style>
.rule-logs { flex:1; min-height:0; overflow:auto; padding:28px 32px 40px; scrollbar-color:#aaa79e var(--paper); }
.rule-logs-content { max-width:1600px; min-width:1050px; margin:0 auto; }
.rule-logs ::selection { background:var(--signal); color:var(--ink); }
.rule-logs a { text-underline-offset:3px; }
.rule-logs-back { display:inline-block; margin-bottom:20px; font-size:13px; color:#66635c; }
.rule-logs-heading { display:flex; justify-content:space-between; align-items:center; gap:24px; }
.rule-logs-heading h1 { margin:0 0 8px; font-size:28px; letter-spacing:-.02em; }
.rule-logs-heading p { margin:0; font-size:15px; overflow-wrap:anywhere; }
.rule-logs-heading small { margin-left:12px; color:#66635c; white-space:nowrap; font-size:12px; }
.rule-log-button { display:inline-flex; align-items:center; justify-content:center; min-height:36px; padding:7px 12px; border:1px solid var(--line); border-radius:4px; background:var(--sheet); text-decoration:none; white-space:nowrap; font-size:13px; }
.rule-log-button:hover { border-color:var(--ink); }
.rule-logs-note { margin:24px 0 20px; padding:12px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); color:#66635c; font-size:13px; line-height:1.7; }
.rule-logs-note strong { color:var(--ink); font-weight:500; }
.rule-log-filters { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.rule-log-filters a { display:inline-flex; align-items:center; min-height:36px; padding:7px 12px; border:1px solid var(--line); text-decoration:none; font-size:13px; }
.rule-log-filters a:hover { border-color:var(--ink); }
.rule-log-filters a[aria-current=page] { background:var(--signal); border-color:var(--ink); }
.rule-log-filters span { margin-left:8px; font-variant-numeric:tabular-nums; }
.rule-log-counts { display:flex; justify-content:space-between; gap:16px; margin:16px 0 10px; font-size:12px; color:#66635c; }
.rule-log-table { width:100%; table-layout:fixed; border-collapse:collapse; font-size:13px; }
.rule-log-table th { position:static; text-align:left; font-size:12px; font-weight:500; color:#66635c; letter-spacing:0; padding:12px; border-bottom:1px solid var(--ink); }
.rule-log-table td { padding:18px 12px; vertical-align:top; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
.rule-log-table th:first-child,.rule-log-table td:first-child { padding-left:0; }
.rule-log-table th:last-child,.rule-log-table td:last-child { padding-right:0; }
.rule-log-table tbody tr:hover { background:var(--sheet); }
.rule-log-time { white-space:nowrap; font-size:12px; font-variant-numeric:tabular-nums; }
.rule-log-author { display:block; font-weight:600; margin-bottom:6px; }
.rule-log-text { margin:8px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; }
.rule-log-author + .rule-log-text { margin-top:0; }
.rule-log-sub { display:block; color:#66635c; font-size:12px; margin-top:6px; line-height:1.6; }
.rule-log-outcome { display:inline-flex; padding:3px 7px; border:1px solid var(--line); background:#eae7df; font-size:12px; }
.rule-log-outcome.outcome-hidden { background:#eaf3ed; color:#185434; border-color:#bfd1c4; }
.rule-log-outcome.outcome-review { background:#f6efce; color:#65511c; border-color:#d8c88c; }
.rule-log-outcome.outcome-failed { background:#f7e8e5; color:#8d1d18; border-color:#ddb7b0; }
.rule-log-detail { margin-top:8px; font-size:12px; }
.rule-log-detail summary { width:fit-content; color:#66635c; cursor:pointer; }
.rule-log-detail[open] summary { color:var(--ink); }
.rule-log-actions { display:flex; flex-direction:column; align-items:flex-start; gap:10px; }
.rule-log-source { font-size:12px; }
.rule-log-empty { padding:60px 24px; text-align:center; border-bottom:1px solid var(--line); }
.rule-log-empty h2 { font-size:18px; margin:0 0 8px; }
.rule-log-empty p { color:#66635c; margin:0 0 18px; font-size:13px; }
.rule-log-pagination { display:flex; align-items:center; justify-content:flex-end; gap:12px; padding-top:20px; font-size:13px; }
.rule-log-pagination > span { color:#66635c; font-variant-numeric:tabular-nums; }
.rule-log-pagination .disabled { padding:8px 12px; color:#77736b; }
</style>
<main class="rule-logs"><div class="rule-logs-content">
  <a class="rule-logs-back" href="/inbox/admin/rules">返回评论规则</a>
  <header class="rule-logs-heading"><div><h1>规则处理日志</h1><p>${esc(data.rule.name)}<small>${data.rule.enabled ? '自动处理运行中' : '自动处理已停用'}</small></p></div><a class="rule-log-button" href="${esc(url(data.outcome, data.page))}">刷新日志</a></header>
  <p class="rule-logs-note">仅记录这条规则参与的真实处理，试跑不计入。<strong>“平台已隐藏”表示检查时已隐藏，本规则未再次操作。</strong>日志展示当时的处理结果；评论当前状态以平台为准。</p>
  <nav class="rule-log-filters" aria-label="筛选处理结果">${outcomes.map(item => `<a href="${esc(url(item.value))}"${data.outcome === item.value ? ' aria-current="page"' : ''}>${item.label}<span>${count(item.value === 'all' ? data.summary.total : data.summary[item.value])}</span></a>`).join('')}</nav>
  <div class="rule-log-counts"><span>该规则累计 ${count(data.summary.total)} 条记录 · 当前结果 ${count(data.total)} 条</span><span>最新处理在前 · 北京时间 · 每页 ${data.pageSize} 条</span></div>
  ${rows ? `<table class="rule-log-table"><colgroup><col style="width:145px"><col style="width:155px"><col><col style="width:31%"><col style="width:126px"></colgroup><thead><tr><th scope="col">处理时间</th><th scope="col">主页 / 平台</th><th scope="col">评论内容</th><th scope="col">结果与原因</th><th scope="col">查看评论</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<section class="rule-log-empty"><h2>${data.summary.total === 0 ? '这条规则还没有处理记录' : data.page > pages ? '这一页没有记录' : `暂无“${label}”记录`}</h2><p>${data.summary.total === 0 ? '启用后，新收到且命中规则的评论会记录在这里；关键词试跑不会产生执行日志。' : '可切换其他结果，或返回第一页查看最近处理的评论。'}</p>${data.summary.total ? `<a class="rule-log-button" href="${esc(url('all'))}">查看全部结果</a>` : '<a class="rule-log-button" href="/inbox/admin/rules">返回规则管理</a>'}</section>`}
  <footer class="rule-log-pagination"><span>${start ? `${count(start)}–${count(end)} / ${count(data.total)} 条 · ` : ''}第 ${data.page} / ${pages} 页</span>${data.page > 1 ? `<a class="rule-log-button" href="${esc(url(data.outcome, data.page - 1))}">上一页</a>` : '<span class="disabled" aria-disabled="true">上一页</span>'}${data.page < pages ? `<a class="rule-log-button" href="${esc(url(data.outcome, data.page + 1))}">下一页</a>` : '<span class="disabled" aria-disabled="true">下一页</span>'}</footer>
</div></main>` });
}
