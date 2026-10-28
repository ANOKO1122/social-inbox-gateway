import type { Staff, KnownPage } from './staff-repository.js';
import type { Rule } from './rule-store.js';
import { adminTabs, shell } from './workbench-page.js';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export function renderRulesPage(input: { staff: Staff; nonce: string; rules: Rule[]; pages: KnownPage[]; aiReady: boolean }): string {
  return shell({ title: '评论规则', nonce: input.nonce, staff: input.staff, section: 'admin', body: `
<style>
.rules-page { width:min(1600px,calc(100% - 64px)); margin:28px auto; overflow:auto; }
.rules-heading { display:flex; justify-content:space-between; align-items:center; gap:24px; }
.rules-heading h1 { margin:0; font-size:28px; }.rules-heading p { color:var(--quiet); margin:8px 0 20px; }
.rules-scope { padding:12px 16px; background:var(--sheet); border:1px solid var(--line); font-size:13px; line-height:1.6; margin-bottom:24px; }
.rules-tools { display:flex; gap:12px; align-items:center; margin-bottom:16px; }.rules-tools input { margin-left:auto; width:240px; }
.rules-page input:not([type=checkbox]):not([type=radio]),.rules-page select,.rules-page textarea,.rule-dialog input:not([type=checkbox]):not([type=radio]),.rule-dialog select,.rule-dialog textarea { border:1px solid var(--line); background:var(--sheet); color:var(--ink); padding:10px 12px; border-radius:5px; font:inherit; min-width:0; }
.rules-table { width:100%; table-layout:fixed; border-collapse:collapse; }.rules-table th { text-align:left; color:var(--quiet); font-size:12px; padding:12px; border-bottom:1px solid var(--line); }
.rules-table td { padding:16px 12px; vertical-align:top; border-bottom:1px solid var(--line); font-size:14px; overflow-wrap:anywhere; }.rules-table th:first-child { width:21%; }.rules-table th:nth-child(2) { width:23%; }.rules-table th:nth-child(3) { width:12%; }.rules-table th:last-child { width:218px; }
.rule-sub { display:block; color:var(--quiet); font-size:12px; line-height:1.6; margin-top:5px; }.rules-table th:nth-child(5) { width:146px; }
.rule-row-actions { display:flex; align-items:center; gap:8px; }.rule-row-action { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; min-height:36px; padding:0 11px; border:1px solid var(--line); border-radius:4px; background:var(--sheet); color:var(--ink); font-size:13px; line-height:1.2; text-decoration:none; white-space:nowrap; }.rule-row-action:hover { border-color:var(--ink); background:var(--paper); }.rule-row-action:focus-visible { outline:2px solid var(--ink); outline-offset:3px; background:var(--signal); }
.rule-toggle-row { display:flex; align-items:center; gap:8px; white-space:nowrap; }.rule-toggle { display:inline-flex; align-items:center; flex-shrink:0; width:36px; height:21px; padding:2px; border:1px solid var(--line); border-radius:20px; background:#deddd5; }.rule-toggle:before { content:''; width:15px; height:15px; border-radius:50%; background:var(--sheet); box-shadow:0 1px 2px #0002; }.rule-toggle[aria-checked=true] { background:var(--ink); border-color:var(--ink); justify-content:flex-end; }.rule-toggle[aria-checked=true]:before { background:var(--signal); }.rule-toggle:focus-visible { outline:2px solid var(--ink); outline-offset:3px; }.rule-toggle:disabled { opacity:.5; cursor:not-allowed; }.rule-toggle[aria-busy=true] { cursor:wait; }.rule-toggle-label { font-size:13px; }
.rules-empty { padding:64px 24px; text-align:center; border-bottom:1px solid var(--line); }.rules-empty h2 { font-size:20px; margin:0 0 8px; }.rules-empty p { color:var(--quiet); }.rules-empty button { margin:12px 4px 0; }
.rule-dialog { width:min(1800px,calc(100vw - 40px)); max-width:none; height:min(980px,calc(100vh - 40px)); max-height:none; padding:0; background:var(--paper); color:var(--ink); border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 48px #0003; }.rule-dialog::backdrop { background:#0006; }
.rule-dialog > form { display:flex; flex-direction:column; height:100%; min-height:0; }
.rule-dialog-head,.rule-footer { flex-shrink:0; }
.rule-dialog-head { display:flex; align-items:center; justify-content:space-between; padding:18px 24px; border-bottom:1px solid var(--line); }.rule-dialog-head h2 { font-size:20px; margin:0; }.rule-dialog-head p { margin:4px 0 0; color:var(--quiet); font-size:12px; }
.rule-editor-layout { display:grid; flex:1; min-height:0; grid-template-columns:250px minmax(430px,1.18fr) minmax(360px,1fr); overflow:hidden; }
.rule-scope-panel { display:flex; flex-direction:column; min-height:0; padding:22px 18px; border-right:1px solid var(--line); }
.rule-fields { padding:22px 24px; border-right:1px solid var(--line); overflow:auto; }.rule-trial { padding:22px 24px; background:var(--sheet); overflow:auto; }
.rule-scope-panel h3,.rule-fields h3,.rule-trial h3 { margin:0 0 8px; font-size:17px; }.rule-help { font-size:12px; line-height:1.65; color:var(--quiet); margin:0 0 18px; }
.rule-trial textarea { width:100%; min-height:130px; resize:vertical; }.rule-section + .rule-section { padding-top:20px; border-top:1px solid var(--line); margin-top:22px; }
.rule-guide { padding:12px 14px; margin:0 0 20px; background:var(--sheet); border:1px solid var(--line); font-size:12px; line-height:1.7; }
.rule-scope-options { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:14px; }.rule-scope-options label { display:flex; align-items:center; gap:6px; font-size:13px; }.rule-scope-options input { width:15px; height:15px; accent-color:var(--ink); }
.rule-scope-tools { display:flex; gap:12px; align-items:center; font-size:12px; margin-bottom:8px; }.rule-scope-tools button { border:0; background:none; padding:4px 0; text-decoration:underline; }.rule-scope-tools span { margin-left:auto; color:var(--quiet); }
.rule-page-search { width:100%; margin:0 0 10px; }.rule-scope-summary { margin:12px 0 0; font-size:12px; line-height:1.6; color:var(--quiet); }
.rule-random-tools { display:flex; gap:10px; align-items:center; margin:16px 0 10px; }.rule-random-tools button { flex:1; border:1px solid var(--line); background:var(--paper); padding:10px 14px; }.rule-sample-note { font-size:12px; color:var(--quiet); line-height:1.6; margin:0 0 12px; }
.rule-sample-meta { border-bottom:1px solid var(--line); padding:8px 0 12px; font-size:12px; line-height:1.6; margin-bottom:16px; }.rule-sample-meta a { display:inline-block; margin:6px 14px 0 0; }.rule-sample-meta span { display:block; }
.rule-ai-outcomes { padding:12px; border:1px solid var(--line); font-size:13px; line-height:1.8; margin-bottom:18px; }.rule-ai-outcomes strong { display:block; }.rule-action-options { display:flex; flex-wrap:wrap; gap:16px; margin:10px 0 8px; }.rule-action-options label { display:flex; align-items:center; gap:6px; }.rule-action-options input { width:16px; height:16px; accent-color:var(--ink); }
.rule-condition-group { min-width:0; margin:0; padding:12px; border:1px solid var(--line); border-radius:5px; background:var(--sheet); }
.rule-condition-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; font-size:13px; }.rule-condition-head strong { font-size:13px; }.rule-condition-head button,.rule-term-remove { border:0; background:none; color:var(--quiet); padding:4px; font-size:12px; }
.rule-condition-head button:hover,.rule-term-remove:hover { color:var(--ink); text-decoration:underline; }
.rule-condition-term { display:flex; gap:8px; align-items:center; margin:7px 0; }.rule-condition-term input { flex:1; width:0; font-size:13px !important; }.rule-term-operator { width:28px; flex-shrink:0; font-size:12px; color:var(--quiet); }.rule-term-remove { flex-shrink:0; }
.rule-condition-add { border:0; background:none; padding:6px 0 0 36px; text-decoration:underline; font-size:12px; }.rule-condition-or { display:flex; gap:10px; align-items:center; margin:10px 0; font-size:12px; color:var(--quiet); }.rule-condition-or:before,.rule-condition-or:after { content:''; height:1px; background:var(--line); flex:1; }
.rule-group-add { width:100%; margin:12px 0; border:1px dashed var(--line); background:transparent; padding:10px; border-radius:5px; font-size:13px; }.rule-expression { font-size:12px; line-height:1.7; padding:10px 12px; background:var(--sheet); border:1px solid var(--line); margin:0 0 18px; overflow-wrap:anywhere; }.rule-expression strong { display:block; margin-bottom:3px; }
.rule-result { border-top:3px solid var(--signal); }
.rule-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }.rule-field { display:flex; flex-direction:column; gap:7px; font-size:13px; margin-bottom:18px; }.rule-field input,.rule-field select { width:100%; }.rule-field textarea { min-height:82px; resize:vertical; }.rule-field small { font-size:12px; color:var(--quiet); line-height:1.5; }
.rule-check { display:flex; align-items:center; gap:8px; font-size:13px; margin:0 0 18px; }.rule-check input { accent-color:var(--ink); width:16px; height:16px; }
.rule-page-list { flex:1; min-height:120px; overflow:auto; padding:3px; border:1px solid var(--line); background:var(--sheet); }.rule-page-list label { display:flex; align-items:flex-start; gap:8px; padding:9px 6px; font-size:12px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }.rule-page-list input { width:15px; height:15px; flex-shrink:0; margin-top:3px; }.rule-page-list small { display:block; font-size:10px; color:var(--quiet); margin-top:2px; }.rule-page-list label:has(input:checked) { background:#f2efcd; }
.rule-detail summary { cursor:pointer; font-size:13px; margin-bottom:12px; }.rule-footer { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 24px; border-top:1px solid var(--line); }.rule-footer p { margin:0; font-size:13px; color:var(--quiet); }.rule-result { margin-top:18px; padding:16px; border:1px solid var(--line); font-size:13px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }.rule-result:empty { display:none; }.rule-trial-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }.rule-error { color:#a32924; font-size:13px; }.rule-delete { margin-right:auto; }.rule-reply-boundary { font-size:12px; line-height:1.7; color:var(--quiet); padding:12px; border:1px solid var(--line); }
.rule-dialog button:disabled { opacity:.55; cursor:wait; }.rules-page button,.rule-dialog button { cursor:pointer; }.rule-dialog [hidden],.rules-page [hidden] { display:none !important; }
</style>
<main class="rules-page">
  ${adminTabs('rules')}
  <header class="rules-heading"><div><h1>评论规则</h1><p>明确短句直接判断，其余评论可转人工，或按需开启 AI。</p></div><button class="primary" id="rule-new">新建规则</button></header>
  <p class="rules-scope">打开规则开关后，自动处理启用后新收到的 Webhook 评论；历史、外部补录和 API 回拉的评论不触发。试跑始终只预览，不会隐藏评论或创建人工待办。</p>
  <div class="rules-tools"><button class="chip" data-category="all" aria-pressed="true">全部</button><button class="chip" data-category="moderation" aria-pressed="false">评论审核</button><button class="chip" data-category="reply" aria-pressed="false">AI 回复</button><input type="search" id="rule-search" placeholder="搜索规则或关键词" aria-label="搜索规则或关键词"></div>
  <p id="rules-notice" role="status"></p>
  <table class="rules-table"><thead><tr><th>规则 / 用途</th><th>触发条件</th><th>适用范围</th><th>执行动作</th><th>自动处理</th><th>操作</th></tr></thead><tbody id="rules-body"></tbody></table>
  <div class="rules-empty" id="rules-empty"><h2>从一条规则开始</h2><p>先配置触发条件，再用真实评论试跑，检查误判。</p><button class="ghost" data-template="moderation">创建审核规则</button><button class="ghost" data-template="reply">创建尺码问询规则</button></div>
</main>
<dialog class="rule-dialog" id="rule-dialog" aria-labelledby="rule-dialog-title">
 <form id="rule-form">
  <header class="rule-dialog-head"><div><h2 id="rule-dialog-title">新建规则</h2><p>配置 → 抽取真实评论 → 试跑验证。自动处理由列表中的开关控制。</p></div><button type="button" class="ghost" id="rule-close" aria-label="关闭规则编辑">关闭</button></header>
  <div class="rule-editor-layout">
  <aside class="rule-scope-panel">
   <h3>适用主页</h3><p class="rule-help">规则和随机抽样都使用这里的范围。</p>
   <label class="rule-field">平台<select name="platform"><option value="all">Facebook 与 Instagram</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select></label>
   <div class="rule-scope-options" role="group" aria-label="主页范围"><label><input type="radio" name="scopeMode" value="all" checked>全部主页</label><label><input type="radio" name="scopeMode" value="selected">指定主页</label></div>
   <input class="rule-page-search" id="rule-page-search" type="search" placeholder="搜索主页名称或编号" aria-label="搜索主页名称或编号">
   <div class="rule-scope-tools"><button type="button" id="scope-select">选中搜索结果</button><button type="button" id="scope-clear">清空</button><span id="scope-count"></span></div>
   <div class="rule-page-list">${input.pages.map(p=>`<label data-scope-page="${esc(p.pageId)}"><input type="checkbox" name="channelIds" value="${esc(p.pageId)}"><span>${esc(p.name)}<small>${esc(p.pageId)}</small></span></label>`).join('')}</div>
   <p class="rule-scope-summary" id="scope-summary" role="status"></p>
  </aside>
  <div class="rule-fields">
   <h3>规则配置</h3><p class="rule-help">先配置确定短句，再配置需要复核的关键词；不开启 AI 也能使用。</p>
   <p class="rule-guide"><strong>判断顺序</strong>：主页范围 → 排除词 → 确定短句直接处理 → 其余内容检查关键词，再按需调用 AI。<br>排除词优先；命中后直接跳过本规则，不调用 AI。</p>
   <section class="rule-section">
   <div class="rule-grid"><label class="rule-field">规则名称<input name="name" required maxlength="80" placeholder="例如：诈骗指控语义复核"></label><label class="rule-field">你想处理什么？<select name="category"><option value="moderation">审核不当评论</option><option value="reply">识别需要 AI 回复的问题</option></select></label></div>
   <details class="rule-detail" id="rule-direct-field"><summary>确定短句：跳过 AI 直接处理（可选）</summary>
    <label class="rule-field">整条评论等于以下任意短句时<textarea name="directPhrases" rows="5" placeholder="每行一条完整短句，例如：&#10;scam&#10;scammers&#10;ai trash"></textarea><small>仅忽略大小写、全角差异和多余空白，标点必须一致。填 scam 不会命中 scam?、not a scam 或包含订单问题的长句。最多 100 条。</small></label>
    <label class="rule-field">确定短句命中时<select name="directAction"><option value="hide">隐藏评论</option><option value="review">转人工处理</option></select></label>
    <p class="rule-help"><span id="rule-direct-summary">命中后采用下方的直接处理动作，不调用 AI。</span>未命中则继续检查关键词条件。</p>
   </details>
   <h3>触发条件</h3>
   <p class="rule-help">同一组内的词<strong>全部出现（且 / AND）</strong>，这一组才算满足。<br>满足<strong>任意一组（或 / OR）</strong>，就触发这条规则。</p>
   <div id="rule-condition-groups" aria-label="关键词条件组"></div>
   <button type="button" class="rule-group-add" id="rule-group-add">＋ 或者，添加另一组条件</button>
   <div class="rule-expression"><strong>当前触发条件</strong><span id="rule-expression"></span></div>
   <details class="rule-detail"><summary>如何设置组合条件？</summary><p class="rule-help">（a 且 b）或 c：第 1 组填 a、b；第 2 组只填 c。<br>（a 且 b）或（c 且 d）：第 1 组填 a、b；第 2 组填 c、d。<br>一个输入框填一个词或完整词组，不需要手写 AND、OR 或括号。忽略大小写和全角差异，不自动扩展同义词。最多 100 个条件。</p></details>
   <label class="rule-check"><input type="checkbox" name="wordBoundary">按完整英文词匹配</label><p class="rule-help">开启后，scam 不会命中 scamper；也适用于排除词。中文关键词通常保持关闭。</p>
   <label class="rule-field">哪些内容直接跳过？<textarea name="exclusions" placeholder="可选，每行一个词组，例如：&#10;not a scam"></textarea><small>这里填写确定不用处理的例外。含义仍有歧义的内容，可留给下方 AI 判断。</small></label>
   </section>
   <section class="rule-section">
   <h3>执行动作</h3><p class="rule-help">启用后，新评论按这里的动作处理；右侧试跑只展示结果。</p>
   <label class="rule-check"><input type="checkbox" name="aiEnabled">交给 AI 复核语义</label>
   <p class="rule-help" id="ai-mode-help">适合含否定、引用、讽刺或多个关键词的评论。未开启时，按下方选择的动作处理。</p>
   <div class="rule-ai-outcomes" id="rule-ai-outcomes" hidden><strong>允许 AI 选择的动作</strong><div class="rule-action-options"><label><input type="checkbox" data-ai-action="hide" checked>隐藏评论</label><label><input type="checkbox" data-ai-action="keep" checked>保留评论</label><label><input type="checkbox" data-ai-action="review" checked disabled>转人工处理</label></div><span class="rule-help">取消勾选的动作不会被采用。转人工始终保留，用于判断不清、请求失败或结果超出许可。</span></div>
   <label class="rule-field" id="rule-ai-field">本规则的 AI 判断标准<textarea name="aiInstruction" maxlength="4000" placeholder="例如：直接针对他人的辱骂建议隐藏；引用别人的话、否定辱骂或表达正常投诉则保留；不能确定时转人工。"></textarea><small>AI 主要按这里的标准判断。写清哪些情况隐藏、哪些保留、哪些转人工；不同规则可使用不同标准，无需去 Dify 修改提示词。</small></label>
   <label class="rule-field" id="keyword-action-field"><span id="keyword-action-label">条件满足后</span><select name="action"><option value="review">转人工处理</option><option value="hide">隐藏评论</option><option value="reply">生成 AI 回复候选</option></select><small>试跑只展示这项动作，不会隐藏评论或创建人工待办。</small></label>
   <p class="rule-reply-boundary" id="rule-reply-boundary" hidden>只回答评论明确提出的问题，不追问、不延伸推销。当前尚未接入产品知识库，回复试跑会提示交人工；配置可先保存。</p>
   </section>
   <details class="rule-detail rule-section"><summary>管理设置（标记和排序）</summary>
    <div class="rule-grid"><label class="rule-field">配置标记<select name="status"><option value="disabled">草稿</option><option value="observe">待验证</option></select><small>仅供整理；自动处理由列表开关控制。</small></label><label class="rule-field">列表排序<input type="number" name="priority" value="100" min="1" max="1000"><small>数字小的排在前面。</small></label></div>
   </details>
  </div>
  <aside class="rule-trial">
   <h3>用真实评论试跑</h3><p class="rule-help">可先抽样再配置规则，也可以手动输入评论。</p>
   <div class="rule-random-tools"><button type="button" class="ghost" id="trial-random">随机抽取一条评论</button></div>
   <p class="rule-sample-note" id="sample-note" role="status">从左侧范围内已入库的帖子评论抽取；不会自动调用 AI。</p>
   <div class="rule-sample-meta" id="sample-meta" hidden><span id="sample-origin"></span><span id="sample-time"></span><a id="sample-inbox" hidden target="_blank" rel="noopener noreferrer">收件箱定位</a><a id="sample-source" hidden target="_blank" rel="noopener noreferrer">打开源评论 / 帖子</a></div>
   <div class="rule-grid"><label class="rule-field">评论所在平台<select id="trial-platform"><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select></label><label class="rule-field">评论所在主页<select id="trial-channel"><option value="">不指定主页</option>${input.pages.map(p=>`<option value="${esc(p.pageId)}">${esc(p.name)}</option>`).join('')}</select></label></div>
   <label class="rule-field">测试评论<textarea id="trial-text" maxlength="4000" placeholder="抽取评论会自动填入；也可以粘贴你想检查的内容。"></textarea></label>
   <details class="rule-detail" id="trial-context-details"><summary>帖子背景（抽样时自动带入已存内容）</summary><label class="rule-field"><span class="sr">帖子背景</span><textarea id="trial-context" maxlength="2000" placeholder="数据库没有帖子正文时可手动补充。"></textarea></label></details>
   <div class="rule-trial-actions"><button type="button" class="ghost" id="trial-keywords">检查触发条件</button><button type="button" class="primary" id="trial-ai" ${input.aiReady?'':'disabled'}>检查并让 AI 判断</button></div>
   <p class="rule-help" id="trial-ai-hint"></p>
   <div class="rule-result" id="rule-result" role="status" aria-live="polite"></div>
  </aside></div>
  <footer class="rule-footer"><button type="button" class="ghost rule-delete" id="rule-delete" hidden>删除规则</button><p id="rule-save-note" role="status">新规则默认停用；保存后可在列表开启。</p><button type="submit" class="primary" id="rule-save">保存规则</button></footer>
 </form>
</dialog>
<script nonce="${input.nonce}">
(() => {
 let rules = ${json(input.rules)}; const aiReady = ${input.aiReady}; const pages = ${json(input.pages)};
 const dialog = document.getElementById('rule-dialog'), form = document.getElementById('rule-form'), result = document.getElementById('rule-result');
 let editingId, category='all', busy=false, seenSamples=[], sampled=false;const toggling=new Set();
 const pagePlatform = p => p?.platform || (p?.name?.startsWith('Instagram') ? 'instagram' : 'facebook');
 const field = name => form.elements.namedItem(name);
 const labelAction = action => ({hide:'隐藏评论',review:'转人工处理',reply:'AI 回复候选',skip:'跳过',ai:'交 AI 复核',keep:'保留'})[action] || action;
 function textNode(tag,text,className) { const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el; }
 function render() {
  const body=document.getElementById('rules-body');body.replaceChildren();const q=document.getElementById('rule-search').value.toLowerCase();
  const visible=rules.filter(r=>(category==='all'||r.category===category)&&(r.name+' '+r.keywords.join(' ')+' '+(r.directPhrases||[]).join(' ')).toLowerCase().includes(q));
  for(const r of visible){const tr=document.createElement('tr');const name=document.createElement('td');name.append(textNode('strong',r.name),textNode('span',r.category==='reply'?'AI 回复 · 排序 '+r.priority:'评论审核 · 排序 '+r.priority,'rule-sub'));tr.append(name);
   const groups=groupsFor(r),conditions=document.createElement('td');conditions.append(textNode('span',expression(groups.slice(0,3))+(groups.length>3?' …':'')),textNode('span',(r.directPhrases?.length?r.directPhrases.length+' 条确定短句 · ':'')+groups.length+' 个关键词条件组'+(r.exclusions.length?' · '+r.exclusions.length+' 个排除词':''),'rule-sub'));tr.append(conditions);
   const scope=document.createElement('td');scope.append(textNode('span',r.platform==='all'?'全部平台':r.platform==='facebook'?'Facebook':'Instagram'),textNode('span',r.channelIds.length?r.channelIds.length+' 个指定主页':'全部主页','rule-sub'));tr.append(scope);
   const action=document.createElement('td');const secondary=r.aiEnabled?(r.category==='reply'?'AI 回复意图':'交 AI 复核'):labelAction(r.action);action.append(textNode('span',r.directPhrases?.length?'短句'+labelAction(r.directAction||'hide')+'，其余'+secondary:secondary),textNode('span',r.aiEnabled?(r.allowedActions||['hide','keep','review']).map(labelAction).join(' / '):'AI 已关闭 · 不调用模型','rule-sub'));tr.append(action);
   const state=document.createElement('td'),toggleRow=document.createElement('div');toggleRow.className='rule-toggle-row';const toggle=document.createElement('button');toggle.type='button';toggle.className='rule-toggle';toggle.dataset.ruleToggle=r.id;toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(!!r.enabled));toggle.setAttribute('aria-label',r.name+'自动处理');toggle.disabled=r.category==='reply'||toggling.has(r.id);if(toggling.has(r.id))toggle.setAttribute('aria-busy','true');toggle.addEventListener('click',()=>toggleRule(r,toggle));toggleRow.append(toggle,textNode('span',toggling.has(r.id)?'正在更新…':r.enabled?'运行中':'已停用','rule-toggle-label'));state.append(toggleRow,textNode('span',r.category==='reply'?'暂不支持自动发送':'配置标记：'+(r.status==='observe'?'待验证':'草稿'),'rule-sub'));tr.append(state);
   const tools=document.createElement('td'),actions=document.createElement('div');actions.className='rule-row-actions';const edit=textNode('button','编辑 / 试跑','rule-row-action');edit.type='button';edit.setAttribute('aria-label','编辑或试跑规则：'+r.name);edit.addEventListener('click',()=>open(r));const logs=textNode('a','处理日志','rule-row-action');logs.href='/inbox/admin/rules/'+encodeURIComponent(r.id)+'/logs';logs.setAttribute('aria-label','查看处理日志：'+r.name);actions.append(edit,logs);tools.append(actions);tr.append(tools);body.append(tr);
  }
  const empty=document.getElementById('rules-empty');empty.hidden=visible.length>0;empty.querySelector('h2').textContent=rules.length?'没有符合条件的规则':'从一条规则开始';
 }
 async function toggleRule(rule,button){
  if(toggling.has(rule.id)||rule.category==='reply')return;const enabled=!rule.enabled,notice=document.getElementById('rules-notice');toggling.add(rule.id);button.disabled=true;button.setAttribute('aria-busy','true');button.nextElementSibling.textContent='正在更新…';notice.textContent='';
  try{const j=await request('toggle',{id:rule.id,enabled});const index=rules.findIndex(r=>r.id===j.rule.id);if(index>=0)rules[index]=j.rule;notice.textContent=j.rule.enabled?'「'+j.rule.name+'」已启用，只处理启用后新收到的评论。':'「'+j.rule.name+'」已停用，已有处理结果保留。';}
  catch(e){notice.textContent='更新失败：'+e.message+' 原开关状态未改变。';}
  finally{toggling.delete(rule.id);const restoreFocus=document.activeElement===button||document.activeElement===document.body;render();if(restoreFocus)document.querySelector('[data-rule-toggle="'+rule.id+'"]')?.focus();}
 }
 function sync() {
  const reply=field('category').value==='reply';
  field('category').querySelector('option[value=reply]').disabled=!!rules.find(r=>r.id===editingId)?.enabled;
  for(const option of field('action').options){option.hidden=reply?option.value!=='reply':option.value==='reply';option.disabled=option.hidden;}
  if(reply){field('action').value='reply';field('aiEnabled').checked=true;}else if(field('action').value==='reply')field('action').value='review';
  const ai=field('aiEnabled').checked,direct=!reply&&field('directPhrases').value.trim().length>0;
  document.getElementById('rule-direct-field').hidden=reply;field('directPhrases').disabled=busy||reply;field('directAction').disabled=busy||reply;document.getElementById('keyword-action-label').textContent=direct?'其余评论命中关键词时':'条件满足后';
  field('aiEnabled').disabled=busy||reply;document.getElementById('rule-ai-field').hidden=!ai;
  document.getElementById('rule-ai-outcomes').hidden=!ai||reply;document.getElementById('keyword-action-field').hidden=reply||ai;field('aiInstruction').required=ai&&!reply;const reviewAction=form.querySelector('[data-ai-action=review]');reviewAction.checked=true;reviewAction.disabled=true;
  document.getElementById('rule-reply-boundary').hidden=!reply;document.getElementById('rule-direct-summary').textContent='命中后：'+labelAction(field('directAction').value)+'，不调用 AI。';
  document.getElementById('ai-mode-help').textContent=reply?'回复类规则需要 AI 识别问题；缺少知识依据时交人工。':ai?'未命中确定短句，但满足关键词条件时，才交给 AI。适合否定、引用、讽刺或混合表达。':'AI 已关闭。命中关键词后按下方动作处理；不确定的内容建议先转人工。';
  document.getElementById('trial-ai').disabled=busy||(ai&&!aiReady);
  document.getElementById('trial-ai-hint').textContent=!ai?'AI 已关闭；完整试跑只按规则判断，不调用模型。':!aiReady?'AI 判断接口尚未配置。':reply?'当前没有产品知识库，回复试跑会提示交人工。':'确定短句直接给结论；其余评论命中关键词后才调用 AI。试跑不会隐藏或发送。';
  document.getElementById('trial-ai').textContent='完整试跑';
  updateConditionControls();
  updateScope();
 }
 function groupsFor(rule){return rule.keywordGroups?.length?rule.keywordGroups:(rule.matchMode==='all'?[rule.keywords]:rule.keywords.map(word=>[word]));}
 function conditionGroups(){return [...document.querySelectorAll('.rule-condition-group')].map(group=>[...group.querySelectorAll('.condition-term')].map(input=>input.value.trim()));}
 function expression(groups){return groups.map(group=>{const words=group.map(word=>word?'「'+word+'」':'待填关键词');return words.length>1?'（'+words.join(' 且 ')+'）':words[0];}).join(' 或 ');}
 function updateConditionControls(){
  const groups=[...document.querySelectorAll('.rule-condition-group')],total=groups.reduce((n,g)=>n+g.querySelectorAll('.condition-term').length,0);
  groups.forEach((group,i)=>{group.querySelector('strong').textContent='条件组 '+(i+1)+' · 全部满足';group.setAttribute('aria-label','条件组 '+(i+1));const remove=group.querySelector('[data-remove-group]');remove.disabled=busy||groups.length===1;remove.setAttribute('aria-label','删除条件组 '+(i+1));group.querySelector('[data-add-term]').disabled=busy||total>=100;const rows=[...group.querySelectorAll('.rule-condition-term')];rows.forEach((row,j)=>{row.querySelector('.rule-term-operator').textContent=j?'且':'包含';row.querySelector('input').setAttribute('aria-label','条件组 '+(i+1)+' 的关键词 '+(j+1));const del=row.querySelector('button');del.disabled=busy||rows.length===1;del.setAttribute('aria-label','移除条件组 '+(i+1)+' 的关键词 '+(j+1));});});
  document.getElementById('rule-group-add').disabled=busy||total>=100;document.getElementById('rule-expression').textContent=expression(conditionGroups());
 }
 function termRow(value){const row=document.createElement('div');row.className='rule-condition-term';const input=document.createElement('input');input.type='text';input.className='condition-term';input.value=value;input.required=true;input.maxLength=160;input.placeholder='输入关键词或完整词组';const remove=textNode('button','移除','rule-term-remove');remove.type='button';remove.dataset.removeTerm='';row.append(textNode('span','包含','rule-term-operator'),input,remove);return row;}
 function renderGroups(groups){
  const container=document.getElementById('rule-condition-groups');container.replaceChildren();for(const [index,terms] of groups.entries()){if(index)container.append(textNode('div','或者 · OR','rule-condition-or'));const group=document.createElement('div');group.className='rule-condition-group';group.setAttribute('role','group');const head=document.createElement('div');head.className='rule-condition-head';const remove=textNode('button','删除组');remove.type='button';remove.dataset.removeGroup='';head.append(textNode('strong',''),remove);group.append(head);const rows=document.createElement('div');rows.className='rule-condition-terms';for(const term of terms.length?terms:[''])rows.append(termRow(term));group.append(rows);const add=textNode('button','＋ 且，再满足一个关键词','rule-condition-add');add.type='button';add.dataset.addTerm='';group.append(add);container.append(group);}updateConditionControls();
 }
 document.getElementById('rule-condition-groups').addEventListener('input',()=>updateConditionControls());
 document.getElementById('rule-condition-groups').addEventListener('click',event=>{
  if(busy)return;const button=event.target.closest('button');if(!button)return;const group=button.closest('.rule-condition-group');if(button.hasAttribute('data-add-term')){const row=termRow('');group.querySelector('.rule-condition-terms').append(row);row.querySelector('input').focus();}else if(button.hasAttribute('data-remove-term')){const row=button.closest('.rule-condition-term'),focus=(row.previousElementSibling||row.nextElementSibling)?.querySelector('input');row.remove();focus?.focus();}else if(button.hasAttribute('data-remove-group')){const groups=conditionGroups(),index=[...group.parentElement.querySelectorAll('.rule-condition-group')].indexOf(group);groups.splice(index,1);renderGroups(groups);document.querySelectorAll('.rule-condition-group')[Math.min(index,groups.length-1)].querySelector('input').focus();}updateConditionControls();result.textContent='';
 });
 document.getElementById('rule-group-add').addEventListener('click',()=>{if(busy)return;renderGroups([...conditionGroups(),['']]);document.querySelector('.rule-condition-group:last-child input').focus();result.textContent='';});
 function selectedPages(){return [...form.querySelectorAll('[name="channelIds"]:checked')].map(c=>c.value);}
 function scopeIds(){return field('scopeMode').value==='all'?[]:selectedPages();}
 function scopeValid(){if(field('scopeMode').value==='selected'&&!selectedPages().length){document.getElementById('scope-summary').textContent='请至少选择一个主页，或改为「全部主页」。';return false;}return true;}
 function updateScope(){
  const platform=field('platform').value,query=document.getElementById('rule-page-search').value.trim().toLowerCase(),all=field('scopeMode').value==='all';let visible=0,eligible=0;
  for(const label of form.querySelectorAll('[data-scope-page]')){const c=label.querySelector('input'),p=pages.find(p=>p.pageId===c.value),allowed=platform==='all'||pagePlatform(p)===platform;if(!allowed)c.checked=false;if(allowed)eligible++;label.hidden=!allowed||!label.textContent.toLowerCase().includes(query);if(!label.hidden)visible++;c.disabled=busy||all||!allowed;c.hidden=all;}
  document.getElementById('scope-count').textContent=visible+' 个结果';document.getElementById('scope-summary').textContent=all?'当前平台的全部 '+eligible+' 个主页；以后新增主页也包含在内。':'已选择 '+selectedPages().length+' 个主页。清空后需重新选择，不会变成全部主页。';
  document.getElementById('scope-select').disabled=busy;document.getElementById('scope-clear').disabled=busy||all;
 }
 function syncTrialPages(){const platform=document.getElementById('trial-platform').value,select=document.getElementById('trial-channel');for(const option of select.options){if(!option.value)continue;const p=pages.find(p=>p.pageId===option.value);option.hidden=pagePlatform(p)!==platform;option.disabled=option.hidden;}if(select.selectedOptions[0]?.disabled)select.value='';}
 function clearSample(){sampled=false;document.getElementById('sample-meta').hidden=true;}
 function scopeChanged(){seenSamples=[];if(sampled){document.getElementById('trial-text').value='';document.getElementById('trial-context').value='';clearSample();}document.getElementById('sample-note').textContent='范围已更新。下一次抽取将使用新的平台和主页范围。';if(field('platform').value!=='all')document.getElementById('trial-platform').value=field('platform').value;syncTrialPages();updateScope();result.textContent='';}
 function open(rule, template) {
  form.reset();editingId=rule?.id;seenSamples=[];clearSample();document.getElementById('trial-random').textContent='随机抽取一条评论';document.getElementById('sample-note').textContent='从左侧范围内已入库的帖子评论抽取；不会自动调用 AI。';result.textContent='';document.getElementById('rule-save-note').textContent=rule?.enabled?'规则正在运行：保存后新配置用于后续评论，试跑不会实际操作。':editingId?'规则已停用；保存后保持停用，可在列表开启。':'新规则默认停用；保存后可在列表开启。';document.getElementById('rule-delete').hidden=!editingId;document.getElementById('rule-dialog-title').textContent=editingId?'编辑规则':'新建规则';
  const r=rule||{name:'',category:template||'moderation',platform:'all',matchMode:'any',keywords:[],exclusions:[],wordBoundary:false,aiEnabled:false,aiInstruction:'',action:'review',status:'disabled',priority:100,channelIds:[]};
  for(const key of ['name','category','platform','aiInstruction','action','status','priority'])field(key).value=r[key];
  field('directAction').value=r.directAction||'hide';field('directPhrases').value=(r.directPhrases||[]).join('\\n');document.getElementById('rule-direct-field').open=!!r.directPhrases?.length;field('exclusions').value=r.exclusions.join('\\n');const groups=groupsFor(r);renderGroups(groups.length?groups:[['']]);form.querySelectorAll('[data-ai-action]').forEach(c=>c.checked=(r.allowedActions||['hide','keep','review']).includes(c.dataset.aiAction));for(const key of ['wordBoundary','aiEnabled'])field(key).checked=r[key];form.querySelectorAll('[name="channelIds"]').forEach(c=>c.checked=r.channelIds.includes(c.value));
  if(!rule&&template==='reply'){field('name').value='尺码与版型问询';renderGroups([['size'],['sizing'],['fit'],['尺码'],['版型']]);field('aiInstruction').value='只回答明确提出的尺码、男女款或版型问题，依据知识库，不追问；缺少产品依据时交人工。';}
  field('scopeMode').value=r.channelIds.length?'selected':'all';if(r.platform!=='all')document.getElementById('trial-platform').value=r.platform;syncTrialPages();sync();dialog.showModal();field('name').focus();
 }
 function draft() {const split=name=>field(name).value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);return { ...(editingId?{id:editingId}:{}),name:field('name').value,category:field('category').value,platform:field('platform').value,keywordGroups:conditionGroups(),directPhrases:field('category').value==='moderation'?split('directPhrases'):[],directAction:field('directAction').value,exclusions:split('exclusions'),wordBoundary:field('wordBoundary').checked,aiEnabled:field('aiEnabled').checked,aiInstruction:field('aiInstruction').value,allowedActions:[...form.querySelectorAll('[data-ai-action]:checked')].map(c=>c.dataset.aiAction),action:field('action').value,status:field('status').value,priority:Number(field('priority').value),channelIds:scopeIds()};}
 async function request(path,body){const r=await fetch('/inbox/admin/rules/'+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.message||'请求失败，请重试。');return j;}
 function setBusy(value){busy=value;form.querySelectorAll('input,select,textarea').forEach(el=>el.disabled=value);for(const id of ['rule-save','rule-delete','trial-keywords','rule-close','trial-random'])document.getElementById(id).disabled=value;sync();}
 form.addEventListener('submit',async e=>{e.preventDefault();if(busy||!scopeValid())return;setBusy(true);try{const j=await request('save',{rule:draft()});const i=rules.findIndex(r=>r.id===j.rule.id);if(i>=0)rules[i]=j.rule;else rules.push(j.rule);rules.sort((a,b)=>a.priority-b.priority);render();dialog.close();document.getElementById('rules-notice').textContent=j.rule.enabled?'规则已保存，仍在运行；新配置用于后续评论。':'规则已保存，保持停用；可在列表打开自动处理开关。';}catch(e){document.getElementById('rule-save-note').textContent=e.message;}finally{setBusy(false);}});
 async function trial(ai){if(busy||!scopeValid())return;if(!form.reportValidity())return;const text=document.getElementById('trial-text').value.trim();if(!text){result.textContent='请先输入一条测试评论。';return;}setBusy(true);result.textContent=ai&&field('aiEnabled').checked?'正在试跑，必要时调用 AI…':'正在检查…';try{const j=await request('preview',{rule:draft(),text,platform:document.getElementById('trial-platform').value,channelId:document.getElementById('trial-channel').value,context:document.getElementById('trial-context').value,ai});const m=j.match;let output=m.reason+(m.groupResults?.length?'\\n\\n'+m.groupResults.filter(g=>g.matched||!m.matched).slice(0,5).map(g=>'条件组 '+g.index+'：'+(g.matched?'满足':'未满足')+'\\n  已包含：'+(g.matchedKeywords.join('、')||'无')+(g.missingKeywords.length?'\\n  还缺少：'+g.missingKeywords.join('、'):'')).join('\\n'):'')+'\\n\\n命中词：'+(m.matchedKeywords.join('、')||'无')+'\\n排除词：'+(m.excludedKeywords.join('、')||'无')+'\\n试跑动作：'+labelAction(m.next);if(j.ai)output+='\\n\\n'+(j.ai.reviewedBy==='system'?'处理结果：':'AI 建议：')+labelAction(j.ai.decision)+'\\n原因：'+j.ai.reason+(j.ai.reply?'\\n\\n候选回复：\\n'+j.ai.reply:'')+(j.ai.sources?.length?'\\n\\n知识依据：'+j.ai.sources.join('、'):'');if(j.message)output+='\\n\\n'+j.message;result.textContent=output+'\\n\\n试跑完成，未隐藏评论、未发送回复。';}catch(e){result.textContent=e.message;}finally{setBusy(false);}}
 for(const event of ['input','change']) form.addEventListener(event,()=>{if(!busy)result.textContent='';});
 async function randomSample(){
  if(busy||!scopeValid())return;setBusy(true);result.textContent='';document.getElementById('sample-note').textContent='正在从已存帖子评论中抽取…';
  try{const j=await request('sample',{platform:field('platform').value,channelIds:scopeIds(),excludeIds:seenSamples.slice(-200)});const sample=j.sample;
   if(!sample){clearSample();document.getElementById('trial-text').value='';document.getElementById('trial-context').value='';document.getElementById('sample-note').textContent='这个范围内暂时没有可用于试跑的文字评论。可调整主页范围，或手动输入。';return;}
   if(j.recycled)seenSamples=[];seenSamples.push(sample.id);sampled=true;
   document.getElementById('trial-platform').value=sample.platform;syncTrialPages();document.getElementById('trial-channel').value=sample.channelId;
   document.getElementById('trial-text').value=sample.text;document.getElementById('trial-context').value=sample.postText||'';
   document.getElementById('sample-meta').hidden=false;document.getElementById('sample-origin').textContent=(sample.platform==='instagram'?'Instagram':'Facebook')+' · '+sample.channelName;
   document.getElementById('sample-time').textContent=sample.occurredAt?'评论时间：'+new Date(sample.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':'';
   const inbox=document.getElementById('sample-inbox');inbox.hidden=!sample.eventId;if(sample.eventId)inbox.href='/inbox/workbench/'+sample.platform+'?event='+encodeURIComponent(sample.eventId);
   const source=document.getElementById('sample-source');source.hidden=!sample.sourceUrl;if(sample.sourceUrl)source.href=sample.sourceUrl;
   document.getElementById('trial-random').textContent='换一条评论';document.getElementById('sample-note').textContent=(j.recycled?'当前可用样本已轮换，开始新一轮。':'已抽取真实评论，继续点击可换一条。')+(sample.postText?'已带入帖子背景。':'未存有帖子正文，可手动补充。');
  }catch(e){document.getElementById('sample-note').textContent=e.message;}finally{setBusy(false);}
 }
 document.getElementById('trial-random').addEventListener('click',randomSample);
 field('platform').addEventListener('change',scopeChanged);form.querySelectorAll('[name="scopeMode"],[name="channelIds"]').forEach(el=>el.addEventListener('change',scopeChanged));
 document.getElementById('rule-page-search').addEventListener('input',updateScope);
 document.getElementById('scope-select').addEventListener('click',()=>{field('scopeMode').value='selected';for(const label of form.querySelectorAll('[data-scope-page]'))if(!label.hidden)label.querySelector('input').checked=true;scopeChanged();});
 document.getElementById('scope-clear').addEventListener('click',()=>{form.querySelectorAll('[name="channelIds"]').forEach(c=>c.checked=false);scopeChanged();});
 document.getElementById('trial-platform').addEventListener('change',()=>{syncTrialPages();clearSample();});
 for(const id of ['trial-text','trial-context','trial-channel'])document.getElementById(id).addEventListener('input',()=>{if(sampled){clearSample();document.getElementById('sample-note').textContent='已手动修改测试内容；可检查当前文本，或重新抽取真实评论。';}});
 document.getElementById('trial-keywords').addEventListener('click',()=>trial(false));document.getElementById('trial-ai').addEventListener('click',()=>trial(true));
 document.getElementById('rule-delete').addEventListener('click',async()=>{if(busy||!editingId)return;if(!confirm('删除这条规则？已有评论不会被修改。'))return;setBusy(true);try{await request('delete',{id:editingId});rules=rules.filter(r=>r.id!==editingId);render();dialog.close();}catch(e){document.getElementById('rule-save-note').textContent=e.message;}finally{setBusy(false);}});
 document.getElementById('rule-new').addEventListener('click',()=>open());document.querySelectorAll('[data-template]').forEach(b=>b.addEventListener('click',()=>open(null,b.dataset.template)));document.getElementById('rule-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});field('category').addEventListener('change',sync);field('aiEnabled').addEventListener('change',sync);field('directPhrases').addEventListener('input',sync);field('action').addEventListener('change',sync);field('directAction').addEventListener('change',sync);
 document.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{category=b.dataset.category;document.querySelectorAll('[data-category]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));render();}));document.getElementById('rule-search').addEventListener('input',render);render();
})();
</script>` });
}
