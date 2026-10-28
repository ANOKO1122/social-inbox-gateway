import type { Staff } from './staff-repository.js';
import type { InboxStatistics } from './statistics-store.js';
import { formatBeijing } from './beijing-time.js';
import { shell } from './workbench-page.js';

const esc = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const percent = (value: number, total: number) => total > 0 ? `${(value / total * 100).toFixed(1)}%` : '—';

export function renderStatisticsPage(input: { staff: Staff; nonce: string; stats: InboxStatistics }): string {
  const { stats } = input;
  const pages = [...stats.pages].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const sources = pages.slice(0, 5).map(page => ({ name: page.name, platform: page.platform === 'instagram' ? 'Instagram' : 'Facebook', total: page.total }));
  if (pages.length > 5) sources.push({ name: `其他 ${number(pages.length - 5)} 个主页`, platform: '', total: pages.slice(5).reduce((sum, page) => sum + page.total, 0) });
  const commentShare = stats.received.total ? stats.received.comments / stats.received.total * 100 : 0;
  const filterUrl = (platform: InboxStatistics['platform']) => `/inbox/admin/statistics${platform === 'all' ? '' : `?platform=${platform}`}`;
  const platformName = stats.platform === 'all' ? '全部平台' : stats.platform === 'instagram' ? 'Instagram' : 'Facebook';
  const updatedAt = formatBeijing(new Date(stats.generatedAt));
  const sourceRows = pages.map(page => `<tr data-statistics-source data-search="${esc(`${page.name} ${page.channelId} ${page.platform}`.toLocaleLowerCase())}">
    <td><strong>${esc(page.name)}</strong><small>${esc(page.channelId)}</small></td>
    <td>${page.platform === 'instagram' ? 'Instagram' : 'Facebook'}</td>
    <td class="statistics-number">${number(page.messages)}</td>
    <td class="statistics-number">${number(page.comments)}</td>
    <td class="statistics-number"><strong>${number(page.total)}</strong></td>
    <td class="statistics-number">${percent(page.total, stats.received.total)}</td>
  </tr>`).join('');

  return shell({ title: '今日统计', nonce: input.nonce, staff: input.staff, section: 'statistics', body: `
<style>
.statistics-page { --statistics-muted:#66635c; flex:1; min-height:0; overflow:auto; padding:28px 32px 40px; scrollbar-color:#aaa79e var(--paper); }
.statistics-content { max-width:1600px; min-width:1020px; margin:0 auto; }
.statistics-page ::selection { background:var(--signal); color:var(--ink); }
.statistics-page h1,.statistics-page h2,.statistics-page p { margin:0; }
.statistics-page h1 { font-size:28px; line-height:1.3; letter-spacing:-.02em; }
.statistics-page h2 { font-size:17px; line-height:1.4; }
.statistics-page a { text-underline-offset:3px; }
.statistics-heading { display:flex; justify-content:space-between; align-items:center; gap:24px; }
.statistics-date { color:var(--statistics-muted); font-size:13px; margin-top:8px !important; }
.statistics-refresh { display:flex; align-items:center; gap:16px; color:var(--statistics-muted); font-size:12px; }
.statistics-refresh a { display:inline-flex; align-items:center; gap:7px; padding:9px 14px; border:1px solid var(--line); background:var(--sheet); color:var(--ink); text-decoration:none; font-size:13px; }
.statistics-refresh a:hover { border-color:var(--ink); }
.statistics-filters { display:flex; align-items:center; gap:6px; margin:24px 0 0; padding-bottom:18px; border-bottom:1px solid var(--ink); }
.statistics-filters a { border:1px solid var(--line); padding:7px 14px; font-size:13px; text-decoration:none; background:transparent; }
.statistics-filters a:hover { border-color:var(--ink); }
.statistics-filters a[aria-current=page] { background:var(--signal); border-color:var(--ink); }
.statistics-filters > span { margin-left:auto; color:var(--statistics-muted); font-size:12px; }
.statistics-overview { display:grid; grid-template-columns:1fr 1.12fr 1.3fr; padding:24px 0 28px; border-bottom:1px solid var(--line); }
.statistics-overview > section { min-width:0; padding-right:30px; }
.statistics-overview > section + section { border-left:1px solid var(--line); padding-left:30px; }
.statistics-overview > section:last-child { padding-right:0; }
.statistics-metric-heading { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-height:26px; }
.statistics-metric-heading h2 { font-weight:500; font-size:14px; }
.statistics-state { font-size:11px; padding:3px 7px; background:var(--sheet); border:1px solid var(--line); }
.statistics-value { display:block; margin:9px 0 11px; font-size:42px; font-weight:650; line-height:1.15; letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
.statistics-value small { font-size:12px; color:var(--statistics-muted); font-weight:400; letter-spacing:0; margin-left:8px; }
.statistics-breakdown { display:flex; gap:24px; font-size:13px; color:var(--statistics-muted); }
.statistics-breakdown strong { margin-left:7px; font-weight:600; color:var(--ink); font-variant-numeric:tabular-nums; }
.statistics-metric-note { margin-top:10px !important; color:var(--statistics-muted); font-size:12px; line-height:1.6; }
.statistics-rule-values { display:flex; align-items:baseline; gap:30px; }
.statistics-rule-values .statistics-value + .statistics-value { font-size:29px; }
.statistics-visuals { display:grid; grid-template-columns:minmax(380px,.9fr) minmax(0,1.4fr); gap:40px; padding:28px 0 30px; border-bottom:1px solid var(--line); }
.statistics-section-heading { display:flex; align-items:baseline; justify-content:space-between; gap:16px; }
.statistics-section-heading p { color:var(--statistics-muted); font-size:12px; }
.statistics-composition { display:flex; align-items:center; gap:30px; min-height:208px; padding-top:20px; }
.statistics-donut { width:176px; height:176px; border-radius:50%; position:relative; flex:none; display:grid; place-items:center; }
.statistics-donut::before { content:''; position:absolute; inset:24px; border-radius:50%; background:var(--paper); }
.statistics-donut-center { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:3px; font-variant-numeric:tabular-nums; }
.statistics-donut-center strong { font-size:26px; font-weight:650; }
.statistics-donut-center span { color:var(--statistics-muted); font-size:12px; }
.statistics-legend { flex:1; min-width:150px; }
.statistics-legend-row { display:grid; grid-template-columns:11px minmax(48px,1fr) auto; align-items:center; gap:9px; margin:20px 0; font-size:13px; }
.statistics-legend-row strong { font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; }
.statistics-legend-row small { grid-column:2 / -1; color:var(--statistics-muted); font-size:12px; margin-top:-6px; }
.statistics-swatch { width:10px; height:10px; border:1px solid var(--ink); }
.statistics-swatch.comments { background:var(--ink); }
.statistics-swatch.messages { background:var(--signal); }
.statistics-ranking { display:flex; flex-direction:column; gap:12px; margin:20px 0 0; padding:0; list-style:none; }
.statistics-ranking li { display:grid; grid-template-columns:minmax(130px,1fr) minmax(100px,1fr) 58px 54px; gap:12px; align-items:center; font-size:13px; }
.statistics-ranking-name { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.statistics-ranking-name small { color:var(--statistics-muted); font-size:10px; margin-left:6px; }
.statistics-bar { height:10px; background:#e7e4db; }
.statistics-bar span { display:block; height:100%; background:var(--ink); }
.statistics-ranking li:first-child .statistics-bar span { background:#8b8324; }
.statistics-ranking strong,.statistics-ranking-percentage { text-align:right; font-variant-numeric:tabular-nums; }
.statistics-ranking-percentage { color:var(--statistics-muted); font-size:12px; }
.statistics-empty { min-height:180px; display:flex; flex-direction:column; justify-content:center; gap:8px; color:var(--statistics-muted); font-size:13px; line-height:1.7; }
.statistics-empty strong { font-size:15px; font-weight:500; color:var(--ink); }
.statistics-sources { padding-top:28px; }
.statistics-source-tools { display:flex; align-items:center; gap:16px; }
.statistics-source-tools label { color:var(--statistics-muted); font-size:12px; }
.statistics-source-tools input { display:block; width:240px; padding:8px 11px; background:var(--sheet); border:1px solid var(--line); font-size:13px; caret-color:var(--ink); }
.statistics-source-tools input::placeholder { color:var(--statistics-muted); opacity:1; }
.statistics-source-count { color:var(--statistics-muted); font-size:12px; white-space:nowrap; }
.statistics-table { width:100%; table-layout:fixed; margin-top:18px; font-size:13px; }
.statistics-table th { font-size:12px; font-weight:500; letter-spacing:0; color:var(--statistics-muted); padding:11px 12px; position:static; }
.statistics-table td { padding:14px 12px; vertical-align:middle; }
.statistics-table th:first-child,.statistics-table td:first-child { padding-left:0; }
.statistics-table th:last-child,.statistics-table td:last-child { padding-right:0; }
.statistics-table th:first-child { width:40%; }
.statistics-table th:nth-child(2) { width:16%; }
.statistics-table th:nth-child(n+3) { width:11%; }
.statistics-table tbody tr:hover { background:var(--sheet); }
.statistics-table td strong { font-weight:600; }
.statistics-table td small { display:block; font-size:11px; color:var(--statistics-muted); margin-top:4px; font-variant-numeric:tabular-nums; }
.statistics-table td:first-child { overflow-wrap:anywhere; }
.statistics-table .statistics-number { text-align:right; font-variant-numeric:tabular-nums; }
.statistics-table tfoot th,.statistics-table tfoot td { border-top:1px solid var(--ink); border-bottom:0; font-weight:600; color:var(--ink); }
.statistics-table .statistics-search-empty td { text-align:center; padding:32px; color:var(--statistics-muted); }
.statistics-method { margin-top:24px; padding-top:16px; border-top:1px solid var(--line); font-size:12px; color:var(--statistics-muted); line-height:1.8; }
.statistics-method summary { cursor:pointer; width:fit-content; color:var(--ink); }
.statistics-method ul { margin:10px 0 0; padding-left:18px; max-width:90ch; }
.statistics-page [hidden] { display:none !important; }
</style>
<main class="statistics-page">
 <div class="statistics-content">
  <header class="statistics-heading">
   <div><h1>今日统计</h1><p class="statistics-date">${esc(stats.day)} · 北京时间 00:00 至今</p></div>
   <div class="statistics-refresh"><span>更新于 <time datetime="${esc(stats.generatedAt)}">${esc(updatedAt)}</time></span><a href="${filterUrl(stats.platform)}"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.5 7A7 7 0 1 0 17 12M16.5 7V2.5M16.5 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>刷新统计</a></div>
  </header>
  <nav class="statistics-filters" aria-label="统计平台">
   ${(['all', 'facebook', 'instagram'] as const).map(platform => `<a href="${filterUrl(platform)}"${stats.platform === platform ? ' aria-current="page"' : ''}>${platform === 'all' ? '全部平台' : platform === 'facebook' ? 'Facebook' : 'Instagram'}</a>`).join('')}
   <span>仅统计实际收到和成功处理的数据</span>
  </nav>
  <div class="statistics-overview">
   <section aria-labelledby="statistics-received-title">
    <div class="statistics-metric-heading"><h2 id="statistics-received-title">今日收到</h2></div>
    <strong class="statistics-value">${number(stats.received.total)}<small>条消息</small></strong>
    <div class="statistics-breakdown"><span>私信<strong>${number(stats.received.messages)}</strong></span><span>帖子评论<strong>${number(stats.received.comments)}</strong></span></div>
    <p class="statistics-metric-note">客户通过 Webhook 进入的新消息，重复推送只计一次。</p>
   </section>
   <section aria-labelledby="statistics-rule-title">
    <div class="statistics-metric-heading"><h2 id="statistics-rule-title">规则处理</h2>${stats.rule.automationEnabled ? '' : '<span class="statistics-state">自动执行未开启</span>'}</div>
    <div class="statistics-rule-values"><strong class="statistics-value">${number(stats.rule.processed)}<small>条已处理</small></strong><strong class="statistics-value">${number(stats.rule.hidden)}<small>条已隐藏</small></strong></div>
    <p class="statistics-metric-note">仅统计今日新消息的实际执行结果，规则试跑不计入。</p>
   </section>
   <section aria-labelledby="statistics-manual-title">
    <div class="statistics-metric-heading"><h2 id="statistics-manual-title">人工处理</h2></div>
    <strong class="statistics-value">${number(stats.manual.processed)}<small>条消息 · 去重</small></strong>
    <div class="statistics-breakdown"><span>回复<strong>${number(stats.manual.replies)}</strong></span><span>隐藏<strong>${number(stats.manual.hidden)}</strong></span><span>取消隐藏<strong>${number(stats.manual.restored)}</strong></span><span>无需处理<strong>${number(stats.manual.noAction ?? 0)}</strong></span><span>删除<strong>${number(stats.manual.deleted ?? 0)}</strong></span><span title="点赞、取消点赞、屏蔽与解除屏蔽">其他操作<strong>${number(stats.manual.otherActions ?? 0)}</strong></span></div>
    <p class="statistics-metric-note">细分为成功操作次数；同一条消息可有多次操作。</p>
   </section>
  </div>
  <div class="statistics-visuals">
   <section aria-labelledby="statistics-composition-title">
    <div class="statistics-section-heading"><h2 id="statistics-composition-title">消息构成</h2><p>${esc(platformName)}</p></div>
    <div class="statistics-composition">
     <div class="statistics-donut" role="img" aria-label="今日帖子评论 ${number(stats.received.comments)} 条，私信 ${number(stats.received.messages)} 条" style="background:${stats.received.total ? `conic-gradient(var(--ink) 0 ${commentShare.toFixed(4)}%,var(--signal) ${commentShare.toFixed(4)}% 100%)` : '#e0ddd3'}">
      <div class="statistics-donut-center" aria-hidden="true"><strong>${number(stats.received.total)}</strong><span>${stats.received.total ? '条入站消息' : '暂无入站消息'}</span></div>
     </div>
     <div class="statistics-legend">
      <div class="statistics-legend-row"><span class="statistics-swatch comments" aria-hidden="true"></span><span>帖子评论</span><strong>${number(stats.received.comments)}</strong><small>${percent(stats.received.comments, stats.received.total)}${stats.received.total ? ' · 占今日消息' : ''}</small></div>
      <div class="statistics-legend-row"><span class="statistics-swatch messages" aria-hidden="true"></span><span>私信</span><strong>${number(stats.received.messages)}</strong><small>${percent(stats.received.messages, stats.received.total)}${stats.received.total ? ' · 占今日消息' : ''}</small></div>
     </div>
    </div>
   </section>
   <section aria-labelledby="statistics-ranking-title">
    <div class="statistics-section-heading"><h2 id="statistics-ranking-title">消息来自哪里</h2><p>${number(pages.length)} 个主页 / 账号有消息</p></div>
    ${sources.length ? `<ol class="statistics-ranking">${sources.map(source => `<li><span class="statistics-ranking-name" title="${esc(`${source.name}${source.platform ? ` · ${source.platform}` : ''}`)}">${esc(source.name)}${source.platform ? `<small>${source.platform}</small>` : ''}</span><span class="statistics-bar" aria-hidden="true"><span style="width:${stats.received.total ? (source.total / stats.received.total * 100).toFixed(4) : '0'}%"></span></span><strong>${number(source.total)}</strong><span class="statistics-ranking-percentage">${percent(source.total, stats.received.total)}</span></li>`).join('')}</ol>` : '<div class="statistics-empty"><strong>今天还没有消息来源</strong><p>收到私信或帖子评论后，主页 / 账号及占比会显示在这里。</p></div>'}
   </section>
  </div>
  <section class="statistics-sources" aria-labelledby="statistics-sources-title">
   <div class="statistics-section-heading">
    <div><h2 id="statistics-sources-title">主页来源明细</h2><p style="margin-top:6px">只展示今天收到消息的主页 / 账号，按消息数量排序。</p></div>
    ${pages.length ? `<div class="statistics-source-tools"><span class="statistics-source-count" id="statistics-source-count" role="status">共 ${number(pages.length)} 个主页 / 账号</span><label><span class="sr">筛选主页名称或编号</span><input type="search" id="statistics-source-search" placeholder="筛选主页名称或编号" autocomplete="off"></label></div>` : ''}
   </div>
   ${pages.length ? `<table class="statistics-table"><thead><tr><th scope="col">主页 / 账号</th><th scope="col">平台</th><th scope="col" class="statistics-number">私信</th><th scope="col" class="statistics-number">帖子评论</th><th scope="col" class="statistics-number">合计</th><th scope="col" class="statistics-number">占今日消息</th></tr></thead><tbody>${sourceRows}<tr class="statistics-search-empty" id="statistics-source-empty" hidden><td colspan="6">没有匹配的主页或账号，换个名称或编号试试。</td></tr></tbody><tfoot><tr><th scope="row" colspan="2">${esc(platformName)}合计<span class="sr">，不随主页搜索改变</span></th><td class="statistics-number">${number(stats.received.messages)}</td><td class="statistics-number">${number(stats.received.comments)}</td><td class="statistics-number">${number(stats.received.total)}</td><td class="statistics-number">${stats.received.total ? '100%' : '—'}</td></tr></tfoot></table>` : '<div class="statistics-empty"><strong>暂无可展示的主页</strong><p>这里展示实际有消息进入的来源，无消息的主页不会列出。</p></div>'}
  </section>
  <details class="statistics-method"><summary>统计口径</summary><ul>
   <li>“今日”按北京时间计算。今日收到按首次通过 Webhook 收到的时间统计客户私信和帖子评论；重复 Webhook、我方发送消息和 API 拉取的历史评论不计入。</li>
   <li>规则处理统计今日新入站消息的实际处理结果。仅计入已启用规则的实际处理；试跑、历史补录和平台已隐藏的评论不计为规则隐藏。</li>
   <li>人工处理按今天成功回复、隐藏、取消隐藏或标记无需处理的目标消息去重，可包含以前收到的消息。操作细分按次数统计，因此不一定等于处理消息数。</li>
   <li>主页来源及占比对应当前所选平台的全部入站消息。搜索只筛选明细行，不改变上方数字、图表和合计。</li>
  </ul></details>
 </div>
</main>
<script nonce="${esc(input.nonce)}">
(() => {
  const search = document.getElementById('statistics-source-search');
  if (!search) return;
  const rows = Array.from(document.querySelectorAll('[data-statistics-source]'));
  const count = document.getElementById('statistics-source-count');
  const empty = document.getElementById('statistics-source-empty');
  search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of rows) {
      const matches = row.dataset.search.includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    }
    count.textContent = query ? '显示 ' + visible + ' / ' + rows.length + ' 个主页 / 账号' : '共 ' + rows.length + ' 个主页 / 账号';
    empty.hidden = visible !== 0;
  });
})();
</script>` });
}
