import type { Staff } from './staff-repository.js';
import type { SavedReply } from './saved-replies.js';
import { adminTabs, shell } from './workbench-page.js';

const esc = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function renderSavedRepliesPage(input: { staff: Staff; nonce: string; replies: SavedReply[] }): string {
  return shell({ title: '快捷话术', nonce: input.nonce, staff: input.staff, section: 'admin', body: `
<style>
.saved-page { flex:1; min-height:0; overflow:auto; padding:28px 32px 40px; scrollbar-color:#aaa79e var(--paper); }
.saved-content { max-width:1600px; min-width:980px; margin:0 auto; }
.saved-page h1,.saved-page h2,.saved-page p,.saved-dialog h2,.saved-dialog p { margin:0; }
.saved-page ::selection,.saved-dialog ::selection { background:var(--signal); color:var(--ink); }
.saved-heading { display:flex; align-items:center; justify-content:space-between; gap:24px; }
.saved-heading h1 { font-size:28px; line-height:1.3; letter-spacing:-.02em; }
.saved-heading p { font-size:13px; color:#66635c; margin-top:8px; line-height:1.7; }
.saved-tools { display:flex; align-items:end; gap:14px; margin:26px 0 14px; }
.saved-tools label { display:flex; flex-direction:column; gap:6px; font-size:12px; color:#66635c; }
.saved-tools .saved-search { width:340px; margin-right:auto; }
.saved-page input,.saved-page select,.saved-dialog input:not([type=checkbox]),.saved-dialog select,.saved-dialog textarea { border:1px solid var(--line); background:var(--sheet); color:var(--ink); padding:10px 12px; border-radius:4px; font:inherit; min-width:0; caret-color:var(--ink); }
.saved-tools input,.saved-tools select { font-size:13px; min-height:40px; }
.saved-page input::placeholder,.saved-dialog input::placeholder,.saved-dialog textarea::placeholder { color:#66635c; opacity:1; }
.saved-result-line { display:flex; justify-content:space-between; align-items:baseline; gap:24px; min-height:38px; font-size:12px; }
.saved-count { color:#66635c; font-variant-numeric:tabular-nums; white-space:nowrap; }
.saved-notice { line-height:1.6; }
.saved-notice[data-error=true],.saved-error { color:var(--danger); }
.saved-table { width:100%; table-layout:fixed; border-collapse:collapse; font-size:13px; }
.saved-table th { position:static; padding:11px 12px; text-align:left; font-size:12px; font-weight:500; color:#66635c; }
.saved-table td { padding:18px 12px; vertical-align:middle; overflow-wrap:anywhere; }
.saved-table th:first-child,.saved-table td:first-child { padding-left:0; }
.saved-table th:last-child,.saved-table td:last-child { padding-right:0; }
.saved-table th:nth-child(2) { width:156px; }.saved-table th:nth-child(3) { width:100px; }.saved-table th:nth-child(4) { width:150px; }.saved-table th:last-child { width:150px; }
.saved-title { display:block; font-size:14px; font-weight:600; line-height:1.5; }
.saved-preview { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; margin-top:6px; color:#66635c; line-height:1.7; }
.saved-scope { display:block; color:#66635c; margin-top:4px; font-size:12px; }
.saved-state { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }.saved-state::before { content:''; width:5px; height:5px; border-radius:50%; background:var(--ok); }.saved-state[data-enabled=false] { color:#66635c; }.saved-state[data-enabled=false]::before { background:#8e8b81; }
.saved-updated { color:#66635c; font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.saved-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
.saved-action { border:1px solid var(--line); background:var(--sheet); border-radius:4px; padding:8px 12px; min-height:36px; white-space:nowrap; font-size:13px; }
.saved-action:hover { border-color:var(--ink); background:var(--paper); }.saved-action:focus-visible { outline:2px solid var(--ink); outline-offset:3px; }
.saved-page button,.saved-dialog button { cursor:pointer; }.saved-page button:disabled,.saved-dialog button:disabled { opacity:.5; cursor:wait; }
.saved-empty { padding:68px 24px; text-align:center; border-bottom:1px solid var(--line); }.saved-empty h2 { font-size:20px; font-weight:600; }.saved-empty p { color:#66635c; line-height:1.7; margin-top:10px; font-size:13px; }.saved-empty button { margin-top:20px; }
.saved-dialog { width:720px; max-width:calc(100vw - 64px); max-height:calc(100vh - 64px); padding:0; border:0; border-radius:8px; background:var(--paper); color:var(--ink); box-shadow:0 16px 56px #0004; overflow:auto; scrollbar-color:#aaa79e var(--paper); }
.saved-dialog::backdrop { background:#0006; }
.saved-dialog-head { display:flex; justify-content:space-between; align-items:center; gap:24px; padding:22px 26px 20px; border-bottom:1px solid var(--line); }.saved-dialog-head h2 { font-size:21px; line-height:1.4; }
.saved-fields { display:grid; gap:20px; padding:24px 26px; }
.saved-field { display:flex; flex-direction:column; gap:8px; font-size:13px; }.saved-field input,.saved-field textarea,.saved-field select { width:100%; }.saved-field textarea { min-height:180px; max-height:320px; resize:vertical; line-height:1.7; }
.saved-field small { color:#66635c; font-size:12px; line-height:1.6; }.saved-body-meta { display:flex; justify-content:space-between; gap:24px; }.saved-body-meta span { font-variant-numeric:tabular-nums; white-space:nowrap; }
.saved-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
.saved-enabled { display:flex; align-items:flex-start; gap:9px; font-size:13px; }.saved-enabled input { width:16px; height:16px; flex-shrink:0; margin:2px 0 0; accent-color:var(--ink); }.saved-enabled small { display:block; color:#66635c; font-size:12px; line-height:1.7; margin-top:5px; }
.saved-footer { display:flex; align-items:center; gap:12px; padding:18px 26px; border-top:1px solid var(--line); }.saved-error { flex:1; font-size:12px; line-height:1.6; overflow-wrap:anywhere; }.saved-footer button { flex-shrink:0; }
.saved-page [hidden],.saved-dialog [hidden] { display:none !important; }
</style>
<main class="saved-page"><div class="saved-content">
  ${adminTabs('saved-replies')}
  <header class="saved-heading"><div><h1>快捷话术</h1><p>团队共用的话术。插入到回复草稿后，可继续修改并手动发送。</p></div><button class="primary" type="button" id="saved-new" aria-haspopup="dialog" aria-controls="saved-dialog">新建话术</button></header>
  <div class="saved-tools">
    <label class="saved-search">搜索话术<input id="saved-search" type="search" maxlength="200" placeholder="搜索标题或内容"></label>
    <label>适用平台<select id="saved-platform"><option value="all">全部平台</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select></label>
    <label>适用类型<select id="saved-kind"><option value="all">评论与私信</option><option value="comment">评论</option><option value="message">私信</option></select></label>
    <label>启用状态<select id="saved-status"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label>
  </div>
  <div class="saved-result-line"><p id="saved-count" class="saved-count" role="status"></p><p id="saved-notice" class="saved-notice" role="status"></p></div>
  <table class="saved-table"><thead><tr><th scope="col">标题 / 内容</th><th scope="col">适用范围</th><th scope="col">状态</th><th scope="col">更新于（北京时间）</th><th scope="col">操作</th></tr></thead><tbody id="saved-rows"></tbody></table>
  <div class="saved-empty" id="saved-empty" hidden><h2 id="saved-empty-title">还没有快捷话术</h2><p id="saved-empty-description">把经常使用的回复保存下来，团队处理相同问题时可以直接插入。</p><button class="ghost" type="button" id="saved-empty-action">创建第一条话术</button></div>
</div></main>
<dialog class="saved-dialog" id="saved-dialog" aria-labelledby="saved-dialog-title">
  <form id="saved-form">
    <header class="saved-dialog-head"><h2 id="saved-dialog-title">新建话术</h2><button class="ghost" id="saved-close" type="button" aria-label="关闭话术编辑">关闭</button></header>
    <div class="saved-fields">
      <label class="saved-field">话术标题<input name="title" required maxlength="80" placeholder="例如：查询订单进度" autocomplete="off"></label>
      <label class="saved-field">话术内容<textarea name="body" required maxlength="8000" rows="7" placeholder="填写可重复使用的回复内容" aria-describedby="saved-body-help"></textarea><small class="saved-body-meta" id="saved-body-help">仅保存纯文本，客服插入后可以修改。<span id="saved-body-count">0 / 8000</span></small></label>
      <div class="saved-grid">
        <label class="saved-field">适用平台<select name="platform"><option value="all">Facebook 与 Instagram</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select></label>
        <label class="saved-field">适用类型<select name="kind"><option value="all">评论与私信</option><option value="comment">仅评论</option><option value="message">仅私信</option></select></label>
      </div>
      <label class="saved-enabled"><input name="enabled" type="checkbox" checked><span>启用这条话术<small>启用后，所有客服都可以在适用的评论或私信中搜索使用。</small></span></label>
    </div>
    <footer class="saved-footer"><p id="saved-error" class="saved-error" role="alert"></p><button class="ghost" id="saved-cancel" type="button">取消</button><button class="primary" id="saved-submit" type="submit">保存话术</button></footer>
  </form>
</dialog>
<script nonce="${esc(input.nonce)}">
(() => {
  let replies=${json(input.replies)},editingId=null,saving=false,opener=null;
  const workingIds=new Set(),dialog=document.getElementById('saved-dialog'),form=document.getElementById('saved-form');
  const search=document.getElementById('saved-search'),platform=document.getElementById('saved-platform'),kind=document.getElementById('saved-kind'),status=document.getElementById('saved-status');
  const notice=document.getElementById('saved-notice'),error=document.getElementById('saved-error');
  const field=name=>form.elements.namedItem(name);
  const platformLabel=value=>value==='facebook'?'Facebook':value==='instagram'?'Instagram':'全部平台';
  const kindLabel=value=>value==='comment'?'仅评论':value==='message'?'仅私信':'评论与私信';
  const dateFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  function node(tag,text,className){const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element;}
  function announce(text,failed=false){notice.textContent=text;notice.dataset.error=String(failed);}
  function updateCount(){document.getElementById('saved-body-count').textContent=field('body').value.length+' / 8000';}
  function render(){
    const q=search.value.trim().toLocaleLowerCase(),rows=document.getElementById('saved-rows');rows.replaceChildren();
    const visible=replies.filter(reply=>(!q||(reply.title+' '+reply.body).toLocaleLowerCase().includes(q))&&(platform.value==='all'||reply.platform==='all'||reply.platform===platform.value)&&(kind.value==='all'||reply.kind==='all'||reply.kind===kind.value)&&(status.value==='all'||reply.enabled===(status.value==='enabled'))).sort((a,b)=>Number(b.enabled)-Number(a.enabled)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    document.getElementById('saved-count').textContent=visible.length===replies.length?'共 '+replies.length+' 条话术':'显示 '+visible.length+' / '+replies.length+' 条话术';
    for(const reply of visible){
      const tr=document.createElement('tr'),content=document.createElement('td');content.append(node('strong',reply.title,'saved-title'),node('span',reply.body,'saved-preview'));tr.append(content);
      const scope=node('td',platformLabel(reply.platform));scope.append(node('span',kindLabel(reply.kind),'saved-scope'));tr.append(scope);
      const state=document.createElement('td'),stateLabel=node('span',reply.enabled?'已启用':'已停用','saved-state');stateLabel.dataset.enabled=String(reply.enabled);state.append(stateLabel);tr.append(state);
      const updated=document.createElement('td'),time=node('time',dateFormat.format(new Date(reply.updatedAt)),'saved-updated');time.dateTime=reply.updatedAt;time.title=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'full',timeStyle:'short'}).format(new Date(reply.updatedAt));updated.append(time);tr.append(updated);
      const actionsCell=document.createElement('td'),actions=node('div','','saved-actions');
      const edit=node('button','编辑','saved-action');edit.type='button';edit.disabled=workingIds.has(reply.id);edit.dataset.edit=reply.id;edit.setAttribute('aria-haspopup','dialog');edit.setAttribute('aria-controls','saved-dialog');edit.setAttribute('aria-label','编辑话术：'+reply.title);edit.addEventListener('click',()=>open(reply,edit));
      const toggle=node('button',workingIds.has(reply.id)?'更新中…':reply.enabled?'停用':'启用','saved-action');toggle.type='button';toggle.disabled=workingIds.has(reply.id);toggle.dataset.toggle=reply.id;toggle.setAttribute('aria-label',(reply.enabled?'停用':'启用')+'话术：'+reply.title);toggle.addEventListener('click',()=>toggleReply(reply,toggle));actions.append(edit,toggle);actionsCell.append(actions);tr.append(actionsCell);rows.append(tr);
    }
    document.getElementById('saved-empty').hidden=visible.length>0;
    document.getElementById('saved-empty-title').textContent=replies.length?'没有符合条件的话术':'还没有快捷话术';
    document.getElementById('saved-empty-description').textContent=replies.length?'试试其他关键词，或清除筛选条件。':'把经常使用的回复保存下来，团队处理相同问题时可以直接插入。';
    document.getElementById('saved-empty-action').textContent=replies.length?'清除筛选':'创建第一条话术';
  }
  function open(reply,button){
    if(saving)return;editingId=reply?.id??null;opener=button??document.activeElement;form.reset();error.textContent='';
    field('title').value=reply?.title??'';field('body').value=reply?.body??'';field('platform').value=reply?.platform??'all';field('kind').value=reply?.kind??'all';field('enabled').checked=reply?.enabled??true;updateCount();
    document.getElementById('saved-dialog-title').textContent=reply?'编辑话术':'新建话术';dialog.showModal();field('title').focus();
  }
  function close(){if(saving)return;dialog.close();const target=opener?.isConnected?opener:editingId?document.querySelector('[data-edit="'+editingId+'"]'):null;(target??document.getElementById('saved-new')).focus();}
  function busy(value){saving=value;for(const control of form.elements)control.disabled=value;form.setAttribute('aria-busy',String(value));document.getElementById('saved-submit').textContent=value?'正在保存…':'保存话术';}
  async function request(operation,body){
    const response=await fetch('/inbox/admin/saved-replies/'+operation,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));if(!response.ok||!result.reply)throw new Error(result.message||'请求失败，请重试。');return result.reply;
  }
  function replace(reply){const index=replies.findIndex(item=>item.id===reply.id);if(index<0)replies.unshift(reply);else replies[index]=reply;}
  async function toggleReply(reply,button){
    if(workingIds.has(reply.id))return;workingIds.add(reply.id);button.disabled=true;button.textContent='更新中…';button.setAttribute('aria-busy','true');button.previousElementSibling.disabled=true;announce('');
    try{const updated=await request('toggle',{id:reply.id,enabled:!reply.enabled});replace(updated);announce('「'+updated.title+'」已'+(updated.enabled?'启用。':'停用。'));}
    catch(failure){announce('更新失败：'+failure.message+' 请重试。',true);}
    finally{workingIds.delete(reply.id);const restoreFocus=document.activeElement===button||document.activeElement===document.body;render();if(restoreFocus)(document.querySelector('[data-toggle="'+reply.id+'"]')??status).focus();}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(saving||!form.reportValidity())return;
    const reply={...(editingId?{id:editingId}:{}),title:field('title').value,body:field('body').value,platform:field('platform').value,kind:field('kind').value,enabled:field('enabled').checked};
    error.textContent='';busy(true);
    try{const saved=await request('save',{reply});replace(saved);render();announce('「'+saved.title+'」已保存'+(saved.enabled?'，团队可以使用。':'，当前为停用状态。'));busy(false);close();}
    catch(failure){error.textContent='保存失败：'+failure.message+' 内容已保留，可修改后重试。';busy(false);}
  });
  for(const control of [search,platform,kind,status])control.addEventListener(control===search?'input':'change',render);
  field('body').addEventListener('input',updateCount);
  document.getElementById('saved-new').addEventListener('click',event=>open(null,event.currentTarget));
  document.getElementById('saved-empty-action').addEventListener('click',event=>{if(!replies.length){open(null,event.currentTarget);return;}search.value='';platform.value='all';kind.value='all';status.value='all';render();search.focus();});
  document.getElementById('saved-close').addEventListener('click',close);document.getElementById('saved-cancel').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  render();
})();
</script>` });
}
