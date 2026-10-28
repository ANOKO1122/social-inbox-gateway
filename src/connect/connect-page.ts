import type { ConnectSummary } from './connect-flow.js';
import { missingScopes } from './scopes.js';
import { COMMENT_ACTION_SCOPES, LOGIN_SCOPES } from './scopes.js';

export interface ConnectPageView {
  mountPath: string;
  redirectUri: string;
  loggedIn: boolean;
  summary: ConnectSummary;
  notice?: string;
  /** When set, this page is inside the workbench and must offer a way back. */
  returnHref?: string;
}

const MESSAGES: Record<string, string> = {
  login_failed: '口令不正确',
  login_required: '请先输入网关口令',
  access_denied: '你取消了授权',
  state_mismatch: '授权已过期，或不是从本页发起的，请重新连接',
  missing_code: 'Facebook 没有返回授权码',
  connected: '授权完成。下面是已保存的主页和订阅结果。',
  graph_200: '主页令牌被接受了，但应用还没有 pages_manage_metadata，订阅没有成功',
};

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

export function noticeFor(code: string | undefined): string | undefined {
  if (!code || !SAFE_CODE.test(code)) {
    return undefined;
  }
  return MESSAGES[code] ?? `授权没有完成（${code}）`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function kindLabel(kind: 'facebook_page' | 'instagram'): string {
  return kind === 'facebook_page' ? 'Facebook 主页' : 'Instagram';
}

function tally(view: ConnectPageView): string {
  const channels = view.summary.channels;
  const pages = channels.filter((channel) => channel.kind === 'facebook_page').length;
  const instagram = channels.filter((channel) => channel.kind === 'instagram').length;
  const subscribed = channels.filter((channel) => channel.subscribed).length;
  return `<dl class="tally-row">
    <div><dt>主页</dt><dd>${pages}</dd></div>
    <div><dt>Instagram</dt><dd>${instagram}</dd></div>
    <div><dt>已订阅</dt><dd>${subscribed}</dd></div>
  </dl>`;
}

export function renderConnectPage(view: ConnectPageView): string {
  const notice = view.notice ? `<p class="notice" role="status">${escapeHtml(view.notice)}</p>` : '';
  const scopes = LOGIN_SCOPES.map((scope) => `<li><code>${scope}</code></li>`).join('');
  const body = view.loggedIn ? renderDashboard(view) : renderLogin(view.mountPath);
  const back = view.returnHref
    ? `<nav>
        <a href="${escapeHtml(view.returnHref)}">收件</a>
        <a href="/inbox/admin">管理</a>
        <a href="/inbox/dify/">知识库（dify）</a>
        <a href="/inbox/connect" aria-current="page">主页授权</a>
        <a href="/launches">定时发帖（postiz）</a>
      </nav>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-ark-theme="endfield" data-ark-depth="moderate">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>连接 Facebook 主页</title>
  <style>
    :root { color-scheme:light; --ink:#20231e; --paper:#f3f1ea; --sheet:#fffdf8; --signal:#fffa00; --line:#dedfd5; --ok:#216345; --danger:#94382e; --quiet:#65695d; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif; line-height:1.6; font-size:14px; }
    ::selection { background:var(--signal); color:var(--ink); }
    a { color:inherit; text-underline-offset:4px; }
    .topbar { min-height:72px; display:flex; align-items:center; gap:48px; padding:12px max(24px,calc((100vw - 1200px)/2)); border-bottom:1px solid var(--line); background:var(--sheet); }
    .brand { display:flex; align-items:center; gap:12px; flex:none; }
    .brand strong { display:block; font-size:17px; letter-spacing:.16em; line-height:1.2; }
    .brand p { margin:3px 0 0; font-size:11px; color:var(--quiet); }
    .mark { width:10px; height:24px; background:var(--signal); }
    .topbar nav { display:flex; gap:8px; flex-wrap:wrap; }
    .topbar a { padding:10px 14px; text-decoration:none; border-radius:6px; }
    .topbar a[aria-current="page"] { background:var(--signal); font-weight:650; }
    .topbar a:hover { background:#e9e8df; }
    .topbar a[aria-current="page"]:hover { background:#f0eb00; }
    main { max-width:1248px; margin:0 auto; padding:48px 24px 64px; }
    h1,h2,p { margin-top:0; }
    h1 { font-size:30px; letter-spacing:-.03em; line-height:1.3; margin-bottom:12px; }
    h2 { font-size:18px; line-height:1.4; margin-bottom:8px; }
    .desk-head { display:flex; align-items:center; justify-content:space-between; gap:32px; margin-bottom:32px; }
    .lede { color:var(--quiet); margin:0; max-width:65ch; }
    .button,button { display:inline-flex; justify-content:center; align-items:center; gap:12px; min-height:44px; padding:10px 20px; border:1px solid var(--ink); border-radius:6px; font:inherit; font-weight:650; text-decoration:none; cursor:pointer; background:transparent; color:var(--ink); }
    .button { background:var(--signal); white-space:nowrap; }
    .button:hover,button.primary:hover { background:#eeea00; }
    button.primary { background:var(--signal); }
    .button svg { width:18px; height:18px; }
    .overview { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px; padding:16px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); margin-bottom:32px; }
    .tally-row { display:flex; flex-wrap:wrap; gap:24px; margin:0; }
    .tally-row div { display:flex; align-items:baseline; gap:8px; }
    .tally-row dt { color:var(--quiet); font-size:13px; }
    .tally-row dd { margin:0; font-weight:650; font-size:20px; font-variant-numeric:tabular-nums; }
    .overview-note { color:var(--quiet); font-size:12px; margin:0; }
    .section-head { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
    .section-head h2 { margin:0; }
    .section-head p { margin:0; color:var(--quiet); font-size:13px; }
    .grants { margin-bottom:40px; }
    .grant { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:24px; padding:24px; background:var(--sheet); border:1px solid var(--line); border-radius:12px; margin-bottom:12px; }
    .grant-top { min-width:0; }
    .account-label { font-size:12px; color:var(--quiet); margin:0 0 4px; }
    .grant h3 { font-size:17px; font-weight:600; margin:0 0 12px; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
    .renewal { border-left:1px solid var(--line); padding-left:24px; }
    .renewal time { display:block; font-size:17px; font-weight:600; font-variant-numeric:tabular-nums; }
    .renewal p:last-child { margin:8px 0 0; color:var(--quiet); font-size:12px; max-width:48ch; }
    .status { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; font-size:12px; border-radius:4px; overflow-wrap:anywhere; }
    .status-on { color:var(--ok); background:#eaf3ec; }
    .status-off { color:var(--danger); background:#f9ece7; }
    .status:before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:12px; background:var(--sheet); scrollbar-color:#b6b9ac var(--paper); }
    table { border-collapse:collapse; width:100%; font-size:13px; }
    th,td { text-align:left; padding:16px 20px; border-bottom:1px solid var(--line); vertical-align:middle; }
    th { font-weight:500; color:var(--quiet); background:#eeeee5; font-size:12px; white-space:nowrap; }
    tbody tr:last-child td { border-bottom:0; }
    tbody tr:hover { background:#f7f7ef; }
    .channel-name { font-weight:600; overflow-wrap:anywhere; }
    td .meta { display:block; margin-top:4px; font-size:12px; color:var(--quiet); }
    .platform { color:var(--quiet); white-space:nowrap; }
    code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; overflow-wrap:anywhere; }
    .notice { padding:16px 20px; background:#fff9d3; border:1px solid #e0d49a; border-radius:8px; margin-bottom:24px; }
    .setup { border-top:1px solid var(--line); margin-top:32px; padding-top:8px; }
    summary { cursor:pointer; padding:16px 0; font-weight:600; min-height:48px; }
    summary::marker { color:var(--quiet); }
    details p { max-width:75ch; color:var(--quiet); }
    .uri { background:var(--sheet); border:1px solid var(--line); padding:16px; border-radius:6px; overflow-wrap:anywhere; }
    .scope-list { display:flex; flex-wrap:wrap; gap:8px; padding:0; list-style:none; }
    .scope-list li { background:#e8e9df; padding:4px 8px; border-radius:4px; }
    .actions { margin-top:24px; }
    .empty { padding:40px 24px; text-align:center; border:1px dashed #b6b9ac; border-radius:12px; }
    .empty p { color:var(--quiet); margin:8px 0 0; }
    form.gate { display:grid; gap:20px; max-width:420px; background:var(--sheet); border:1px solid var(--line); border-radius:12px; padding:24px; }
    input { width:100%; margin-top:8px; border:1px solid #9a9e90; background:var(--sheet); padding:12px; border-radius:6px; font:inherit; color:inherit; caret-color:var(--ink); }
    :focus-visible { outline:2px solid var(--ink); outline-offset:4px; }
    @media (max-width:860px) {
      .topbar { align-items:flex-start; flex-direction:column; gap:16px; padding:16px 24px; }
      .topbar nav { gap:4px; }
      .topbar a { padding:8px 12px; }
      main { padding-top:32px; }
      .desk-head { align-items:flex-start; }
      th,td { padding:14px 16px; }
    }
    @media (max-width:600px) {
      .topbar { padding:16px; }
      main { padding:24px 16px 40px; }
      h1 { font-size:26px; }
      .desk-head { flex-direction:column; gap:20px; margin-bottom:24px; }
      .desk-head .button { width:100%; }
      .tally-row { gap:20px; }
      .grant { grid-template-columns:1fr; gap:20px; padding:20px; }
      .renewal { border-left:0; border-top:1px solid var(--line); padding:16px 0 0; }
      table,tbody { display:block; width:100%; }
      thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
      tbody tr { display:grid; grid-template-columns:1fr; padding:16px; border-bottom:1px solid var(--line); gap:6px; }
      tbody tr:last-child { border-bottom:0; }
      td { display:block; padding:0; border:0; }
      td.platform { font-size:11px; }
      td.channel-name { font-size:15px; }
      td:last-child { margin-top:4px; }
      td code { color:var(--quiet); }
      .grants { margin-bottom:32px; }
    }
  </style>
</head>
<body>
  <header class="topbar"><div class="brand"><span class="mark" aria-hidden="true"></span><div><strong>INBOX</strong><p class="kicker">客服工作台</p></div></div>${back}</header>
  <main>
  ${notice}
  <header class="desk-head">
    <div><h1>连接 Facebook 主页</h1><p class="lede">管理主页授权，在工作台接收评论和私信。使用主页管理员的 Facebook 账号连接。</p></div>
    ${view.loggedIn ? connectButton(view.mountPath) : ''}
  </header>
  ${view.loggedIn ? `<div class="overview">${tally(view)}<p class="overview-note">订阅状态为最近一次授权时的记录</p></div>` : ''}
  ${body}
  ${view.loggedIn ? renderCommentPermissions(view) : ''}
  <details class="setup">
    <summary>接入配置与权限说明</summary>
    <p>用主页管理员的 Facebook 登录。网关会换成约 60 天的用户令牌，保存不按 60 天过期的主页令牌，并给主页订阅 <code>feed</code> 和 <code>messages</code>。挂在主页上的 Instagram 使用同一枚主页令牌。</p>
    <h2>OAuth 回调地址</h2>
    <p>首次配置时，将此地址添加到 Facebook 应用的有效 OAuth 跳转 URI：</p>
    <div class="uri"><code>${escapeHtml(view.redirectUri)}</code></div>
    <details><summary>登录时请求的权限</summary>
      <p>应用里还没加上的，要先在 Meta 开发者后台加进 Facebook 登录用例，否则弹窗会直接失败：</p>
      <ul class="scope-list">${scopes}</ul>
      <p>评论的人不用登录。开发模式下，只有这个应用的管理员、开发者和测试员触发的评论和私信会推过来。</p>
    </details>
  </details>
  </main>
</body>
</html>`;
}

function connectButton(mountPath: string): string {
  return `<a class="button" href="${escapeHtml(mountPath)}/facebook/start">连接 Facebook<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></a>`;
}

function renderLogin(mountPath: string): string {
  return `<form class="gate" method="post" action="${escapeHtml(mountPath)}/login">
    <label>网关口令 <input type="password" name="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">进入</button>
  </form>`;
}

function renderDashboard(view: ConnectPageView): string {
  const grants = view.summary.grants.map((grant) => {
    const missing = missingScopes(grant.scopes);
    const missingText = missing.length === 0
      ? '基础收件权限已授予'
      : `基础收件权限缺少：${missing.join('、')}`;
    const when = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(grant.expiresAt);
    const ready = missing.length === 0;
    return `<article class="grant">
      <div class="grant-top">
        <p class="account-label">Facebook 用户</p><h3>${escapeHtml(grant.facebookUserId)}</h3>
        <span class="status ${ready ? 'status-on' : 'status-off'}">${escapeHtml(missingText)}</span>
      </div>
      <div class="renewal"><p class="account-label">用户令牌到期 · 北京时间</p><time datetime="${escapeHtml(grant.expiresAt.toISOString())}">${escapeHtml(when)}</time><p>到期前重新点一次「连接 Facebook」，网关会再换一枚长期用户令牌。</p></div>
    </article>`;
  }).join('');

  const rows = view.summary.channels.map((channel) => {
    const state = channel.subscribed
      ? '<span class="status status-on">已订阅 feed、messages</span>'
      : `<span class="status status-off">未订阅${channel.subscriptionError ? `（${escapeHtml(channel.subscriptionError)}）` : ''}</span>`;
    const extra = channel.kind === 'instagram' ? `<span class="meta">挂在主页 ${escapeHtml(channel.pageId)}</span>` : '';
    return `<tr>
      <td class="platform">${kindLabel(channel.kind)}</td>
      <td class="channel-name">${escapeHtml(channel.name)}${extra}</td>
      <td><code>${escapeHtml(channel.externalId)}</code></td>
      <td>${state}</td>
    </tr>`;
  }).join('');

  const table = rows.length === 0
    ? '<div class="empty"><h2>还没有连接主页</h2><p>点击「连接 Facebook」，授权后将在这里显示可管理的主页和订阅结果。</p></div>'
    : `<div class="table-wrap"><table aria-label="已授权主页与 Webhook 订阅状态">
      <thead><tr><th>类型</th><th>名称</th><th>编号</th><th>Webhook</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  const leave = view.returnHref
    ? ''
    : `<form method="post" action="${escapeHtml(view.mountPath)}/logout"><button type="submit">退出</button></form>`;
  return `${grants ? `<section class="grants" aria-label="授权账号"><div class="section-head"><h2>授权账号</h2><p>查看已授予的权限与续期时间</p></div>${grants}</section>` : ''}
  <section aria-label="已连接主页"><div class="section-head"><h2>已连接的主页与账号</h2><p>共 ${view.summary.channels.length} 个 · 重新连接可更新授权与订阅</p></div>${table}</section>
  ${leave ? `<div class="actions">${leave}</div>` : ''}`;
}

function renderCommentPermissions(view: ConnectPageView): string {
  const valid = view.summary.grants.filter(grant => grant.expiresAt.getTime() > Date.now());
  const permissions = [
    ['pages_read_user_content', 'Facebook 删除访客评论'],
    ['instagram_manage_engagement', 'Instagram 评论点赞'],
  ] as const;
  const rows = permissions.map(([scope, purpose]) => {
    const granted = valid.filter(grant => grant.scopes.includes(scope)).length;
    const complete = valid.length > 0 && granted === valid.length;
    const status = valid.length ? `已授予 ${granted} / ${valid.length} 个有效账号` : '暂无有效授权账号';
    return `<tr><td><code>${scope}</code></td><td>${purpose}</td><td><span class="status ${complete ? 'status-on' : 'status-off'}">${status}</span></td></tr>`;
  }).join('');
  const buttons = (['facebook', 'instagram'] as const).map(platform => {
    const complete = valid.length > 0 && valid.every(grant => COMMENT_ACTION_SCOPES[platform].every(scope => grant.scopes.includes(scope)));
    const label = platform === 'facebook' ? 'Facebook 评论权限' : 'Instagram 点赞权限';
    return `<a class="button" href="${escapeHtml(view.mountPath)}/facebook/start?comment_actions=${platform}">${complete ? '重新授权' : '补充'} ${label}</a>`;
  }).join(' ');
  return `<section class="setup" aria-label="评论操作授权"><h2>评论操作授权</h2>
    <p>应用后台开通权限后，还需要授权账号将权限授予工作台。下表显示最近一次登录保存的授权记录，不代表应用后台是否已开通。</p>
    <table aria-label="评论附加权限状态"><thead><tr><th>附加权限</th><th>用途</th><th>已授予工作台</th></tr></thead><tbody>${rows}</tbody></table>
    <p>若应用里已开通，但这里仍未授予，请从对应的补充入口重新登录授权。各主页以其对应授权账号的权限为准。</p>
    <div class="actions">${buttons}</div></section>`;
}
