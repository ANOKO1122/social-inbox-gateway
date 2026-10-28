import { randomBytes } from 'node:crypto';

import type { AuditRow, InboxComment, InboxQueue, KnownPage, RuleReview, Staff, StaffAccount } from './staff-repository.js';
import { presentThread } from './staff-repository.js';
import { formatBeijing } from './beijing-time.js';
import { facebookCommentUrl, instagramCommentUrl } from './comment-link.js';

export interface WorkbenchView {
  platform?: 'facebook' | 'instagram';
  queue?: InboxQueue;
  staff: Staff;
  comments: InboxComment[];
  inboxPage?: { total: number; hasMore: boolean; nextCursor: string | null; endCursor: string | null };
  inboxFilters?: { q?: string; kind?: 'all' | 'comment' | 'message'; state?: 'all' | 'open' };
  selected: InboxComment | null;
  thread?: InboxComment[];
  /** Mobile list view. The thread markup can still be present for an instant switch. */
  focusList?: boolean;
  notice?: string;
  nonce: string;
}

type Section = 'instagram' | 'comments' | 'admin' | 'audit' | 'statistics' | 'login';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function when(date: Date, style: 'full' | 'short' = 'full'): string {
  return formatBeijing(date, style);
}

function stateLabel(comment: InboxComment): string {
  if (comment.pendingCount !== undefined) return comment.pendingCount > 0 ? `待回复 ${comment.pendingCount}` : '已处理';
  if (comment.deleted) return '已删除';
  if (comment.isOwn) return '我方回复';
  if (comment.hidden) return '已隐藏';
  if (comment.ruleReview?.status === 'dismissed') return '无需处理';
  if (comment.ruleReview?.decision === 'review' && comment.ruleReview.status === 'open') return '待人工审核';
  if (comment.replyStatus === 'sent') {
    return '已回复';
  }
  if (comment.replyStatus === 'failed') {
    return '失败';
  }
  return '未回复';
}

function ruleReviewLabel(review: RuleReview): string {
  if (review.status === 'dismissed') return '已标记无需处理';
  if (review.decision === 'review') return review.status === 'resolved' ? '人工已处理' : '待人工审核';
  if (review.outcome === 'hidden') return '规则已隐藏';
  if (review.outcome === 'already_hidden') return '平台此前已隐藏';
  return review.outcome === 'kept' ? '已保留' : '处理完成';
}

export function pageNonce(): string {
  return randomBytes(16).toString('base64url');
}

const CSS = `
.review-category { margin:0 16px 12px; color:var(--quiet); font-size:12px; }
.review-category-buttons { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; margin-top:6px; }
.review-category-buttons .chip { min-height:34px; padding:0 4px; color:var(--ink); font-size:13px; white-space:nowrap; }
.review-category-buttons .chip:hover:not([aria-pressed="true"]) { background:var(--sheet); border-color:var(--ink); }
.rule-review { margin-top:12px; padding:10px 12px; border-left:3px solid #c2ad57; background:#f5f2e7; font-size:12px; }
.rule-review-title { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.rule-review p { margin:6px 0 0; color:var(--quiet); font-size:12px; }
.rule-review button { padding:3px 7px; background:var(--sheet); border:1px solid var(--line); cursor:pointer; }
.rule-review-status { margin-left:auto; font-size:11px; color:var(--quiet); }

.admin-tabs { display:flex; gap:24px; padding-bottom:18px; margin-bottom:24px; border-bottom:1px solid var(--line); }
.admin-tabs a { text-decoration:none; padding:6px 0; }
.admin-tabs a[aria-current] { font-weight:700; border-bottom:3px solid var(--accent, #ffe900); }
:root {
  color-scheme: light;
  --ink: #191919;
  --paper: #f3f1ea;
  --sheet: #fffdf8;
  --signal: #fffa00;
  --line: rgba(25, 25, 25, .16);
  --ok: #0d6b45;
  --danger: #8d1d18;
  --quiet: rgba(25, 25, 25, .62);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif;
  line-height: 1.45;
}
button, input, textarea, select { font: inherit; color: inherit; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.app { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.topbar {
  min-height: 4rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--ink);
  background: var(--paper);
}
.brand { display: flex; align-items: center; gap: .7rem; min-width: 9rem; }
.mark { width: .7rem; height: .7rem; background: var(--signal); flex: none; }
.brand strong { display: block; letter-spacing: .16em; font-weight: 650; line-height: 1; }
.kicker { margin: 0; font-size: .72rem; letter-spacing: .14em; text-transform: uppercase; }
nav { display: flex; gap: .25rem; align-items: center; }
nav a, .ghost, .account form button {
  min-height: 2.4rem;
  display: inline-flex;
  align-items: center;
  padding: 0 .75rem;
  border: 1px solid transparent;
  background: transparent;
  text-decoration: none;
  cursor: pointer;
}
nav a[aria-current="page"] { background: var(--signal); border-color: var(--ink); }
.account { margin-left: auto; display: flex; align-items: center; gap: .6rem; }
.account .name { font-weight: 650; }
.role { font-size: .75rem; letter-spacing: .08em; }
.workspace {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(19rem, 25%) minmax(0, 1fr) 15rem;
  grid-template-areas: "queue stage dossier";
}
.queue, .stage, .dossier { min-height: 0; min-width: 0; }
.queue { grid-area: queue; display: flex; flex-direction: column; background: var(--paper); }
.stage {
  grid-area: stage;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  border-right: 1px solid var(--line);
  background:
    linear-gradient(180deg, rgba(25,25,25,.035), transparent 7rem),
    var(--paper);
}
.dossier { grid-area: dossier; padding: 1.1rem 1rem 2rem; overflow: auto; }
.list-head, .thread-head { display: flex; justify-content: space-between; gap: .8rem; align-items: end; padding: 1rem 1rem .7rem; }
.list-head h2, .thread-head h2 { margin: .15rem 0 0; font-size: 1.35rem; font-weight: 650; letter-spacing: -.03em; }
.count { min-width: 2rem; font-size: 1.35rem; font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; }
.chips { display: flex; gap: .35rem; padding: 0 1rem .7rem; }
.chip {
  min-height: 2rem;
  padding: 0 .7rem;
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
}
.chip[aria-pressed="true"] { background: var(--signal); border-color: var(--ink); }
.inbox-categories { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding:0 16px 12px; }
.inbox-categories label { display:grid; gap:4px; color:var(--quiet); font-size:12px; }
.inbox-categories select { min-width:0; width:100%; min-height:40px; border:1px solid var(--line); border-radius:6px; background:var(--sheet); color:var(--ink); padding:6px 8px; font:inherit; font-size:13px; }
.reply-identity { font-size:12px; color:var(--quiet); margin:0 0 8px; overflow-wrap:anywhere; }
.filter { display: block; padding: 0 1rem .7rem; }
.filter input, textarea {
  width: 100%;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--sheet);
  padding: .55rem .7rem;
}
select {
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--sheet);
  min-height: 2.4rem;
  padding: 0 .5rem;
}
.rows { overflow: auto; overflow-anchor: none; flex: 1; }
.queue-footer { padding:12px 16px; border-top:1px solid var(--line); flex-shrink:0; font-size:12px; }
.queue-pagination { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.queue-pagination span { color:var(--quiet); }
.queue-footer button { border:1px solid var(--line); background:var(--sheet); min-height:34px; padding:4px 12px; cursor:pointer; white-space:nowrap; }
.queue-footer button:hover { border-color:var(--ink); }
.queue-footer button:disabled { opacity:.6; cursor:wait; }
.queue-error { margin:8px 0 0; color:var(--danger); }
.queue-error button { margin-left:8px; }
.thread-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 7.5rem;
  gap: .7rem;
  align-items: start;
  padding: .8rem 1rem;
  border-bottom: 1px solid var(--line);
  text-decoration: none;
}
.thread-row[hidden] { display:none; }
.thread-head > .state { flex:none; white-space:nowrap; }
.thread-row[aria-current="true"] { background: var(--sheet); box-shadow: inset 4px 0 0 var(--signal); }
.row-main { min-width: 0; }
.row-meta { display: grid; gap: .2rem; }
.row-meta .badge,
.row-meta .tally,
.row-meta .state {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: .08rem .2rem;
  border: 1px solid var(--line);
  font-size: .75rem;
  font-weight: 500;
  line-height: 1.35;
  letter-spacing: 0;
  text-align: center;
  white-space: nowrap;
}
.comment-time { color:var(--quiet); text-decoration:underline; text-underline-offset:3px; }
.comment-time:hover { color:var(--ink); }
.comment-time:focus-visible { outline:2px solid var(--ink); outline-offset:3px; }
.row-top, .bubble-top, .floor-top { display: flex; justify-content: flex-start; gap: .55rem; align-items: baseline; }
.who, .title { font-weight: 650; }
.title, .preview { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post-id { display: block; margin-top: .15rem; font-size: .75rem; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.preview, .meta, time { color: var(--quiet); }
.preview {
  display: block;
  margin-top: .2rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .78;
}
.meta, time { font-variant-numeric: tabular-nums; font-size: .78rem; }
.state-sent { color: var(--ok); }
.state-failed { color: var(--danger); }
.transcript {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: .8rem;
  padding: .4rem 1.2rem 1rem;
}
.bubble {
  max-width: min(36rem, 88%);
  padding: .75rem .9rem;
  border: 1px solid var(--ink);
}
.bubble.in { align-self: flex-start; background: var(--sheet); }
.bubble.out { align-self: flex-end; background: var(--ink); color: var(--paper); }
.bubble p { margin: .35rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.sealed { align-self: flex-end; margin: 0; color: var(--ok); }
.back { display: none; min-height: 2.2rem; align-items: center; text-decoration: none; }
.composer {
  display: grid;
  gap: .6rem;
  align-items: end;
  padding: .75rem 1rem 1rem;
  border-top: 1px solid var(--ink);
  background: var(--paper);
}
.composer-actions { display: flex; align-items: center; gap: .6rem; min-width: 0; }
.composer-actions > button, .composer-actions > .emoji-picker { flex-shrink: 0; }
.composer[hidden] { display:none; }
.reply-target, .suggest-note { margin: 0; }
.reply-target { font-size: .85rem; overflow-wrap: anywhere; }
.suggest-note { flex: 1; min-width: 0; font-size: .85rem; }
.suggest-note:not([hidden]) { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#suggest { margin-left: auto; min-width: 5.5rem; justify-content: center; }
textarea { min-height: 4.6rem; resize: vertical; }
button.primary, a.primary {
  min-height: 2.75rem;
  padding: 0 1rem;
  border: 1px solid var(--ink);
  background: var(--signal);
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.post-card, .floors { margin: 0 1.2rem .8rem; padding: .75rem .85rem; border: 1px solid var(--line); background: var(--sheet); }
.post-card p, .floor p { margin: .25rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.post-card a { font-size: .85rem; }
.floor { padding: .55rem 0; border-top: 1px solid var(--line); cursor: pointer; }
.floor:first-child { border-top: 0; }
.floor.current { box-shadow: inset 3px 0 0 var(--signal); padding-left: .45rem; }
.floor[data-depth="1"] { margin-left: 1.35rem; }
.floor[data-depth="2"], .floor[data-depth="3"], .floor[data-depth="4"] { margin-left: 2.7rem; }
.reply-to, .floor-meta { margin: .1rem 0 0; font-size: .78rem; }
.floor-meta { opacity: .78; }
.mention { background: transparent; color: #2458a8; font-weight: 650; }
.floor time { white-space: nowrap; }
.badge { font-size: .75rem; }
.stage.is-loading .post-card, .stage.is-loading .floors { opacity: .72; }
.empty, .hint { margin: 1rem; }
.dossier h2 { margin: .2rem 0 1rem; font-size: 1.2rem; }
.dossier dl { margin: 0; }
.dossier div { padding: .55rem 0; border-top: 1px solid var(--line); }
.dossier dt { font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; }
.dossier dd { margin: .15rem 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.sheet { flex: 1; min-height: 0; overflow: auto; padding: 1.1rem 1.25rem 3rem; }
.sheet .filter { max-width: 24rem; margin-top: .9rem; padding: 0; }
.sheet .chips { padding: .9rem 0 0; }
.notice { margin: 0 0 .9rem; padding: .65rem .8rem; border: 1px solid var(--ink); background: var(--signal); }
.desk-head { display: flex; justify-content: space-between; align-items: end; gap: 1.2rem; padding-bottom: .85rem; border-bottom: 1px solid var(--ink); }
.desk-head h1 { margin: .15rem 0 0; font-size: 1.6rem; font-weight: 650; letter-spacing: -.03em; }
.tally-row { display: flex; gap: 1.1rem; margin: 0; }
.tally-row div { min-width: 4.2rem; }
.tally-row dt { font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; }
.tally-row dd { margin: .1rem 0 0; font-size: 1.4rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.desk-note { max-width: 42rem; margin: .85rem 0 0; }
.person {
  margin-top: 1rem;
  padding: .9rem 1rem 1rem;
  border: 1px solid var(--ink);
  background: var(--sheet);
  display: grid;
  grid-template-columns: 16.5rem minmax(0, 1fr);
  gap: .8rem 1.25rem;
  align-items: start;
}
.person-side { display: grid; gap: .75rem; align-content: start; }
.person-top, .form-row { display: flex; align-items: end; gap: .7rem; flex-wrap: wrap; }
.person-top { align-items: center; justify-content: space-between; }
.person h2 { margin: .1rem 0 0; font-size: 1.25rem; }
.field, .check {
  display: flex;
  gap: .45rem;
  align-items: center;
  min-height: 2.4rem;
}
.field { flex-direction: column; align-items: stretch; gap: .25rem; font-size: .78rem; letter-spacing: .06em; }
.field select { min-width: 9rem; }
.check { padding-bottom: .35rem; }
.grant-field {
  margin: 0;
  padding: .35rem .7rem .7rem;
  border: 1px solid var(--ink);
  background: var(--paper);
  min-width: 0;
}
.grant-field legend { padding: 0 .3rem; font-size: .78rem; }
.grant-field legend .meta { margin-left: .45rem; letter-spacing: 0; }
.field-tools { display: flex; gap: .35rem; margin: .15rem 0 .45rem; }
.field-tools .ghost { min-height: 1.9rem; padding: 0 .55rem; border-color: var(--line); background: var(--sheet); }
.pages {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14.5rem, 1fr));
  max-height: 16rem;
  overflow: auto;
  border: 1px solid var(--line);
  background: var(--sheet);
}
.pages label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: .5rem;
  align-items: center;
  min-height: 2.7rem;
  margin: 0;
  padding: .3rem .6rem;
  border: 0;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  background: transparent;
}
.pages label .meta { grid-column: 2; }
.pages label:last-child { border-bottom: 0; }
.pages label[hidden] { display: none; }
.pages label .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pages label .meta { font-variant-numeric: tabular-nums; }
.pages label:has(input:checked) {
  background: color-mix(in srgb, var(--signal) 28%, var(--sheet));
  box-shadow: inset 3px 0 0 var(--ink);
}
.person-off { border-top-color: var(--line); background: var(--paper); }
.status {
  display: inline-flex;
  align-items: center;
  min-height: 1.7rem;
  padding: 0 .45rem;
  border: 1px solid var(--ink);
  font-size: .75rem;
  letter-spacing: .04em;
  white-space: nowrap;
}
.status-sent, .status-on { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, var(--sheet)); }
.status-failed, .status-off { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, var(--sheet)); }
.table-wrap { overflow: auto; margin-top: 1rem; border-top: 1px solid var(--ink); }
table { width: 100%; border-collapse: collapse; }
td, th { border-bottom: 1px solid var(--line); text-align: left; padding: .7rem .55rem; vertical-align: top; }
th { font-size: .72rem; letter-spacing: .1em; text-transform: uppercase; font-weight: 650; position: sticky; top: 0; background: var(--paper); }
td.prose { min-width: 12rem; max-width: 22rem; white-space: pre-wrap; overflow-wrap: anywhere; }
td .meta { display: block; margin-top: .15rem; }
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 860px) {
  .topbar { flex-wrap: wrap; padding: .6rem .8rem; }
  .topbar nav { width:100%; flex-wrap:wrap; }
  .topbar nav a { white-space:nowrap; padding:0 .6rem; }
  .account { width: 100%; margin-left: 0; justify-content: space-between; }
  .workspace { grid-template-columns: 1fr; grid-template-areas: "queue"; }
  .workspace.has-selection { display:block; overflow:auto; }
  .workspace.has-selection .stage { display:block; overflow:visible; }
  .workspace.has-selection .transcript { overflow:visible; }
  .workspace.has-selection .dossier { border-top:1px solid var(--line); }
  .workspace.has-selection .queue,
  .workspace:not(.has-selection) .stage,
  .workspace:not(.has-selection) .dossier { display: none; }
  .back { display: inline-flex; }
  .stage { border: 0; }
  .person { grid-template-columns: 1fr; }
  .desk-head, .person-top { align-items: start; flex-direction: column; }
}
/* Desktop inbox: a compact queue and a conversation-first reading area. */
@media (min-width: 981px) {
  .workspace { font-size:14px; }
  .thread-row { grid-template-columns:minmax(0,1fr); gap:8px; padding:16px; }
  .row-meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .row-meta .badge,.row-meta .tally,.row-meta .state { width:auto; border:0; padding:0; font-size:11px; }
  .row-meta .state { margin-left:auto; }
  .row-meta .tally { color:var(--quiet); }
  .thread-row .post-id { display:none; }
  .thread-row .title { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; font-size:14px; }
  .thread-row:hover { background:var(--sheet); }
  .thread-row[aria-current="true"] { box-shadow:none; background:#efedcc; }
  .stage { background:var(--sheet); position:relative; }
  .thread-head { align-items:center; padding:16px 24px; border-bottom:1px solid var(--line); }
  .thread-head h2 { font-size:17px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .thread-channel { margin:0 0 4px; color:var(--quiet); font-size:12px; }
  .thread-head .state { font-size:12px; }
  .post-card { margin:0; padding:12px 24px; border:0; border-bottom:1px solid var(--line); background:var(--paper); flex-shrink:0; }
  #post-text { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-size:13px; }
  #post-text.expanded { display:block; max-height:180px; overflow:auto; }
  .post-tools { display:flex; justify-content:space-between; align-items:center; color:var(--quiet); font-size:12px; }
  .post-tools button { border:0; background:none; padding:4px 0 4px 12px; cursor:pointer; text-decoration:underline; }
  .transcript { min-height:80px; padding:8px 24px 24px; }
  .floors { margin:0; padding:0; border:0; background:none; }
  .floor { padding:16px 12px; border-top:1px solid var(--line); }
  .floor:hover:not(.own) { background:var(--paper); }
  .floor.current { box-shadow:none; padding-left:12px; background:#f7f5d8; outline:1px solid #c2bd7a; outline-offset:-1px; }
  .floor.own { cursor:default; background:#edf5ef; margin-top:8px; margin-bottom:12px; padding:12px; border:0; }
  .floor-top { flex-wrap:wrap; gap:4px 8px; }
  .floor-state { margin-left:auto; font-size:11px; color:var(--quiet); }
  .floor-state.state-sent { color:var(--ok); }
  .floor p { line-height:1.65; }
  .composer { flex-shrink:0; padding:12px 24px 16px; background:var(--sheet); border-top-color:var(--line); gap:8px; }
  .reply-identity { margin:0; font-size:12px; color:var(--quiet); }
  .reply-target { font-size:13px; font-weight:600; }
  .composer textarea { min-height:80px; max-height:180px; padding:10px 12px; border:1px solid var(--line); border-radius:6px; background:var(--sheet); }
  .composer button { border-radius:5px; }
  .dossier { font-size:12px; background:var(--paper); }
  .dossier #dossier-title { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .reply-notice { position:absolute; z-index:2; top:12px; left:24px; right:24px; margin:0; font-size:13px; border:1px solid var(--line); border-radius:6px; background:var(--sheet); }
  .reply-notice.success { background:#edf5ef; color:var(--ok); }
  .reply-notice.failure { position:static; margin:12px 24px 0; flex-shrink:0; background:#fff0ed; color:var(--danger); }
}
.floor-actions { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:10px; }
.floor-actions .floor-meta { margin:0; }
.floor-actions button { border:0; padding:3px 0; background:transparent; color:var(--quiet); font-size:12px; cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
.floor-actions button:hover { color:var(--ink); }
.floor-actions button:disabled { cursor:not-allowed; opacity:.6; }
.floor-actions button[aria-pressed="true"] { color:var(--ok); font-weight:600; }
.floor-more { position:relative; font-size:12px; }
.floor-more summary { cursor:pointer; padding:3px 0; color:var(--quiet); }
.floor-more-menu { position:absolute; z-index:6; left:0; top:100%; width:200px; background:var(--sheet); border:1px solid var(--line); padding:6px; }
.floor-more-menu button { display:block; width:100%; text-align:left; padding:8px; text-decoration:none; }
.floor-more-menu button:hover { background:var(--paper); }
.floor.is-deleted { background:#f0efec; }
.floor.is-deleted > p { color:var(--quiet); }
.visibility-note { color:var(--quiet); font-size:12px; }
.floor.is-hidden { background:#f0efec; }
.floor.is-hidden > p:not(.reply-to) { color:var(--quiet); }
.reply-heading { display:flex; align-items:baseline; gap:16px; min-width:0; }
.reply-heading p { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.reply-heading .reply-identity { flex:0 1 auto; }
.reply-heading .reply-target { flex:0 1 auto; text-align:left; }
.emoji-picker { position:relative; }
.emoji-picker summary { cursor:pointer; padding:6px 10px; }
.emoji-grid { position:absolute; bottom:100%; left:0; width:240px; display:flex; flex-wrap:wrap; padding:8px; gap:4px; background:var(--paper, #fffdf7); border:1px solid #222; box-shadow:0 4px 18px #0002; z-index:5; }
.emoji-grid button { font-size:20px; padding:6px; background:transparent; border:0; }
.saved-picker { position:relative; flex-shrink:0; }
.saved-picker summary { cursor:pointer; padding:6px 10px; }
.saved-picker-panel { position:absolute; bottom:calc(100% + 10px); left:0; width:380px; padding:16px; background:var(--sheet); border:1px solid var(--line); z-index:8; }
.saved-picker-panel > p { margin:0 0 10px; color:var(--quiet); font-size:12px; }
.saved-picker-panel input { width:100%; }
.saved-picker-list { max-height:280px; overflow:auto; margin-top:10px; }
.saved-picker-list button { display:block; width:100%; text-align:left; padding:10px 8px; border:0; border-bottom:1px solid var(--line); background:transparent; }
.saved-picker-list button:hover { background:var(--selected); }
.saved-picker-list strong, .saved-picker-list span { display:block; }
.saved-picker-list span { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.5; color:var(--quiet); margin-top:4px; }
.saved-picker-panel > a { display:inline-block; margin-top:12px; font-size:12px; }
.saved-picker-status { margin:10px 0 0; font-size:12px; }
.floor-actions button[aria-pressed="true"] { background:#fff600; }
.inbox-categories { grid-template-columns:1fr 1fr; }
.audit-sheet { max-width:1600px; width:100%; margin:0 auto; }
.audit-sheet .desk-head h1 { margin:0; }
.audit-sheet .table-wrap { border:1px solid var(--line); border-radius:8px; background:var(--sheet); }
.audit-sheet table { width:100%; table-layout:fixed; }
.audit-sheet th { background:var(--paper); font-size:12px; font-weight:500; letter-spacing:0; }
.audit-sheet th,.audit-sheet td { padding:16px; vertical-align:top; }
.audit-sheet th:nth-child(1) { width:145px; }
.audit-sheet th:nth-child(2) { width:90px; }
.audit-sheet th:nth-child(3) { width:160px; }
.audit-sheet th:nth-child(6) { width:120px; }
.audit-sheet th:nth-child(7) { width:120px; }
.audit-sheet td { font-size:13px; overflow-wrap:anywhere; }
.audit-sheet .meta { display:block; margin-top:6px; }
.audit-sheet .audit-actions a { display:block; margin-bottom:8px; text-underline-offset:3px; }
.audit-sheet .audit-text { white-space:pre-wrap; max-height:160px; overflow:auto; line-height:1.6; }
.audit-sheet .status { white-space:nowrap; }
.audit-sheet .audit-intro { margin:8px 0 0; color:var(--quiet); font-size:13px; }
.admin-sheet { padding:40px 24px; }
.admin-content { max-width:1200px; margin:0 auto; }
.admin-heading h1 { margin:0 0 8px; font-size:28px; letter-spacing:-.025em; }
.admin-heading p,.admin-footnote { color:var(--quiet); margin:0; font-size:13px; }
.member-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:32px 0 16px; }
.member-toolbar input { width:280px; min-height:44px; border-radius:6px; border:1px solid var(--line); padding:10px 12px; background:var(--sheet); color:var(--ink); font:inherit; }
.member-toolbar p { margin:0; font-size:13px; color:var(--quiet); }
.member-toolbar p span { margin:0 12px; }
.member-table { border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--sheet); }
.member-table th { padding:14px 20px; font-size:12px; font-weight:500; letter-spacing:0; background:var(--paper); color:var(--quiet); position:static; }
.member-table td { padding:16px 20px; vertical-align:middle; font-size:14px; }
.member-table tbody tr:last-child td { border-bottom:0; }
.member-table tbody tr:hover { background:var(--paper); }
.member-table tr[hidden] { display:none; }
.member-name { font-weight:650; overflow-wrap:anywhere; }
.self-label { margin-left:8px; font-size:11px; color:var(--quiet); }
.member-scope { font-variant-numeric:tabular-nums; }
.member-action { text-align:right; }
.member-action button { gap:8px; border:1px solid var(--line); border-radius:6px; min-height:40px; }
.member-action svg,.dialog-close svg { width:18px; height:18px; }
.admin-footnote { margin-top:16px; }
.access-dialog { padding:0; width:min(760px,calc(100vw - 32px)); max-height:min(820px,calc(100dvh - 48px)); color:var(--ink); background:var(--sheet); border:1px solid var(--line); border-radius:16px; }
.access-dialog::backdrop { background:rgba(15,20,15,.5); }
.access-dialog form { display:flex; flex-direction:column; max-height:min(818px,calc(100dvh - 50px)); }
.access-header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding:24px; border-bottom:1px solid var(--line); }
.access-header h2 { margin:0 0 4px; font-size:21px; overflow-wrap:anywhere; }
.access-header p { margin:0; color:var(--quiet); font-size:13px; }
.dialog-close { display:inline-flex; align-items:center; min-width:44px; min-height:44px; justify-content:center; border:0; background:transparent; color:var(--ink); cursor:pointer; border-radius:6px; }
.access-body { padding:24px; overflow:auto; min-height:0; scrollbar-color:#aaa99d var(--paper); }
.access-settings { display:flex; align-items:end; gap:32px; }
.access-settings select { min-height:40px; border-radius:6px; }
.access-settings .check { min-height:40px; padding:0; }
.role-hint { margin:12px 0 24px; color:var(--quiet); font-size:13px; }
.permission-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; }
.permission-heading h3 { margin:0; font-size:15px; }
.permission-heading span { font-size:12px; color:var(--quiet); font-variant-numeric:tabular-nums; }
.page-search { display:block; }
.page-search input { width:100%; min-height:44px; border-radius:6px; border:1px solid var(--line); padding:10px 12px; font:inherit; color:var(--ink); background:var(--sheet); }
.permission-tools { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin:8px 0; font-size:12px; }
.permission-tools label { display:flex; align-items:center; gap:6px; min-height:40px; }
.permission-tools button { font-size:12px; min-height:40px; }
.permission-pages { grid-template-columns:1fr 1fr; max-height:none; border-radius:8px; }
.permission-pages label { padding:12px; min-height:64px; cursor:pointer; }
.permission-pages label:has(input:checked) { box-shadow:none; background:#f5f4cf; }
.permission-pages .name { font-size:13px; white-space:normal; overflow-wrap:anywhere; }
.permission-pages .meta { font-size:11px; color:var(--quiet); }
.permission-pages input,.access-settings input,.permission-tools input { accent-color:var(--ink); }
.permission-empty { grid-column:1/-1; padding:24px; margin:0; color:var(--quiet); font-size:13px; text-align:center; }
.permission-empty[hidden] { display:none; }
.access-footer { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 24px; border-top:1px solid var(--line); }
.access-footer span { color:var(--quiet); font-size:12px; }
.access-footer div { display:flex; gap:8px; }
.access-footer button { min-height:44px; border-radius:6px; }
.access-dialog button:hover,.member-action button:hover { background:var(--paper); }
.access-dialog button.primary:hover { background:#f0eb00; }
.access-dialog button:disabled { opacity:.5; cursor:default; }
.access-dialog :focus-visible { outline:2px solid var(--ink); outline-offset:2px; }
@media (max-width:600px) {
  .admin-sheet { padding:24px 16px; }
  .member-toolbar { align-items:stretch; flex-direction:column; margin-top:24px; }
  .member-toolbar input { width:100%; }
  .member-table table,.member-table tbody { display:block; }
  .member-table thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  .member-table tbody tr { display:grid; grid-template-columns:1fr auto; align-items:center; gap:8px 16px; padding:16px; border-bottom:1px solid var(--line); }
  .member-table td { padding:0; border:0; font-size:13px; }
  .member-table td:first-child { grid-column:1; font-size:15px; }
  .member-table td:nth-child(2) { grid-column:1; grid-row:2; color:var(--quiet); }
  .member-table td:nth-child(3) { grid-column:2; grid-row:1; text-align:right; }
  .member-table td:nth-child(4) { grid-column:1; grid-row:3; }
  .member-table td:nth-child(5) { grid-column:2; grid-row:2/4; }
  .access-dialog { width:calc(100vw - 16px); max-height:calc(100dvh - 24px); }
  .access-dialog form { max-height:calc(100dvh - 26px); }
  .access-header,.access-body { padding:16px; }
  .access-header h2 { font-size:19px; }
  .access-settings { gap:16px; }
  .permission-pages { grid-template-columns:1fr; }
  .access-footer { padding:12px 16px; }
  .access-footer span { display:none; }
  .access-footer div { width:100%; justify-content:flex-end; }
}
@media (prefers-reduced-motion: no-preference) {
  .bubble, .person { animation: rise .22s ease; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
}
`;

export function shell(input: { title: string; nonce: string; staff: Staff | null; section: Section; body: string }): string {
  const staff = input.staff;
  const current = (section: Section) => input.section === section ? ' aria-current="page"' : '';
  const nav = staff
    ? `<nav>
        <a href="/inbox/workbench/facebook"${current('comments')}>Facebook</a>
        <a href="/inbox/workbench/instagram"${current('instagram')}>Instagram</a>
        ${staff.role === 'admin'
          ? `<a href="/inbox/admin"${current('admin')}>管理</a><a href="/inbox/admin/statistics"${current('statistics')}>统计</a><a href="/inbox/dify/">知识库（dify）</a><a href="/inbox/connect">主页授权</a><a href="/launches">定时发帖（postiz）</a>`
          : `<a href="/inbox/admin/audit"${current('audit')}>我的记录</a>`}
      </nav>`
    : '';
  const account = staff
    ? `<div class="account"><span class="name">${escapeHtml(staff.name)}</span><span class="role">${staff.role === 'admin' ? '管理员' : '客服'}</span><form method="post" action="/inbox/auth/logout"><button class="ghost" type="submit">退出</button></form></div>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-ark-theme="endfield" data-ark-depth="moderate">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand"><span class="mark" aria-hidden="true"></span><div><strong>INBOX</strong><p class="kicker">客服工作台</p></div></div>
      ${nav}
      ${account}
    </header>
    ${input.body}
  </div>
  <script nonce="${input.nonce}">
    ${facebookCommentUrl.toString()}
    ${instagramCommentUrl.toString()}
    ${ruleReviewLabel.toString()}
    const inboxPlatform = document.querySelector('.workspace')?.dataset.platform || 'facebook';
    const inboxQueue = document.querySelector('.workspace')?.dataset.queue || 'all';
    let noticeTimer;
    function clearNotice() {
      clearTimeout(noticeTimer);
      document.querySelector('.stage > .notice')?.remove();
      const url = new URL(location.href);
      if (url.searchParams.has('notice')) { url.searchParams.delete('notice'); history.replaceState(history.state, '', url); }
    }
    function notifyReply(message, success) {
      clearNotice();
      const note = document.createElement('p');
      note.className = 'notice reply-notice' + (success ? ' success' : ' failure');
      note.setAttribute('role', success ? 'status' : 'alert');
      note.textContent = message;
      document.querySelector('.stage')?.prepend(note);
      if (success) noticeTimer = setTimeout(clearNotice, 3000);
    }
    if (new URLSearchParams(location.search).get('notice') === 'sent') noticeTimer = setTimeout(clearNotice, 3000);
    const form = document.querySelector('#reply-form');
    const replyBox = document.querySelector('#reply-text');
    const savedPicker = document.querySelector('.saved-picker');
    const savedSearch = document.getElementById('saved-search');
    const savedList = document.getElementById('saved-picker-list');
    const savedStatus = document.getElementById('saved-picker-status');
    let savedRequest = 0, savedTimer;
    async function loadSavedReplies() {
      if (!savedPicker?.open) return;
      const version = ++savedRequest;
      const anchor = document.querySelector('.thread-row[aria-current="true"]');
      const targetKey = draftKey();
      savedList.replaceChildren(); savedStatus.textContent = '正在读取话术…';
      try {
        const query = new URLSearchParams({ platform: inboxPlatform, kind: anchor?.dataset.kind || 'comment', q: savedSearch.value });
        const response = await fetch('/inbox/workbench/saved-replies?' + query, { headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (version !== savedRequest || !savedPicker.open || targetKey !== draftKey()) return;
        if (!response.ok) throw new Error(data.message || '读取失败，请重新打开话术库。');
        savedStatus.textContent = data.replies.length ? '点击话术填入草稿，确认后再发送。' : savedSearch.value ? '没有匹配的话术。' : '暂无适用话术，请管理员在管理页添加。';
        for (const reply of data.replies) {
          const button = document.createElement('button'); button.type = 'button';
          const title = document.createElement('strong'); title.textContent = reply.title;
          const preview = document.createElement('span'); preview.textContent = reply.body.length > 150 ? reply.body.slice(0, 150) + '…' : reply.body;
          button.append(title, preview);
          button.addEventListener('click', () => {
            if (!(replyBox instanceof HTMLTextAreaElement) || replyBox.disabled || replyBox.readOnly || targetKey !== draftKey()) return;
            const start = replyBox.selectionStart, end = replyBox.selectionEnd;
            if (replyBox.maxLength > 0 && replyBox.value.length - (end - start) + reply.body.length > replyBox.maxLength) {
              savedStatus.textContent = '填入后超过当前回复的 ' + replyBox.maxLength + ' 字限制，请先缩短草稿或修改话术。'; return;
            }
            replyBox.setRangeText(reply.body, start, end, 'end');
            form.elements.suggestionId.value = '';
            replyBox.dispatchEvent(new Event('input', { bubbles: true })); saveDraft();
            const hint = document.getElementById('suggest-note'); hint.hidden = false; hint.textContent = '话术已填入，可修改后发送。';
            savedPicker.open = false; replyBox.focus();
          });
          savedList.append(button);
        }
      } catch (error) { if (version === savedRequest && savedPicker.open) savedStatus.textContent = error.message || '读取失败，请重新打开话术库。'; }
    }
    savedPicker?.addEventListener('toggle', () => { if (savedPicker.open) { savedSearch.value = ''; loadSavedReplies(); savedSearch.focus(); } else ++savedRequest; });
    savedSearch?.addEventListener('input', () => { ++savedRequest; clearTimeout(savedTimer); savedTimer = setTimeout(loadSavedReplies, 200); });
    document.querySelectorAll('[data-insert-emoji]').forEach(button => button.addEventListener('click', () => {
      if (!(replyBox instanceof HTMLTextAreaElement) || replyBox.disabled || replyBox.readOnly) return;
      const emoji = button.dataset.insertEmoji;
      if (replyBox.maxLength > 0 && replyBox.value.length - (replyBox.selectionEnd - replyBox.selectionStart) + emoji.length > replyBox.maxLength) return;
      replyBox.setRangeText(emoji, replyBox.selectionStart, replyBox.selectionEnd, 'end');
      replyBox.dispatchEvent(new Event('input', { bubbles: true }));
      button.closest('details').open = false; replyBox.focus();
    }));
    document.addEventListener('click', event => {
      if (!event.target.closest('.emoji-picker')) document.querySelectorAll('.emoji-picker').forEach(p => p.open = false);
      if (!event.target.closest('.saved-picker') && savedPicker) savedPicker.open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelectorAll('.emoji-picker').forEach(p => p.open = false);
      if (event.key === 'Escape' && savedPicker?.open) { savedPicker.open = false; savedPicker.querySelector('summary').focus(); }
    });
    const stage = document.querySelector('.stage');
    let sending = false, suggesting = false;
    const drafts = new Map();
    function draftKey() { return (form?.elements.eventId.value || '') + ':' + (form?.elements.targetId.value || ''); }
    function saveDraft() { if (replyBox) drafts.set(draftKey(), replyBox.value); }
    function restoreDraft() { if (replyBox) replyBox.value = drafts.get(draftKey()) || ''; }
    function rowState(item) {
      if (inboxQueue === 'review') return '待人工 ' + item.threadCount;
      if (inboxQueue === 'rule_hidden') return '规则已隐藏';
      if (inboxQueue === 'dismissed') return '无需处理';
      return item.pendingCount > 0 ? '待回复 ' + item.pendingCount : '已处理';
    }
    function syncFilterUrl(url) {
      url.searchParams.set('queue', inboxQueue);
      url.searchParams.set('source', sourceFilter?.value || 'all');
      url.searchParams.set('kind', kindFilter?.value || 'all');
      url.searchParams.set('state', stateFilter);
      if (filter?.value) url.searchParams.set('q', filter.value); else url.searchParams.delete('q');
      return url;
    }
    function preserveQueuePosition(container) {
      const scrollTop = container.scrollTop;
      const bounds = container.getBoundingClientRect();
      // Keep the visible thread in place even when new comments reorder the list.
      // Capture immediately before rendering, after any pending network request.
      const anchors = scrollTop > 0 ? [...container.querySelectorAll('.thread-row')]
        .filter(row => !row.hidden)
        .map(row => ({ row, bounds: row.getBoundingClientRect() }))
        .filter(item => item.bounds.bottom > bounds.top && item.bounds.top < bounds.bottom)
        .map(item => ({ row: item.row, offset: item.bounds.top - bounds.top })) : [];
      return () => {
        const anchor = anchors.find(item => item.row.isConnected && !item.row.hidden);
        container.scrollTop = anchor
          ? container.scrollTop + anchor.row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
          : scrollTop;
      };
    }
    const queueFooter = document.getElementById('queue-footer');
    const queueMore = document.getElementById('queue-more');
    const queueProgress = document.getElementById('queue-progress');
    const queueError = document.getElementById('queue-error');
    let queueTotal = Number(queueFooter?.dataset.total || 0);
    let queueHasMore = queueFooter?.dataset.hasMore === 'true';
    let queueNextCursor = queueFooter?.dataset.nextCursor || '';
    let queueEndCursor = queueFooter?.dataset.endCursor || '';
    let queueSearchTimer;
    let queueController;
    let queueVersion = 0;
    let queueRefreshPending = false;
    let queueFailedMode = 'refresh';
    let queueAppliedFilters;
    let queueRequestedFilters;
    let refreshingQueue = false;
    function queueFilterKey() {
      return JSON.stringify([filter?.value.trim() || '', kindFilter?.value || 'all', stateFilter, sourceFilter?.value || 'all']);
    }
    async function refreshQueue(mode = 'refresh') {
      clearTimeout(queueSearchTimer);
      const filterKey = queueFilterKey();
      if (filterKey !== queueAppliedFilters) mode = 'reset';
      if (refreshingQueue && (mode !== 'reset' || filterKey === queueRequestedFilters)) {
        if (mode === 'refresh') queueRefreshPending = true;
        return;
      }
      if (mode === 'more' && (!queueHasMore || !queueNextCursor)) return;
      queueController?.abort();
      const controller = new AbortController();
      queueController = controller;
      const version = ++queueVersion;
      refreshingQueue = true;
      queueRequestedFilters = filterKey;
      if (mode === 'reset') queueRefreshPending = false;
      if (queueMore) { queueMore.disabled = true; queueMore.textContent = mode === 'more' ? '加载中…' : '加载更多'; }
      if (queueProgress && mode === 'reset') queueProgress.textContent = '正在查询全部历史消息…';
      if (queueError) queueError.hidden = true;
      try {
        const url = syncFilterUrl(new URL('/inbox/workbench/queue', location.origin));
        url.searchParams.set('platform', inboxPlatform);
        if (mode === 'more') url.searchParams.set('cursor', queueNextCursor);
        else if (mode !== 'reset' && queueEndCursor) url.searchParams.set('through', queueEndCursor);
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) throw new Error('queue_unavailable');
        const data = await response.json();
        if (version !== queueVersion || filterKey !== queueFilterKey()) return;
        if (!Array.isArray(data.rows)) throw new Error('queue_unavailable');
        const container = document.getElementById('comments');
        if (!container) return;
        const restorePosition = preserveQueuePosition(container);
        const oldRows = [...container.querySelectorAll('.thread-row')];
        const retained = new Set();
        for (const item of data.rows) {
          const row = oldRows.find(row => row.dataset.platform === (item.platform || 'facebook') && row.dataset.channelId === item.channelId &&
            row.dataset.kind === item.kind && (item.kind === 'message' ? row.dataset.senderId === item.senderId : (row.dataset.post || row.dataset.event) === (item.postId || item.id))) || document.createElement('a');
          retained.add(row);
          row.className = 'thread-row'; row.id = 'c-' + item.id;
          row.dataset.event = item.id; row.dataset.kind = item.kind; row.dataset.platform = item.platform || 'facebook';
          row.dataset.channelId = item.channelId; row.dataset.channel = item.channelName ?? row.dataset.channel ?? item.channelId;
          row.dataset.senderId = item.senderId || ''; row.dataset.sender = item.senderName === null ? '' : item.senderName ?? row.dataset.sender ?? '';
          row.dataset.post = item.postId || ''; row.dataset.external = item.externalId ?? row.dataset.external ?? '';
          row.dataset.body = item.body ?? row.dataset.body ?? ''; row.dataset.title = item.kind === 'message' ? '私信' : item.postTitle || row.dataset.title || '帖子';
          const occurredAt = new Date(item.occurredAt ?? NaN);
          if (Number.isFinite(occurredAt.getTime())) row.dataset.time = occurredAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
          row.dataset.adSource = String(item.adSource === true); row.dataset.pending = String(item.pendingCount || 0);
          row.dataset.state = rowState(item); delete row.dataset.queueExcluded;
          row.href = syncFilterUrl(new URL('/inbox/workbench/' + inboxPlatform + '?event=' + encodeURIComponent(item.id), location.origin)).href;
          row.replaceChildren();
          const main = document.createElement('span'); main.className = 'row-main';
          const title = document.createElement('span'); title.className = 'title'; title.textContent = row.dataset.title; main.append(title);
          if (item.kind === 'comment' && item.postId) { const post = document.createElement('span'); post.className = 'post-id'; post.textContent = item.postId; main.append(post); }
          const preview = document.createElement('span'); preview.className = 'preview';
          preview.textContent = [row.dataset.time, row.dataset.channel, (row.dataset.sender || (item.kind === 'message' ? '私信' : '评论')) + '：' + (row.dataset.body || '（没有文字）')].filter(Boolean).join(' · '); main.append(preview);
          const meta = document.createElement('span'); meta.className = 'row-meta';
          const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = (item.platform === 'instagram' ? 'Instagram' : 'Facebook') + ' · ' + (item.kind === 'message' ? '私信' : '评论');
          const tally = document.createElement('span'); tally.className = 'tally'; tally.textContent = item.threadCount + (item.kind === 'message' ? ' 条消息' : ' 条评论');
          const state = document.createElement('span'); state.className = 'state' + (item.pendingCount === 0 ? ' state-sent' : ''); state.textContent = row.dataset.state;
          meta.append(badge, tally, state); row.append(main, meta); container.append(row);
          if (row.getAttribute('aria-current') === 'true' && inboxQueue !== 'review') setStateChip('thread-state', row.dataset.state);
        }
        for (const row of oldRows) if (mode !== 'more' && !retained.has(row)) {
          if (row.getAttribute('aria-current') === 'true') row.dataset.queueExcluded = '1'; else row.remove();
        }
        document.getElementById('empty')?.remove();
        if (filterEmpty) container.append(filterEmpty);
        queueTotal = Number.isInteger(data.total) ? data.total : data.rows.length;
        queueHasMore = data.hasMore === true;
        queueNextCursor = data.nextCursor || '';
        queueEndCursor = data.endCursor || queueEndCursor;
        if (mode === 'reset' && !data.endCursor) queueEndCursor = '';
        queueAppliedFilters = filterKey;
        applyFilter();
        if (mode === 'reset') container.scrollTop = 0; else restorePosition();
      } catch (error) {
        if (version !== queueVersion || error.name === 'AbortError') return;
        queueFailedMode = mode;
        if (queueError) queueError.hidden = false;
      } finally {
        if (version === queueVersion) {
          refreshingQueue = false;
          if (queueMore) { queueMore.disabled = queueAppliedFilters !== queueFilterKey(); queueMore.textContent = '加载更多'; }
          updateQueueProgress();
          if (queueRefreshPending) { queueRefreshPending = false; refreshQueue(); }
        }
      }
    }
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (sending || form.hidden || replyBox.disabled || replyBox.readOnly) return;
      sending = true;
      replyBox.readOnly = true;
      const button = document.querySelector('#send');
      const sourceKey = draftKey();
      const sourceRow = document.querySelector('.thread-row[aria-current="true"]');
      const payload = new URLSearchParams(new FormData(form));
      saveDraft();
      clearNotice();
      if (button) { button.disabled = true; button.textContent = '发送中…'; }
      try {
        const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: payload });
        const result = await response.json();
        if (result.status === 'sent') {
          drafts.delete(sourceKey);
          contextCache.clear();
          if (sourceKey === draftKey()) {
            replyBox.value = '';
            if (result.eventId) { form.elements.eventId.value = result.eventId; form.elements.targetId.value = ''; }
            form.elements.idempotencyKey.value = crypto.randomUUID();
            clearSuggestion();
            notifyReply('回复已发送', true);
          }
          if (sourceRow?.getAttribute('aria-current') === 'true') await loadContext(form.elements.eventId.value, contextKey(sourceRow), true);
          await refreshQueue();
        } else if (sourceKey === draftKey()) {
          notifyReply(result.message || '发送失败，草稿已保留，请重试。', false);
        }
      } catch {
        if (sourceKey === draftKey()) notifyReply('未确认发送结果，草稿已保留。可重试确认，请勿重复新建发送。', false);
      } finally {
        sending = false;
        replyBox.readOnly = false;
        if (button) { button.disabled = replyBox.disabled; button.textContent = '发送'; }
      }
    });
    const suggestNote = document.getElementById('suggest-note');
    function clearSuggestion() {
      const id = document.querySelector('input[name="suggestionId"]');
      if (id instanceof HTMLInputElement) id.value = '';
      if (suggestNote) { suggestNote.hidden = true; suggestNote.textContent = ''; }
    }
    document.querySelector('#suggest')?.addEventListener('click', async () => {
      const button = document.querySelector('#suggest');
      const eventInput = document.querySelector('input[name="eventId"]');
      if (!(button instanceof HTMLButtonElement) || !(eventInput instanceof HTMLInputElement) || !eventInput.value) return;
      if (suggesting || sending || replyBox.disabled || replyBox.readOnly) return;
      suggesting = true;
      const sourceKey = draftKey(), sourceText = replyBox.value, sourceSubmission = form.elements.idempotencyKey.value;
      const currentDraft = () => sourceKey === draftKey() && sourceSubmission === form.elements.idempotencyKey.value && sourceText === replyBox.value && !replyBox.disabled && !replyBox.readOnly;
      button.disabled = true;
      button.textContent = '生成中';
      button.setAttribute('aria-busy', 'true');
      if (suggestNote) { suggestNote.hidden = true; suggestNote.textContent = ''; }
      try {
        const targetInput = document.querySelector('input[name="targetId"]');
        const response = await fetch('/inbox/workbench/suggest', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            eventId: eventInput.value,
            targetId: targetInput instanceof HTMLInputElement ? targetInput.value : '',
          }),
        });
        const data = await response.json();
        if (!currentDraft()) return;
        const message = data && typeof data.message === 'string' ? data.message : '';
        if (!response.ok) {
          if (suggestNote) {
            suggestNote.hidden = false;
            suggestNote.textContent = message || '这次没有生成建议。可以手写回复。';
          }
          return;
        }
        if (replyBox instanceof HTMLTextAreaElement && typeof data.suggestedReply === 'string') {
          replyBox.value = data.suggestedReply.slice(0, replyBox.maxLength || data.suggestedReply.length);
        }
        const id = document.querySelector('input[name="suggestionId"]');
        if (id instanceof HTMLInputElement) id.value = typeof data.id === 'string' ? data.id : '';
        const sources = Array.isArray(data.sources) ? data.sources.filter((item) => typeof item === 'string' && item) : [];
        const review = data.needsHuman ? '这条没有引用资料，请先看过再发。' : '';
        const cited = sources.length > 0 ? '参考：' + sources.join('、') + '。' : '';
        if (suggestNote) {
          suggestNote.hidden = false;
          suggestNote.textContent = '草稿已填入，确认后才会发送。' + review + cited;
        }
      } catch {
        if (currentDraft() && suggestNote) { suggestNote.hidden = false; suggestNote.textContent = '这次没有生成建议。可以手写回复。'; }
      } finally {
        suggesting = false;
        button.disabled = replyBox.disabled || sending;
        button.textContent = '生成建议';
        button.removeAttribute('aria-busy');
      }
    });
    replyBox?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (form instanceof HTMLFormElement) form.requestSubmit();
      }
    });
    const filter = document.querySelector('#filter');
    const filterEmpty = document.getElementById('filter-empty');
    const queueCount = document.getElementById('queue-count');
    const initialFilters = new URLSearchParams(location.search);
    let stateFilter = initialFilters.get('state') === 'open' ? 'open' : 'all';
    const kindFilter = document.getElementById('kind-filter');
    const sourceFilter = document.getElementById('source-filter');
    if (filter) filter.value = initialFilters.get('q') || '';
    if (kindFilter && ['comment', 'message'].includes(initialFilters.get('kind'))) kindFilter.value = initialFilters.get('kind');
    document.querySelectorAll('[data-queue-filter]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.queueFilter === inboxQueue) return;
      const url = syncFilterUrl(new URL(location.href)); url.searchParams.set('queue', button.dataset.queueFilter); url.searchParams.delete('event'); url.searchParams.set('state','all'); location.assign(url);
    }));
    const requestedSource = initialFilters.get('source');
    if (sourceFilter) sourceFilter.value = ['ads','unknown'].includes(requestedSource) ? requestedSource : 'all';
    sourceFilter?.addEventListener('change', () => {
      const url = syncFilterUrl(new URL(location.href)); url.searchParams.set('source', sourceFilter.value); url.searchParams.delete('event'); location.assign(url);
    });
    function updateQueueProgress() {
      const visible = document.querySelectorAll('.thread-row:not([hidden])').length;
      if (queueProgress) queueProgress.textContent = queueTotal === 0 ? '没有符合的会话'
        : queueHasMore ? '已显示 ' + visible + ' / ' + queueTotal + ' 个会话' : '已显示全部 ' + queueTotal + ' 个会话';
      if (queueMore) queueMore.hidden = !queueHasMore;
    }
    function applyFilter() {
      // Search and status are evaluated across the whole conversation on the server.
      // Its latest preview need not contain the search text that matched an older reply.
      document.querySelectorAll('.thread-row').forEach(row => { row.hidden = row.dataset.queueExcluded === '1'; });
      if (queueCount) queueCount.textContent = String(queueTotal);
      if (filterEmpty) filterEmpty.hidden = queueTotal > 0 || Boolean(document.getElementById('empty'));
      document.querySelectorAll('.chip[data-filter]').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.filter === stateFilter)));
      if (document.querySelector('.workspace')) history.replaceState(history.state, '', syncFilterUrl(new URL(location.href)));
      document.querySelectorAll('.thread-row').forEach(row => { row.href = syncFilterUrl(new URL(row.href)).href; });
      updateQueueProgress();
    }
    function resetQueueFilters() {
      clearTimeout(queueSearchTimer);
      refreshQueue('reset');
    }
    queueAppliedFilters = queueFilterKey();
    filter?.addEventListener('input', () => {
      clearTimeout(queueSearchTimer);
      if (queueMore) queueMore.disabled = true;
      queueSearchTimer = setTimeout(resetQueueFilters, 300);
    });
    kindFilter?.addEventListener('change', resetQueueFilters);
    document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (!(chip instanceof HTMLButtonElement)) return;
        stateFilter = chip.dataset.filter === 'open' ? 'open' : 'all';
        document.querySelectorAll('.chip[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === chip)));
        resetQueueFilters();
      });
    });
    queueMore?.addEventListener('click', () => refreshQueue('more'));
    document.getElementById('queue-retry')?.addEventListener('click', () => refreshQueue(queueFailedMode));
    const memberSearch = document.getElementById('member-search');
    memberSearch?.addEventListener('input', () => {
      const query = memberSearch.value.trim().toLowerCase();
      let count = 0;
      document.querySelectorAll('[data-member]').forEach(row => {
        row.hidden = !(row.dataset.member || '').toLowerCase().includes(query);
        if (!row.hidden) count++;
      });
      const empty = document.getElementById('member-empty');
      if (empty) empty.hidden = count > 0;
    });
    document.querySelectorAll('[data-open-access]').forEach(button => {
      button.addEventListener('click', () => {
        const dialog = document.getElementById(button.dataset.openAccess);
        if (dialog instanceof HTMLDialogElement) dialog.showModal();
      });
    });
    document.querySelectorAll('dialog.access-dialog').forEach(dialog => {
      const form = dialog.querySelector('form');
      const search = dialog.querySelector('[data-page-search]');
      const boxes = [...dialog.querySelectorAll('input[name="pageId"]')];
      const role = dialog.querySelector('select[name="role"]');
      const selectedOnly = dialog.querySelector('[data-selected-only]');
      const paint = () => {
        const selected = boxes.filter(box => box.checked).length;
        dialog.querySelector('[data-assigned]').textContent = '已选 ' + selected + ' / ' + boxes.length + ' 个主页／账号';
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        boxes.forEach(box => {
          const label = box.closest('label');
          label.hidden = !(label.textContent || '').toLowerCase().includes(query) || (selectedOnly.checked && !box.checked);
          if (!label.hidden) visible++;
        });
        dialog.querySelector('[data-pages-empty]').hidden = visible > 0;
        dialog.querySelector('[data-role-hint]').textContent = role.value === 'admin'
          ? '管理员可访问全部主页。下方勾选作为转为普通客服后的权限保留。'
          : '普通客服只能查看和回复已勾选主页或账号的消息。';
        dialog.querySelector('[data-pages="visible"]').disabled = visible === 0;
      };
      search.addEventListener('input', paint);
      selectedOnly.addEventListener('change', paint);
      role.addEventListener('change', paint);
      boxes.forEach(box => box.addEventListener('change', paint));
      dialog.querySelectorAll('[data-pages]').forEach(button => button.addEventListener('click', () => {
        boxes.forEach(box => {
          if (button.dataset.pages === 'none') box.checked = false;
          else if (!box.closest('label').hidden) box.checked = true;
        });
        paint();
      }));
      dialog.querySelectorAll('[data-close-access]').forEach(button => button.addEventListener('click', () => dialog.close()));
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
      });
      dialog.addEventListener('close', () => { form.reset(); paint(); });
      form.addEventListener('submit', () => {
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        submit.textContent = '正在保存…';
      });
      paint();
    });
    const auditEmpty = document.getElementById('audit-empty');
    document.querySelectorAll('.chip[data-audit]').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (!(chip instanceof HTMLButtonElement)) return;
        const wanted = chip.dataset.audit || 'all';
        document.querySelectorAll('.chip[data-audit]').forEach((item) => {
          if (item instanceof HTMLButtonElement) item.setAttribute('aria-pressed', item === chip ? 'true' : 'false');
        });
        let visible = 0;
        document.querySelectorAll('tr[data-status]').forEach((row) => {
          if (!(row instanceof HTMLElement)) return;
          row.hidden = wanted !== 'all' && row.dataset.status !== wanted;
          if (!row.hidden) visible += 1;
        });
        if (auditEmpty) auditEmpty.hidden = visible > 0;
      });
    });
    const list = document.querySelector('#comments');
    let contextToken = 0;
    const contextCache = new Map();
    function contextKey(row) {
      if (!(row instanceof HTMLElement)) return '';
      if (row.dataset.kind === 'message') return (row.dataset.platform || 'facebook') + ':message:' + (row.dataset.event || '');
      return (row.dataset.platform || 'facebook') + ':' + row.dataset.channelId + ':post:' + (row.dataset.post || row.dataset.event || '');
    }
    function setReplyTarget(name, externalId) {
      const node = document.getElementById('reply-target');
      if (!node) return;
      const who = name || '这条评论';
      node.textContent = '正在回复 ' + who;
      node.title = externalId || '';
    }
    function setStateChip(id, label) {
      const node = document.getElementById(id);
      if (!node) return;
      node.textContent = label || '';
      node.classList.toggle('state-sent', label === '已回复' || label === '已处理');
      node.classList.toggle('state-failed', label === '失败');
    }
    function focusOpenedFloor(eventId, quiet = false) {
      const floors = document.getElementById('floors');
      if (!floors || !eventId || typeof CSS === 'undefined' || !CSS.escape) return;
      const pulledTarget = form?.elements.targetId.value;
      const match = (pulledTarget ? floors.querySelector('[data-external="' + CSS.escape(pulledTarget) + '"]') : null)
        || floors.querySelector('[data-floor="' + CSS.escape(eventId) + '"]')
        || (inboxQueue === 'review' ? floors.querySelector('.floor[data-floor]') : null);
      if (!(match instanceof HTMLElement)) return;
      const nextId = match.dataset.floor || eventId;
      const targetChanged = inboxQueue === 'review' && form?.elements.eventId.value !== nextId;
      if (targetChanged) saveDraft();
      floors.querySelectorAll('.floor.current').forEach((item) => item.classList.remove('current'));
      match.classList.add('current');
      if (!quiet) match.scrollIntoView({ block: 'nearest' });
      syncComposerAvailability(match);
      showFloor(match);
      inspectVisibility(match);
      const eventInput = document.querySelector('input[name="eventId"]');
      if (eventInput instanceof HTMLInputElement) eventInput.value = nextId;
      const targetInput = document.querySelector('input[name="targetId"]');
      if (targetInput instanceof HTMLInputElement) targetInput.value = match.dataset.floor ? '' : match.dataset.external || '';
      if (targetChanged) {
        form.elements.idempotencyKey.value = crypto.randomUUID();
        clearSuggestion();
        restoreDraft();
      }
      setReplyTarget(match.dataset.name || '', match.dataset.external || '');
      syncComposerAvailability(match);
    }
    function appendRichText(parent, text, mentions) {
      const chars = Array.from(text);
      const tags = Array.isArray(mentions) ? mentions.filter((item) => item && typeof item.offset === 'number' && typeof item.length === 'number') : [];
      tags.sort((left, right) => left.offset - right.offset);
      let cursor = 0;
      for (const tag of tags) {
        const start = tag.offset;
        const end = tag.offset + tag.length;
        if (start < cursor || end > chars.length) continue;
        if (start > cursor) parent.append(chars.slice(cursor, start).join(''));
        const mark = document.createElement('mark');
        mark.className = 'mention';
        mark.textContent = chars.slice(start, end).join('');
        parent.append(mark);
        cursor = end;
      }
      if (cursor < chars.length) parent.append(chars.slice(cursor).join(''));
    }
    function setText(id, value) {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    }
    function showRow(id, value) {
      const row = document.getElementById(id);
      if (!row) return;
      const text = value || '';
      row.hidden = text.length === 0;
      const valueNode = row.querySelector('dd');
      if (valueNode) valueNode.textContent = text;
    }
    function syncComposerAvailability(floor) {
      if (!form || !replyBox) return;
      const deleted = floor?.dataset.deleted === '1';
      replyBox.disabled = deleted;
      document.getElementById('send').disabled = deleted || sending;
      document.getElementById('suggest').disabled = deleted || suggesting;
      if (deleted) setText('reply-target', '该评论已删除，草稿保留');
    }
    function showFloor(floor) {
      if (!(floor instanceof HTMLElement)) return;
      setText('dossier-who', floor.dataset.name || '评论');
      setText('dossier-sender', floor.dataset.senderId && floor.dataset.senderId !== 'unknown' ? floor.dataset.senderId : '没有');
      setText('dossier-time', floor.dataset.time || '');
      setText('dossier-state', floor.dataset.state || '未回复');
      setText('dossier-external', floor.dataset.external || '');
      showRow('dossier-reply-row', floor.dataset.replyTo || '');
    }
    function showContext(view) {
      const card = document.getElementById('post-card');
      if (card) card.hidden = view?.kind === 'message';
      if (view?.kind !== 'message') {
        const postText = view && view.postText ? view.postText : '这条帖子没有可显示的文字，可以打开原帖。';
        setText('post-text', postText);
        if (view && view.postText) {
          const full = String(view.postText).split('\\n')[0].replace(/\\s+/g, ' ').trim();
          const title = full.slice(0, 80);
          if (title) {
            setText('thread-title', title);
            const currentTitle = document.querySelector('.thread-row[aria-current="true"] .title');
            if (currentTitle) currentTitle.textContent = title;
          }
          if (full) setText('dossier-title', full);
        }
      }
      const link = document.getElementById('post-link');
      if (link instanceof HTMLAnchorElement && typeof view?.postUrl === 'string' && (['https://www.facebook.com/', 'https://www.instagram.com/', 'https://instagram.com/'].some(prefix => view.postUrl.startsWith(prefix)))) {
        link.href = view.postUrl;
        link.hidden = false;
      }
      const floors = document.getElementById('floors');
      if (!floors) return;
      floors.replaceChildren();
      const lines = (Array.isArray(view?.lines) ? view.lines : []).filter(line => inboxQueue !== 'review'
        || (!line.own && line.ruleReview?.decision === 'review' && line.ruleReview.status === 'open'));
      if (inboxQueue === 'review') {
        if (form) form.hidden = lines.length === 0;
        setStateChip('thread-state', lines.length ? '待人工 ' + lines.length : '审核已完成');
      }
      if (lines.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = inboxQueue === 'review' ? '该帖暂无待人工审核的评论。' : '这条帖子还没有收到评论。';
        floors.append(empty);
        if (inboxQueue === 'review') {
          setText('dossier-who', '没有待审核的评论');
          setText('dossier-sender', ''); setText('dossier-time', ''); setText('dossier-external', '');
          setText('dossier-state', '审核已完成'); showRow('dossier-reply-row', '');
        }
        return;
      }
      for (const line of lines) {
        const item = document.createElement('article');
        const depth = Number(line.depth || 0);
        item.className = 'floor' + (line.hidden ? ' is-hidden' : '') + (line.own ? ' own' : '') + (line.current ? ' current' : '');
        item.dataset.own = line.own ? '1' : '0';
        item.dataset.deleted = line.deleted ? '1' : '0';
        if (line.deleted) item.classList.add('is-deleted');
        if (typeof line.hidden === 'boolean') item.dataset.hidden = String(line.hidden);
        if (!line.own && !line.deleted) { item.tabIndex = 0; item.setAttribute('role', 'button'); item.setAttribute('aria-label', '回复 ' + (line.name || '这条评论')); }
        item.dataset.depth = String(Number.isFinite(depth) ? depth : 0);
        if (typeof line.id === 'string') item.dataset.floor = line.id;
        if (typeof line.name === 'string') item.dataset.name = line.name;
        if (typeof line.time === 'string') item.dataset.time = line.time;
        if (typeof line.externalId === 'string') item.dataset.external = line.externalId;
        if (typeof line.senderId === 'string') item.dataset.senderId = line.senderId;
        if (typeof line.replyTo === 'string') item.dataset.replyTo = line.replyTo;
        if (typeof line.state === 'string') item.dataset.state = line.hidden ? '已隐藏' : line.state;
        item.dataset.replyState = line.replyState || (line.state === '已隐藏' ? '未回复' : line.state) || '未回复';
        const top = document.createElement('div');
        top.className = 'floor-top';
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = typeof line.name === 'string' && line.name ? line.name : '评论';
        const time = document.createElement('time');
        time.textContent = typeof line.time === 'string' ? line.time : '';
        const currentPost = document.querySelector('.thread-row[aria-current="true"]');
        const commentUrl = view?.kind === 'comment' && typeof line.externalId === 'string'
          ? view.platform === 'instagram'
            ? instagramCommentUrl(view.postUrl || null, line.externalId, line.parentId)
            : facebookCommentUrl(view.postUrl || null, currentPost?.dataset.post || null, line.externalId)
          : null;
        if (commentUrl) {
          const source = document.createElement('a');
          source.className = 'comment-time';
          source.href = commentUrl;
          source.target = '_blank';
          source.rel = 'noopener noreferrer';
          source.title = '在 ' + (view.platform === 'instagram' ? 'Instagram' : 'Facebook') + ' 查看这条评论';
          source.setAttribute('aria-label', source.title + '，' + time.textContent);
          source.append(time);
          top.append(who, source);
        } else {
          top.append(who, time);
        }
        const status = document.createElement('span');
        status.className = 'floor-state' + (line.own || line.state === '已回复' ? ' state-sent' : '');
        status.textContent = line.deleted ? '已删除 · 本地留档' : line.own ? '我方回复' + (line.operatorName ? ' · ' + line.operatorName : '') : line.hidden ? '已隐藏' : line.state || '未回复';
        top.append(status);
        item.append(top);
        if (typeof line.replyTo === 'string' && line.replyTo) {
          const reply = document.createElement('p');
          reply.className = 'reply-to';
          reply.textContent = '回复 ' + line.replyTo;
          item.append(reply);
        }
        const body = document.createElement('p');
        appendRichText(body, typeof line.text === 'string' ? line.text : '', line.mentions);
        item.append(body);
        const bits = [];
        if (typeof line.likeCount === 'number') bits.push('赞 ' + line.likeCount);
        if (typeof line.commentCount === 'number' && line.commentCount > 0) bits.push('其下 ' + line.commentCount + ' 条');
        if (bits.length > 0) {
          const meta = document.createElement('p');
          meta.className = 'floor-meta';
          meta.textContent = bits.join(' · ');
          item.append(meta);
        }
        if (view?.kind === 'comment' && !line.own) {
          const actions = document.createElement('div'); actions.className = 'floor-actions';
          const button = document.createElement('button'); button.type = 'button'; button.dataset.moderate = '1';
          button.textContent = line.hidden ? '取消隐藏' : '隐藏';
          button.title = '修改源平台的评论可见性';
          const note = document.createElement('span'); note.className = 'visibility-note'; note.setAttribute('role', 'status');
          if (line.hidden) note.textContent = '已隐藏 · 工作台保留记录';
          const meta = item.querySelector('.floor-meta');
          if (meta) actions.append(meta);
          if (!line.deleted) actions.append(button);
          if (line.actions) {
            const add = (action, label, enabled, title) => {
              const control = document.createElement('button'); control.type = 'button'; control.dataset.commentAction = action;
              control.textContent = label; control.disabled = !enabled; control.title = title;
              if (action === 'like' || action === 'unlike') control.setAttribute('aria-pressed', String(line.actions.liked));
              return control;
            };
            const more = document.createElement('details'); more.className = 'floor-more';
            const summary = document.createElement('summary'); summary.textContent = '更多';
            const menu = document.createElement('div'); menu.className = 'floor-more-menu';
            more.append(summary, menu);
            if (!line.deleted) actions.append(add(line.actions.liked ? 'unlike' : 'like', line.actions.liked ? '已点赞' : '点赞', line.actions.canLike,
              line.actions.canLike ? '以当前主页身份点赞，再次点击取消' : '需要管理员补充评论操作授权'));
            if (!line.deleted) menu.append(add('delete', '删除评论', line.actions.canDelete, line.actions.canDelete ? '永久删除源平台评论，本地保留记录' : '需要管理员补充删除评论权限'));
            if (!line.deleted && !line.actions.liked) menu.append(add('unlike', '取消我方点赞', line.actions.canLike, '也可取消在官方客户端点过的赞'));
            menu.append(add(line.actions.blocked ? 'unblock' : 'block', line.actions.blocked ? '取消屏蔽用户' : '屏蔽用户', line.actions.canBlock,
              line.actions.canBlock ? '限制此用户与当前主页互动' : '仅支持已有私信且能确认身份的用户；其他用户请在官方平台操作'));
            if (!line.actions.blocked) menu.append(add('unblock', '取消屏蔽用户', line.actions.canBlock, '也可解除在官方客户端设置的屏蔽'));
            actions.append(more);
          }
          actions.append(note); item.append(actions);
        }
        if (line.ruleReview && !line.own && !line.deleted) {
          const review = line.ruleReview;
          const panel = document.createElement('div'); panel.className = 'rule-review';
          const heading = document.createElement('div'); heading.className = 'rule-review-title';
          const name = document.createElement('strong'); name.textContent = review.ruleName || '评论规则'; heading.append(name);
          const state = document.createElement('span'); state.className = 'rule-review-status';
          state.textContent = ruleReviewLabel(review); heading.append(state);
          if (review.decision === 'review' && review.status === 'open' && line.id) {
            const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.dataset.dismissReview = line.id; dismiss.textContent = '无需处理';
            dismiss.title = '从人工审核移除，保留评论，不发送回复'; heading.append(dismiss);
          }
          const reason = document.createElement('p'); reason.textContent = review.reason || ''; panel.append(heading, reason); item.append(panel);
        }
        if (view?.kind === 'message' && !line.own && line.id) {
          const actions = document.createElement('div'); actions.className = 'floor-actions';
          const choices = document.querySelector('.workspace')?.dataset.platform === 'instagram' ? ['❤️'] : ['❤️','👍','😊','😂','😮','😢','🎉'];
          let currentReaction = line.reaction || '';
          const note = document.createElement('span'); note.setAttribute('role', 'status');
          for (const emoji of choices) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji;
            button.setAttribute('aria-label', '回应 ' + emoji + '，再次点击取消');
            button.setAttribute('aria-pressed', String(currentReaction === emoji));
            button.addEventListener('click', async (event) => {
              event.stopPropagation();
              const buttons = [...actions.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
              note.textContent = '发送中…';
              try {
                const response = await fetch('/inbox/workbench/react', { method: 'POST', headers: { Accept: 'application/json' },
                  body: new URLSearchParams({ eventId: line.id, reaction: currentReaction === emoji ? '' : emoji }) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || '表情回应失败。');
                currentReaction = result.reaction;
                buttons.forEach(b => b.setAttribute('aria-pressed', String(b.textContent === currentReaction)));
                contextCache.clear(); note.textContent = currentReaction ? '我方已回应' : '已取消回应';
              } catch (error) { note.textContent = error.message || '请求失败，请重试。'; }
              finally { buttons.forEach(b => b.disabled = false); }
            });
            actions.append(button);
          }
          actions.append(note); item.append(actions);
        }
        floors.append(item);
      }
      const current = floors.querySelector('.floor.current') || floors.querySelector('.floor');
      if (current instanceof HTMLElement) showFloor(current);
    }
    async function loadContext(eventId, key, quiet) {
      const cached = key ? contextCache.get(key) : undefined;
      const token = ++contextToken;
      if (cached && !quiet) { showContext(cached); focusOpenedFloor(eventId); }
      if (!cached) {
        stage?.classList.add('is-loading');
        setText('post-text', '正在读取帖子…');
      }
      try {
        const response = await fetch('/inbox/workbench/context?event=' + encodeURIComponent(eventId) + '&queue=' + inboxQueue, { headers: { Accept: 'application/json' } });
        if (!response.ok || token !== contextToken) return;
        const view = await response.json();
        if (token !== contextToken) return;
        if (key) contextCache.set(key, view);
        const scroller = document.querySelector('.transcript');
        const scrollTop = scroller?.scrollTop || 0;
        showContext(view);
        focusOpenedFloor(quiet ? form?.elements.eventId.value || eventId : eventId, quiet);
        if (quiet && scroller) scroller.scrollTop = scrollTop;
      } catch {
        if (token === contextToken && !cached) setText('post-text', '帖子内容暂时没有取到。');
      } finally {
        if (token === contextToken) stage?.classList.remove('is-loading');
      }
    }
    function select(row, push) {
      if (!(row instanceof HTMLAnchorElement) || !row.dataset.event || !document.getElementById('floors')) return;
      document.querySelectorAll('.thread-row[aria-current="true"]').forEach((item) => item.removeAttribute('aria-current'));
      saveDraft();
      clearNotice();
      row.setAttribute('aria-current', 'true');
      document.querySelector('.workspace')?.classList.add('has-selection');
      syncComposerAvailability(null);
      if (savedPicker) savedPicker.open = false;
      setText('thread-title', row.dataset.title || (row.dataset.kind === 'message' ? '私信' : '帖子'));
      setText('thread-kicker', (row.dataset.platform === 'instagram' ? 'Instagram · @' : 'Facebook · ') + (row.dataset.channel || ''));
      setText('reply-identity', '回复身份：' + (row.dataset.platform === 'instagram' ? 'Instagram · @' : 'Facebook · ') + (row.dataset.channel || row.dataset.channelId || ''));
      setStateChip('thread-state', row.dataset.state || '未回复');
      setReplyTarget(row.dataset.sender || (row.dataset.kind === 'message' ? '这条私信' : '这条评论'), row.dataset.external || '');
      setText('dossier-page', row.dataset.channel || '');
      setText('dossier-title', row.dataset.title || '');
      showRow('dossier-title-row', row.dataset.kind === 'message' ? '' : (row.dataset.title || '帖子'));
      showRow('dossier-post-row', row.dataset.kind === 'message' ? '' : (row.dataset.post || ''));
      setText('dossier-channel', row.dataset.channelId || '');
      setText('dossier-who', row.dataset.sender || (row.dataset.kind === 'message' ? '私信' : '评论'));
      setText('dossier-sender', row.dataset.senderId || '');
      setText('dossier-time', row.dataset.time || '');
      setText('dossier-state', row.dataset.state || '未回复');
      setText('dossier-external', row.dataset.external || '');
      const externalLabel = document.getElementById('dossier-external-label');
      if (externalLabel) externalLabel.textContent = row.dataset.kind === 'message' ? '私信编号' : '评论编号';
      showRow('dossier-reply-row', '');
      const eventInput = document.querySelector('input[name="eventId"]');
      if (eventInput instanceof HTMLInputElement) eventInput.value = row.dataset.event;
      const targetInput = document.querySelector('input[name="targetId"]');
      if (targetInput instanceof HTMLInputElement) targetInput.value = '';
      const key = document.querySelector('input[name="idempotencyKey"]');
      if (key instanceof HTMLInputElement && push) key.value = crypto.randomUUID();
      clearSuggestion();
      if (replyBox instanceof HTMLTextAreaElement && push) {
        restoreDraft();
        replyBox.maxLength = row.dataset.platform === 'instagram' ? (row.dataset.kind === 'message' ? 1000 : 2200) : (row.dataset.kind === 'message' ? 2000 : 8000);
        replyBox.placeholder = row.dataset.kind === 'message'
          ? '写一条私信。Enter 发送，Shift + Enter 换行。'
          : '写一条公开回复。Enter 发送，Shift + Enter 换行。';
      }
      document.getElementById('post-text')?.classList.remove('expanded');
      const togglePost = document.getElementById('toggle-post');
      if (togglePost) { togglePost.setAttribute('aria-expanded', 'false'); togglePost.textContent = '展开正文'; }
      const card = document.getElementById('post-card');
      if (card) card.hidden = row.dataset.kind === 'message';
      const postLink = document.getElementById('post-link');
      if (postLink instanceof HTMLAnchorElement) {
        if (row.dataset.post && row.dataset.platform !== 'instagram') {
          postLink.href = 'https://www.facebook.com/' + row.dataset.post;
          postLink.hidden = false;
        } else {
          postLink.hidden = true;
        }
      }
      if (push) history.pushState({ event: row.dataset.event }, '', syncFilterUrl(new URL(row.href)));
      loadContext(row.dataset.event, contextKey(row));
    }
    function paintVisibility(floor, result) {
      floor.dataset.hidden = String(result.hidden);
      floor.classList.toggle('is-hidden', result.hidden);
      const button = floor.querySelector('[data-moderate]');
      if (button) { button.textContent = result.hidden ? '取消隐藏' : '隐藏'; button.disabled = !result.canHide; }
      const note = floor.querySelector('.visibility-note');
      if (note) note.textContent = result.hidden ? '已隐藏 · 工作台保留记录' : result.canHide ? '' : '平台不允许隐藏此评论';
      if (!floor.dataset.replyState) floor.dataset.replyState = floor.dataset.state || '未回复';
      floor.dataset.state = result.hidden ? '已隐藏' : floor.dataset.replyState;
      if (typeof result.liked === 'boolean') {
        const like = floor.querySelector('.floor-actions > [data-comment-action="like"],.floor-actions > [data-comment-action="unlike"]');
        if (like) { like.textContent = result.liked ? '已点赞' : '点赞'; like.dataset.commentAction = result.liked ? 'unlike' : 'like'; like.setAttribute('aria-pressed', String(result.liked)); }
      }
      const state = floor.querySelector('.floor-state');
      if (state) state.textContent = floor.dataset.state;
      if (floor.classList.contains('current')) showFloor(floor);
    }
    async function moderateFloor(floor, action) {
      const row = document.querySelector('.thread-row[aria-current="true"]');
      if (!row || !floor.dataset.external || floor.dataset.own === '1' || floor.dataset.deleted === '1') return;
      const isLocal = floor.dataset.floor && !floor.dataset.floor.startsWith('reply:');
      const response = await fetch('/inbox/workbench/moderate', {
        method: 'POST', headers: { Accept: 'application/json' },
        body: new URLSearchParams({ eventId: isLocal ? floor.dataset.floor : row.dataset.event,
          targetId: isLocal ? '' : floor.dataset.external, action }),
      });
      const result = await response.json();
      if (!response.ok || result.status !== 'ok') throw new Error(result.message || '平台未确认操作，请重试。');
      return result;
    }
    async function inspectVisibility(floor) {
      if (!floor.querySelector('[data-moderate]') || floor.dataset.inspectBusy === '1') return;
      floor.dataset.inspectBusy = '1';
      const revision = floor.dataset.visibilityRevision || '0';
      try {
        const result = await moderateFloor(floor, 'inspect');
        if (floor.isConnected && result && floor.dataset.moderating !== '1' && (floor.dataset.visibilityRevision || '0') === revision) { paintVisibility(floor, result); refreshQueue(); }
      } catch { /* The explicit action displays any permission or network error. */ }
      finally { delete floor.dataset.inspectBusy; }
    }
    document.getElementById('floors')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-dismiss-review]');
      if (!button) return;
      event.stopPropagation();
      if (button.disabled) return;
      const active = document.querySelector('.thread-row[aria-current="true"]');
      button.disabled = true; button.textContent = '保存中…';
      try {
        const response = await fetch('/inbox/review/resolve', { method:'POST', headers:{Accept:'application/json'},
          body:new URLSearchParams({eventId:button.dataset.dismissReview, resolution:'no_action'}) });
        const result = await response.json();
        if (!response.ok || result.status !== 'ok') throw new Error(result.message || '标记失败，请重试。');
        contextCache.clear();
        if (active && active === document.querySelector('.thread-row[aria-current="true"]')) {
          await loadContext(form.elements.eventId.value || active.dataset.event, contextKey(active), true);
          notifyReply('已标记无需处理，评论保留', true);
        }
        await refreshQueue();
      } catch (error) { button.disabled = false; button.textContent = '无需处理'; notifyReply(error.message || '标记失败，请重试。', false); }
    });
    document.getElementById('floors')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-comment-action]');
      if (!button || button.disabled) return;
      event.stopPropagation();
      const floor = button.closest('.floor');
      const active = document.querySelector('.thread-row[aria-current="true"]');
      if (!floor || !active || floor.dataset.moderating === '1') return;
      const action = button.dataset.commentAction;
      if (floor.dataset.deleted === '1' && action !== 'block' && action !== 'unblock') return;
      if (action === 'delete' && !confirm('永久删除这条源评论？此操作无法撤销，本地会保留记录。\\n\\n' + (floor.querySelector('p:not(.reply-to)')?.textContent || '').slice(0, 160))) return;
      if (action === 'block' && !confirm('屏蔽此用户与当前主页／账号的互动？现有评论不会因此自动删除。Instagram 屏蔽还会限制对方查看账号内容。')) return;
      const controls = [...floor.querySelectorAll('button')].map(control => [control, control.disabled]);
      controls.forEach(([control]) => control.disabled = true);
      floor.dataset.moderating = '1';
      const note = floor.querySelector('.visibility-note'); if (note) note.textContent = '处理中…';
      try {
        const local = floor.dataset.floor && !floor.dataset.floor.startsWith('reply:');
        const response = await fetch('/inbox/workbench/comment-action', { method:'POST', headers:{Accept:'application/json'},
          body:new URLSearchParams({ eventId:local ? floor.dataset.floor : active.dataset.event,
            targetId:local ? '' : floor.dataset.external, action }) });
        const result = await response.json();
        if (!response.ok || result.status !== 'ok') throw new Error(result.message || '平台未确认操作成功。');
        contextCache.clear();
        if (action === 'like' || action === 'unlike') {
          button.dataset.commentAction = action === 'like' ? 'unlike' : 'like';
          button.textContent = action === 'like' ? '已点赞' : '点赞'; button.setAttribute('aria-pressed', String(action === 'like'));
          if (active === document.querySelector('.thread-row[aria-current="true"]')) await loadContext(form.elements.eventId.value || active.dataset.event, contextKey(active), true);
          if (note) note.textContent = action === 'like' ? '我方已点赞' : '已取消点赞';
        } else if (active === document.querySelector('.thread-row[aria-current="true"]')) {
          await loadContext(form.elements.eventId.value || active.dataset.event, contextKey(active), true);
          notifyReply(action === 'delete' ? '评论已删除，本地记录保留' : action === 'block' ? '已屏蔽该用户' : '已取消屏蔽该用户', true);
        }
        await refreshQueue();
      } catch (error) { if (note) note.textContent = error.message || '请求失败，请重试。'; }
      finally { delete floor.dataset.moderating; controls.forEach(([control, disabled]) => control.disabled = disabled); }
    });
    document.getElementById('floors')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-moderate]');
      if (!button) return;
      event.stopPropagation();
      const floor = button.closest('.floor');
      if (!floor || floor.dataset.moderating === '1') return;
      floor.dataset.visibilityRevision = String(Number(floor.dataset.visibilityRevision || 0) + 1);
      floor.dataset.moderating = '1'; button.disabled = true;
      const action = floor.dataset.hidden === 'true' ? 'show' : 'hide';
      const active = document.querySelector('.thread-row[aria-current="true"]');
      button.textContent = '处理中…';
      const note = floor.querySelector('.visibility-note');
      try {
        const result = await moderateFloor(floor, action);
        if (result && floor.isConnected) paintVisibility(floor, result);
        contextCache.clear();
        if (inboxQueue === 'review' && active && active === document.querySelector('.thread-row[aria-current="true"]')) {
          await loadContext(form.elements.eventId.value || active.dataset.event, contextKey(active), true);
        }
        await refreshQueue();
      } catch (error) {
        if (note) note.textContent = error.message;
        button.textContent = floor.dataset.hidden === 'true' ? '取消隐藏' : '隐藏'; button.disabled = false;
      } finally { delete floor.dataset.moderating; }
    });
    document.getElementById('floors')?.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a,button,summary,details')) return;
      const floor = event.target instanceof Element ? event.target.closest('[data-external]') : null;
      if (!(floor instanceof HTMLElement) || !floor.dataset.external || floor.dataset.own === '1' || floor.dataset.deleted === '1') return;
      saveDraft();
      clearNotice();
      document.querySelectorAll('.floor.current').forEach((item) => item.classList.remove('current'));
      floor.classList.add('current');
      syncComposerAvailability(floor);
      showFloor(floor);
      inspectVisibility(floor);
      const eventInput = document.querySelector('input[name="eventId"]');
      const targetInput = document.querySelector('input[name="targetId"]');
      if (floor.dataset.floor && eventInput instanceof HTMLInputElement) {
        eventInput.value = floor.dataset.floor;
        if (targetInput instanceof HTMLInputElement) targetInput.value = '';
      } else if (targetInput instanceof HTMLInputElement) {
        targetInput.value = floor.dataset.external;
      }
      const key = document.querySelector('input[name="idempotencyKey"]');
      if (key instanceof HTMLInputElement) key.value = crypto.randomUUID();
      clearSuggestion();
      restoreDraft();
      setReplyTarget(floor.dataset.name || '这条评论', floor.dataset.external || '');
    });
    document.getElementById('floors')?.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.floor[role="button"]')) { event.preventDefault(); event.target.click(); }
    });
    document.getElementById('toggle-post')?.addEventListener('click', event => {
      const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true';
      event.currentTarget.setAttribute('aria-expanded', String(expanded));
      event.currentTarget.textContent = expanded ? '收起正文' : '展开正文';
      document.getElementById('post-text')?.classList.toggle('expanded', expanded);
    });
    list?.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('a.thread-row') : null;
      if (!document.getElementById('floors') || !(target instanceof HTMLAnchorElement) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      select(target, true);
    });
    window.addEventListener('popstate', () => {
      const id = new URLSearchParams(location.search).get('event');
      const row = id ? document.getElementById('c-' + id) : null;
      if (row instanceof HTMLAnchorElement) select(row, false);
    });
    syncComposerAvailability(document.querySelector('.floor.current'));
    const opened = document.querySelector('.thread-row[aria-current="true"]');
    if (opened instanceof HTMLAnchorElement && opened.dataset.event) loadContext(form?.elements.eventId.value || opened.dataset.event, contextKey(opened));
    else if (inboxQueue === 'review' && form?.elements.eventId.value) loadContext(form.elements.eventId.value, '');
    applyFilter();
    if (list) setInterval(async () => {
      if (document.hidden) return;
      await refreshQueue();
      const active = document.querySelector('.thread-row[aria-current="true"]');
      if (active && form && !sending && !document.querySelector('.floor[data-moderating="1"]')) {
        await loadContext(form.elements.eventId.value || active.dataset.event, contextKey(active), true);
      }
    }, 15000);
    if (list && window.EventSource) {
      const source = new EventSource('/inbox/workbench/events');
      source.addEventListener('comment', (event) => {
        const row = JSON.parse(event.data);
        if ((row.platform || 'facebook') !== inboxPlatform) return;
        refreshQueue();
        const active = document.querySelector('.thread-row[aria-current="true"]');
        if (active?.dataset.channelId === row.channelId && active.dataset.platform === (row.platform || 'facebook')
          && (row.kind === 'message' ? active.dataset.kind === 'message' && active.dataset.senderId === row.senderId
            : active.dataset.kind !== 'message' && active.dataset.post === row.postId)) {
          loadContext(form?.elements.eventId.value || active.dataset.event, contextKey(active), true);
        }
      });
    }
  </script>
</body>
</html>`;
}

function sameThread(left: InboxComment, right: InboxComment): boolean {
  if ((left.platform ?? 'facebook') !== (right.platform ?? 'facebook')) return false;
  if (left.kind === 'message' || right.kind === 'message') {
    return left.kind === 'message' && right.kind === 'message' && left.channelId === right.channelId && left.senderId === right.senderId;
  }
  return left.channelId === right.channelId && left.postId !== null && left.postId === right.postId;
}

function floorHtml(item: InboxComment, currentId: string, note: { depth: number; replyTo: string | null; text?: string }): string {
  const name = item.senderName || (item.kind === 'message' ? '私信' : '评论');
  const depth = note.depth;
  const replyTo = note.replyTo;
  const label = replyTo ? `回复 ${replyTo}` : '';
  const text = note.text?.trim() || item.body || '（没有文字）';
  const commentUrl = item.platform !== 'instagram' && item.kind === 'comment' ? facebookCommentUrl(null, item.postId, item.externalId) : null;
  const time = `<time datetime="${escapeHtml(item.occurredAt.toISOString())}">${escapeHtml(when(item.occurredAt))}</time>`;
  const timestamp = commentUrl
    ? `<a class="comment-time" href="${escapeHtml(commentUrl)}" target="_blank" rel="noopener noreferrer" title="在 Facebook 查看这条评论" aria-label="在 Facebook 查看这条评论，${escapeHtml(when(item.occurredAt))}">${time}</a>`
    : time;
  return `<article class="floor${item.isOwn ? ' own' : ''}${item.id === currentId ? ' current' : ''}" data-deleted="${item.deleted ? '1' : '0'}" data-own="${item.isOwn ? '1' : '0'}"${item.isOwn ? '' : ' tabindex="0" role="button"'} data-depth="${depth}" data-floor="${escapeHtml(item.id)}" data-name="${escapeHtml(name)}" data-sender-id="${escapeHtml(item.senderId)}" data-time="${escapeHtml(when(item.occurredAt))}" data-external="${escapeHtml(item.externalId)}" data-state="${escapeHtml(stateLabel({ ...item, pendingCount: undefined }))}"${replyTo ? ` data-reply-to="${escapeHtml(replyTo)}"` : ''}>
    <div class="floor-top"><span class="who">${escapeHtml(name)}</span>${timestamp}<span class="floor-state${item.isOwn || item.replyStatus === 'sent' ? ' state-sent' : ''}">${item.isOwn ? `我方回复${item.operatorName ? ` · ${escapeHtml(item.operatorName)}` : ''}` : escapeHtml(stateLabel({ ...item, pendingCount: undefined }))}</span></div>
    ${label ? `<p class="reply-to">${escapeHtml(label)}</p>` : ''}
    <p>${escapeHtml(text)}</p>
    ${item.ruleReview && !item.isOwn ? `<div class="rule-review"><div class="rule-review-title"><strong>${escapeHtml(item.ruleReview.ruleName)}</strong><span class="rule-review-status">${escapeHtml(ruleReviewLabel(item.ruleReview))}</span>${item.ruleReview.decision === 'review' && item.ruleReview.status === 'open' ? `<button type="button" data-dismiss-review="${escapeHtml(item.id)}" title="从人工审核移除，保留评论，不发送回复">无需处理</button>` : ''}</div><p>${escapeHtml(item.ruleReview.reason)}</p></div>` : ''}
  </article>`;
}

function commentRow(comment: InboxComment, selected: boolean, queue: InboxQueue = 'all'): string {
  const state = queue === 'review' ? `待人工 ${comment.threadCount}` : queue === 'rule_hidden' ? '规则已隐藏' : queue === 'dismissed' ? '无需处理' : stateLabel(comment);
  const current = selected ? ' aria-current="true"' : '';
  const stateClass = comment.pendingCount === 0 ? ' state-sent' : '';
  const post = comment.postId ? ` data-post="${escapeHtml(comment.postId)}"` : '';
  const sender = comment.senderName ? ` data-sender="${escapeHtml(comment.senderName)}"` : '';
  const title = comment.kind === 'message' ? '私信' : (comment.postTitle || '帖子');
  const who = comment.senderName || (comment.kind === 'message' ? '私信' : '评论');
  const kind = comment.kind === 'message' ? '私信' : '评论';
  return `<a class="thread-row" id="c-${escapeHtml(comment.id)}" href="/inbox/workbench/${comment.platform ?? 'facebook'}?event=${escapeHtml(comment.id)}&amp;queue=${queue}" data-ad-source="${comment.adSource === true}" data-event="${escapeHtml(comment.id)}" data-kind="${comment.kind}" data-platform="${comment.platform ?? 'facebook'}" data-title="${escapeHtml(title)}" data-channel="${escapeHtml(comment.channelName)}" data-channel-id="${escapeHtml(comment.channelId)}" data-sender-id="${escapeHtml(comment.senderId)}" data-external="${escapeHtml(comment.externalId)}" data-body="${escapeHtml(comment.body || '（没有文字）')}" data-time="${escapeHtml(when(comment.occurredAt))}" data-pending="${comment.pendingCount ?? (comment.replyStatus === 'sent' ? 0 : 1)}" data-state="${escapeHtml(state)}"${sender}${post}${current}>
    <span class="row-main">
      <span class="title">${escapeHtml(title)}</span>
      ${comment.kind === 'comment' && comment.postId ? `<span class="post-id">${escapeHtml(comment.postId)}</span>` : ''}
      <span class="preview">${escapeHtml(when(comment.occurredAt, 'short'))} · ${escapeHtml(comment.channelName)} · ${escapeHtml(who)}：${escapeHtml(comment.body || '（没有文字）')}</span>
    </span>
    <span class="row-meta">
      <span class="badge">${comment.platform === 'instagram' ? 'Instagram' : 'Facebook'} · ${kind}</span>
      <span class="tally">${comment.threadCount} 条${comment.kind === 'message' ? '消息' : '评论'}</span>
      <span class="state${stateClass}">${escapeHtml(state)}</span>
    </span>
  </a>`;
}

export function renderWorkbench(view: WorkbenchView): string {
  const inboxPage = view.inboxPage ?? { total: view.comments.length, hasMore: false, nextCursor: null, endCursor: null };
  const inboxFilters = view.inboxFilters ?? {};
  const selected = view.selected;
  const platform = view.platform ?? selected?.platform ?? 'facebook';
  const items = view.comments.map((comment) => commentRow(
    comment,
    selected ? sameThread(comment, selected) || comment.id === selected.id : false,
    view.queue ?? 'all',
  )).join('');
  const summary = selected ? view.comments.find(item => sameThread(item, selected)) ?? selected : null;
  const reviewOnly = view.queue === 'review';
  const threadItems = reviewOnly ? (view.thread ?? (selected ? [selected] : []))
    : view.thread && view.thread.length > 0 ? view.thread : selected ? [selected] : [];
  const presented = presentThread(reviewOnly ? threadItems.filter(item => !item.isOwn && item.kind === 'comment'
    && item.ruleReview?.decision === 'review' && item.ruleReview.status === 'open') : threadItems);
  const notes = presented.notes;
  const floors = selected
    ? presented.ordered.map((item) => floorHtml(item, selected.id, notes.get(item.id) ?? { depth: 0, replyTo: null, text: item.body })).join('')
    : '';
  const kicker = selected ? (selected.platform === 'instagram' ? 'Instagram · @' : 'Facebook · ') + selected.channelName : '';
  const heading = selected ? (selected.kind === 'message' ? '私信' : (selected.postTitle || '帖子')) : '';
  const placeholder = selected?.kind === 'message'
    ? '写一条私信。Enter 发送，Shift + Enter 换行。'
    : '写一条公开回复。Enter 发送，Shift + Enter 换行。';
  const selectedNote = selected ? notes.get(selected.id) : undefined;
  const replyLabel = selectedNote?.replyTo ? `回复 ${selectedNote.replyTo}` : '';
  const who = selected ? (selected.senderName || (selected.kind === 'message' ? '私信' : '评论')) : '';
  const thread = selected
    ? `<header class="thread-head">
        <div>
          <a class="back" href="/inbox/workbench/${platform}?list=1">返回列表</a>
          <p class="thread-channel" id="thread-kicker">${escapeHtml(kicker)}</p>
          <h2 id="thread-title">${escapeHtml(heading)}</h2>
        </div>
        <span class="state${summary?.pendingCount === 0 ? ' state-sent' : ''}" id="thread-state">${escapeHtml(stateLabel(summary!))}</span>
      </header>
      <section class="post-card" id="post-card"${selected.kind === 'message' ? ' hidden' : ''}>
        <div class="post-tools"><span>原帖</span><button type="button" id="toggle-post" aria-expanded="false" aria-controls="post-text">展开正文</button></div>
        <p id="post-text">${selected.kind === 'message' ? '' : '正在读取帖子…'}</p>
        ${selected.postId && selected.platform !== 'instagram' ? `<a id="post-link" href="https://www.facebook.com/${escapeHtml(selected.postId)}" target="_blank" rel="noopener noreferrer">打开原帖</a>` : '<a id="post-link" hidden target="_blank" rel="noopener noreferrer">打开原帖</a>'}
      </section>
      <div class="transcript">
        <div class="floors" id="floors">${floors || (reviewOnly ? '<p class="empty">该帖暂无待人工审核的评论。</p>' : '')}</div>

      </div>
      <form id="reply-form" class="composer" method="post" action="/inbox/workbench/reply"${reviewOnly && presented.ordered.length === 0 ? ' hidden' : ''}>

        <input type="hidden" name="eventId" value="${escapeHtml(selected.id)}">
        <input type="hidden" name="targetId" value="">
        <input type="hidden" name="idempotencyKey" value="${escapeHtml(pageNonce())}">
        <input type="hidden" name="suggestionId" value="">
        <label class="sr" for="reply-text">回复</label>
        <div class="reply-heading"><p class="reply-identity" id="reply-identity">回复身份：${escapeHtml(kicker)}</p><p id="reply-target" class="reply-target">正在回复 ${escapeHtml(who)}</p></div>
        <textarea id="reply-text" name="text" maxlength="${selected.platform === 'instagram' ? (selected.kind === 'message' ? 1000 : 2200) : (selected.kind === 'message' ? 2000 : 8000)}" required placeholder="${placeholder}"></textarea>
        <div class="composer-actions">
          <details class="emoji-picker"><summary aria-label="插入表情">☺ 表情</summary><div class="emoji-grid">${['😊','❤️','👍','🙏','🎉','😂','😍','🥰','✨','👋','🤝','💯','🔥','✅','📦','💕','😮','😢','🙌','🌹'].map(emoji => `<button type="button" data-insert-emoji="${emoji}" aria-label="插入 ${emoji}">${emoji}</button>`).join('')}</div></details>
          <details class="saved-picker"><summary aria-label="选择快捷话术">快捷话术</summary><div class="saved-picker-panel"><p>选择话术填入当前回复，可继续修改。</p><label class="sr" for="saved-search">搜索话术</label><input id="saved-search" type="search" maxlength="200" placeholder="搜索标题或内容"><div class="saved-picker-list" id="saved-picker-list"></div><p class="saved-picker-status" id="saved-picker-status" role="status"></p>${view.staff.role === 'admin' ? '<a href="/inbox/admin/saved-replies" target="_blank" rel="noopener">管理话术</a>' : ''}</div></details>
          <p id="suggest-note" class="suggest-note" role="status" hidden></p>
          <button id="suggest" class="ghost" type="button">生成建议</button>
          <button id="send" class="primary" type="submit">发送</button>
        </div>
      </form>`
    : `<div class="thread-head"><div><p class="kicker">收件</p><h2>消息</h2></div></div><p class="empty">从左边选择一条消息。</p>`;
  const dossier = selected
    ? `<aside class="dossier">
        <p class="kicker" id="dossier-kicker">${selected.kind === 'message' ? '这条私信' : '当前这条'}</p>
        <h2 id="dossier-page">${escapeHtml(selected.channelName)}</h2>
        <dl>
          <div id="dossier-title-row"${selected.kind === 'message' ? ' hidden' : ''}><dt>帖子</dt><dd id="dossier-title">${escapeHtml(heading)}</dd></div>
          <div id="dossier-post-row"${selected.kind === 'message' || !selected.postId ? ' hidden' : ''}><dt>帖子编号</dt><dd id="dossier-post">${escapeHtml(selected.postId ?? '')}</dd></div>
          <div><dt>主页编号</dt><dd id="dossier-channel">${escapeHtml(selected.channelId)}</dd></div>
          <div><dt>来自</dt><dd id="dossier-who">${escapeHtml(who)}</dd></div>
          <div><dt>发送人编号</dt><dd id="dossier-sender">${escapeHtml(selected.senderId)}</dd></div>
          <div><dt>北京时间</dt><dd><time id="dossier-time">${escapeHtml(when(selected.occurredAt))}</time></dd></div>
          <div id="dossier-reply-row"${replyLabel ? '' : ' hidden'}><dt>回复对象</dt><dd id="dossier-reply">${escapeHtml(selectedNote?.replyTo ?? '')}</dd></div>
          <div><dt>状态</dt><dd id="dossier-state">${escapeHtml(stateLabel(selected))}</dd></div>
          <div><dt id="dossier-external-label">${selected.kind === 'message' ? '私信编号' : '评论编号'}</dt><dd id="dossier-external">${escapeHtml(selected.externalId)}</dd></div>
        </dl>
      </aside>`
    : '<aside class="dossier"><p class="kicker">当前这条</p><p class="hint">在帖子里点一条评论，这里换成那一条的信息。</p></aside>';
  const notice = view.notice ? `<p class="notice reply-notice${view.notice === '已发送。' ? ' success' : ' failure'}" role="status">${escapeHtml(view.notice)}</p>` : '';
  return shell({
    title: '收件',
    nonce: view.nonce,
    staff: view.staff,
    section: platform === 'instagram' ? 'instagram' : 'comments',
    body: `<div data-platform="${platform}" data-queue="${view.queue ?? 'all'}" class="workspace${selected && !view.focusList ? ' has-selection' : ''}">
      <section class="queue" aria-label="收件">
        <div class="list-head"><div><h2>${platform === 'instagram' ? 'Instagram' : 'Facebook'} 收件箱</h2></div><span class="count" id="queue-count" title="符合当前筛选的会话总数">${inboxPage.total}</span></div>
        <div class="chips" role="group" aria-label="筛选状态">
          <button type="button" class="chip" data-filter="all" aria-pressed="${inboxFilters.state !== 'open'}">全部</button>
          <button type="button" class="chip" data-filter="open" aria-pressed="${inboxFilters.state === 'open'}">待处理</button>
        </div>
        <div class="review-category"><span id="review-category-label">处理分类</span><div class="review-category-buttons" role="group" aria-labelledby="review-category-label">${([
          ['all', '全部消息'], ['review', '人工审核'], ['rule_hidden', '规则隐藏'], ['dismissed', '无需处理'],
        ] as const).map(([value, label]) => `<button type="button" class="chip" data-queue-filter="${value}" aria-pressed="${(view.queue ?? 'all') === value}">${label}</button>`).join('')}</div></div>
        <div class="inbox-categories"><label>消息类型<select id="kind-filter"><option value="all">评论和私信</option><option value="comment"${inboxFilters.kind === 'comment' ? ' selected' : ''}>评论</option><option value="message"${inboxFilters.kind === 'message' ? ' selected' : ''}>私信</option></select></label><label>广告来源<select id="source-filter" title="按平台回传的广告来源识别；未识别不代表自然流量"><option value="all">全部来源</option><option value="ads">广告引流私信</option><option value="unknown">未识别广告来源</option></select></label></div>
        <label class="filter"><span class="sr">搜索主页或全部历史消息</span><input id="filter" type="search" maxlength="200" value="${escapeHtml(inboxFilters.q ?? '')}" placeholder="搜索主页或全部历史消息"></label>
        <div class="rows" id="comments">${items || '<p class="empty" id="empty">还没有可看的消息。</p>'}<p class="empty" id="filter-empty" hidden>没有符合的消息。</p></div>
        <div class="queue-footer" id="queue-footer" data-total="${inboxPage.total}" data-has-more="${inboxPage.hasMore}" data-next-cursor="${escapeHtml(inboxPage.nextCursor ?? '')}" data-end-cursor="${escapeHtml(inboxPage.endCursor ?? '')}">
          <div class="queue-pagination"><span id="queue-progress" role="status">${inboxPage.total === 0 ? '没有符合的会话' : inboxPage.hasMore ? `已显示 ${view.comments.length} / ${inboxPage.total} 个会话` : `已显示全部 ${inboxPage.total} 个会话`}</span><button type="button" id="queue-more"${inboxPage.hasMore ? '' : ' hidden'}>加载更多</button></div>
          <p class="queue-error" id="queue-error" hidden>加载失败，保留上一次结果。<button type="button" id="queue-retry">重试</button></p>
        </div>
      </section>
      <section class="stage">${notice}${thread}</section>
      ${dossier}
    </div>`,
  });
}

export function adminTabs(current: 'members' | 'rules' | 'saved-replies' | 'audit'): string {
  return `<div class="admin-tabs" role="navigation" aria-label="管理页面">${([
    ['members', '/inbox/admin', '成员与权限'],
    ['rules', '/inbox/admin/rules', '评论规则'],
    ['saved-replies', '/inbox/admin/saved-replies', '快捷话术'],
    ['audit', '/inbox/admin/audit', '操作日志'],
  ] as const).map(([key, href, label]) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</div>`;
}

export function renderAdmin(input: { staff: Staff; accounts: StaffAccount[]; pages: KnownPage[]; nonce: string; notice?: string }): string {
  const disabledCount = input.accounts.filter(account => account.disabled).length;
  const rows = input.accounts.map(account => {
    const name = escapeHtml(account.staff.name);
    const id = escapeHtml(account.staff.id);
    const assigned = input.pages.filter(page => account.pageIds.includes(page.pageId)).length;
    return `<tr data-member="${name}">
      <td><span class="member-name">${name}</span>${account.staff.id === input.staff.id ? '<span class="self-label">你</span>' : ''}</td>
      <td>${account.staff.role === 'admin' ? '管理员' : '普通客服'}</td>
      <td><span class="status ${account.disabled ? 'status-off' : 'status-on'}">${account.disabled ? '已停用' : '在岗'}</span></td>
      <td class="member-scope">${account.staff.role === 'admin' ? `全部 ${input.pages.length} 个主页／账号` : `已分配 ${assigned} 个主页／账号`}</td>
      <td class="member-action"><button class="ghost" type="button" data-open-access="access-${id}" aria-haspopup="dialog" aria-controls="access-${id}" aria-label="管理 ${name} 的权限">分配权限<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button></td>
    </tr>`;
  }).join('');
  const dialogs = input.accounts.map(account => {
    const name = escapeHtml(account.staff.name);
    const id = escapeHtml(account.staff.id);
    const pageBoxes = input.pages.map(page => `<label><input type="checkbox" name="pageId" value="${escapeHtml(page.pageId)}"${account.pageIds.includes(page.pageId) ? ' checked' : ''}><span class="name">${escapeHtml(page.name)}</span><span class="meta">${escapeHtml(page.pageId)}</span></label>`).join('');
    return `<dialog class="access-dialog" id="access-${id}" aria-labelledby="access-title-${id}" aria-describedby="access-hint-${id}">
      <form method="post" action="/inbox/admin/access">
        <header class="access-header"><div><h2 id="access-title-${id}">${name} 的权限</h2><p>设置成员角色与可访问的主页</p></div><button type="button" class="dialog-close" data-close-access aria-label="关闭权限设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
        <input type="hidden" name="staffId" value="${id}">
        <div class="access-body">
          <div class="access-settings"><label class="field">成员角色<select name="role"><option value="agent"${account.staff.role === 'agent' ? ' selected' : ''}>普通客服</option><option value="admin"${account.staff.role === 'admin' ? ' selected' : ''}>管理员</option></select></label><label class="check"><input type="checkbox" name="disabled" value="1"${account.disabled ? ' checked' : ''}>停用此成员</label></div>
          <p class="role-hint" data-role-hint id="access-hint-${id}">管理员可访问全部主页。</p>
          <div class="permission-heading"><h3>主页与账号权限</h3><span data-assigned aria-live="polite"></span></div>
          <label class="page-search"><span class="sr">搜索主页、账号名称或编号</span><input type="search" data-page-search placeholder="搜索主页、账号名称或编号" autofocus></label>
          <div class="permission-tools"><div><button class="ghost" type="button" data-pages="visible">全选当前结果</button><button class="ghost" type="button" data-pages="none">清空全部</button></div><label><input type="checkbox" data-selected-only>仅看已选</label></div>
          <div class="pages permission-pages">${pageBoxes}<p class="permission-empty" data-pages-empty hidden>${input.pages.length ? '没有符合条件的主页，试试其他搜索词或关闭「仅看已选」。' : '还没有授权主页，请先在「主页授权」中连接 Facebook。'}</p></div>
        </div>
        <footer class="access-footer"><span>保存后生效，取消不保留修改</span><div><button type="button" class="ghost" data-close-access>取消</button><button type="submit" class="primary">保存权限</button></div></footer>
      </form>
    </dialog>`;
  }).join('');
  const notice = input.notice ? `<p class="notice" role="status">${escapeHtml(input.notice)}</p>` : '';
  return shell({ title: '管理', nonce: input.nonce, staff: input.staff, section: 'admin',
    body: `<main class="sheet admin-sheet"><div class="admin-content">${notice}
      ${adminTabs('members')}<header class="admin-heading"><h1>成员与权限</h1><p>管理客服的访问范围，让每个人看到负责的主页。</p></header>
      <div class="member-toolbar"><label><span class="sr">搜索成员</span><input type="search" id="member-search" placeholder="搜索成员姓名"></label><p>${input.accounts.length} 位成员<span>·</span>${input.pages.length} 个主页／账号<span>·</span>${disabledCount} 位停用</p></div>
      <div class="member-table"><table><thead><tr><th scope="col">成员</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">访问范围</th><th scope="col"><span class="sr">操作</span></th></tr></thead><tbody>${rows}</tbody></table><p class="permission-empty" id="member-empty"${rows ? ' hidden' : ''}>没有符合条件的成员。</p></div>
      <p class="admin-footnote">管理员始终可访问全部主页；普通客服按分配的主页访问。成员首次登录后会出现在这里。</p>
      ${dialogs}
    </div></main>`,
  });
}

function auditStatus(status: string): { label: string; className: string } {
  if (status === 'sent') {
    return { label: '已发送', className: 'status status-sent' };
  }
  if (status === 'failed') {
    return { label: '失败', className: 'status status-failed' };
  }
  if (status === 'pending') {
    return { label: '发送中', className: 'status status-pending' };
  }
  return { label: status, className: 'status' };
}

export function renderAudit(input: { staff: Staff; rows: AuditRow[]; nonce: string }): string {
  const sent = input.rows.filter((row) => row.status === 'sent').length;
  const failed = input.rows.filter((row) => row.status === 'failed').length;
  const body = input.rows.map((row) => {
    const status = auditStatus(row.status);
    if (row.action && row.status === 'sent') status.label = '已完成';
    const platform = row.platform ?? 'facebook';
    const internal = row.eventId ? `/inbox/workbench/${platform}?event=${encodeURIComponent(row.eventId)}` : null;
    const commentUrl = (externalId: string, parentId?: string | null) => platform === 'instagram'
      ? instagramCommentUrl(row.postUrl ?? null, externalId, parentId)
      : facebookCommentUrl(row.postUrl ?? null, row.postId ?? null, externalId);
    const parentId = row.parentId !== row.postId ? row.parentId : null;
    const original = row.kind !== 'message' ? commentUrl(row.externalId, parentId) : null;
    const reply = row.kind !== 'message' && row.platformMessageId && row.status === 'sent'
      ? commentUrl(row.platformMessageId, parentId || row.externalId) : null;
    const igPost = !original && platform === 'instagram' && /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(row.postUrl ?? '') ? row.postUrl : null;
    const time = `<time>${escapeHtml(when(row.createdAt))}</time>`;
    return `<tr data-status="${escapeHtml(row.status)}">
    <td>${internal ? `<a href="${escapeHtml(internal)}" title="在收件箱定位原评论">${time}</a>` : time}</td>
    <td>${escapeHtml(row.staffName)}</td>
    <td>${escapeHtml(row.channelName)}<span class="meta">${platform === 'instagram' ? 'Instagram' : 'Facebook'} · ${row.kind === 'message' ? '私信' : '评论'}</span></td>
    <td><div class="audit-text">${escapeHtml(row.commentBody)}</div></td>
    <td><div class="audit-text">${escapeHtml(row.replyBody)}</div></td>
    <td><span class="${status.className}">${escapeHtml(status.label)}</span>${row.errorCode ? `<span class="meta">错误码 ${escapeHtml(row.errorCode)}</span>` : ''}</td>
    <td class="audit-actions">${internal ? `<a href="${escapeHtml(internal)}">定位会话</a>` : ''}${original ? `<a href="${escapeHtml(original)}" target="_blank" rel="noopener noreferrer">原评论 ↗</a>` : ''}${reply ? `<a href="${escapeHtml(reply)}" target="_blank" rel="noopener noreferrer">已发回复 ↗</a>` : ''}${igPost ? `<a href="${escapeHtml(igPost)}" target="_blank" rel="noopener noreferrer">打开原帖 ↗</a>` : ''}</td>
  </tr>`;
  }).join('');
  const title = input.staff.role === 'admin' ? '操作日志' : '我的记录';
  return shell({
    title,
    nonce: input.nonce,
    staff: input.staff,
    section: input.staff.role === 'admin' ? 'admin' : 'audit',
    body: `<main class="sheet audit-sheet">
      ${input.staff.role === 'admin' ? adminTabs('audit') : ''}
      <header class="desk-head">
        <div><h1>${title}</h1><p class="audit-intro">最近 100 条回复与评论操作 · 点击时间可在收件箱定位</p></div>
        <dl class="tally-row">
          <div><dt>记录</dt><dd>${input.rows.length}</dd></div>
          <div><dt>成功</dt><dd>${sent}</dd></div>
          <div><dt>失败</dt><dd>${failed}</dd></div>
        </dl>
      </header>
      <div class="chips" role="group" aria-label="筛选记录">
        <button type="button" class="chip" data-audit="all" aria-pressed="true">全部</button>
        <button type="button" class="chip" data-audit="sent" aria-pressed="false">成功</button>
        <button type="button" class="chip" data-audit="failed" aria-pressed="false">失败</button>
      </div>
      <p id="audit-empty" class="empty" hidden>没有符合的记录。</p>
      <div class="table-wrap"><table>
      <thead><tr><th>北京时间</th><th>客服</th><th>主页</th><th>原评论 / 消息</th><th>回复 / 操作</th><th>结果</th><th>定位</th></tr></thead>
      <tbody>${body || '<tr><td colspan="7">还没有回复记录。</td></tr>'}</tbody>
    </table></div></main>`,
  });
}

export function renderLoginError(nonce: string, notice: string): string {
  return shell({
    title: '登录',
    nonce,
    staff: null,
    section: 'login',
    body: `<main class="sheet"><p class="notice" role="status">${escapeHtml(notice)}</p><p><a class="primary" href="/inbox/auth/dingtalk/start">重新用钉钉登录</a></p></main>`,
  });
}
