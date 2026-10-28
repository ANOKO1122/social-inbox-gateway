import type { ChannelDb } from '../connect/channel-repository.js';
import type { CommentAction } from '../meta/reply-client.js';
import type { CommentAuthorization } from '../meta/reply-router.js';
import type { AuditRow, InboxComment, Staff } from './staff-repository.js';

export function actionAuthorizations(grants: CommentAuthorization[], platform: 'facebook' | 'instagram', action: CommentAction): CommentAuthorization[] {
  const required = platform === 'facebook'
    ? action === 'delete' ? ['pages_read_user_content', 'pages_manage_engagement'] : ['pages_manage_engagement']
    : action === 'like' || action === 'unlike' ? ['instagram_basic', 'instagram_manage_engagement', 'pages_read_user_content', 'pages_show_list']
      : action === 'delete' ? ['instagram_basic', 'instagram_manage_comments', 'pages_read_engagement']
        : ['instagram_basic', 'instagram_manage_messages', 'business_management'];
  return grants.filter(grant => required.every(scope => grant.scopes.includes(scope))
    && (platform !== 'instagram' || !['like', 'unlike'].includes(action) || Boolean(grant.userToken)));
}

export class CommentActionsStore {
  constructor(private readonly db: Pick<ChannelDb, 'query'>) {}

  async states(platform: string, channelId: string): Promise<Map<string, { liked: boolean }>> {
    const result = await this.db.query('SELECT external_id,liked FROM comment_actions WHERE platform=$1 AND channel_id=$2', [platform, channelId]);
    return new Map(result.rows.map(row => [String(row.external_id), { liked: row.liked === true }]));
  }

  async senderStates(platform: string, channelId: string): Promise<Map<string, { hasConversation: boolean; blocked: boolean }>> {
    const result = await this.db.query(`SELECT n.sender_id, coalesce(b.blocked,false) AS blocked
      FROM (SELECT DISTINCT sender_id FROM normalized_events WHERE platform=$1 AND channel_id=$2 AND kind='message' AND sender_id<>channel_id) n
      LEFT JOIN inbox_blocked_users b ON b.platform=$1 AND b.channel_id=$2 AND b.sender_id=n.sender_id`, [platform, channelId]);
    return new Map(result.rows.map(row => [String(row.sender_id), { hasConversation: true, blocked: row.blocked === true }]));
  }

  async revisions(platform: string, channelId: string, ids: string[]): Promise<Map<string, { body: string | null; deleted: boolean }>> {
    const result = await this.db.query(`SELECT external_id,body,deleted FROM comment_revisions
      WHERE platform=$1 AND channel_id=$2 AND external_id=ANY($3::text[])`, [platform,channelId,ids]);
    return new Map(result.rows.map(row => [String(row.external_id), { body: typeof row.body === 'string' ? row.body : null, deleted: row.deleted === true }]));
  }

  async record(staff: Staff, comment: InboxComment, action: CommentAction, errorCode?: string): Promise<void> {
    await this.db.query(`INSERT INTO comment_action_audit(normalized_event_id,staff_user_id,staff_name,platform,channel_id,
      channel_name,external_id,sender_id,comment_body,post_id,action,status,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [comment.id,staff.id,staff.name,comment.platform ?? 'facebook',comment.channelId,comment.channelName,
      comment.externalId,comment.senderId,comment.body,comment.postId,action,errorCode ? 'failed' : 'sent',errorCode ?? null]);
    if (errorCode) return;
    if (action === 'like' || action === 'unlike') await this.db.query(`INSERT INTO comment_actions(platform,channel_id,external_id,liked)
      VALUES($1,$2,$3,$4) ON CONFLICT(platform,channel_id,external_id) DO UPDATE SET liked=EXCLUDED.liked,updated_at=now()`,
    [comment.platform ?? 'facebook',comment.channelId,comment.externalId,action === 'like']);
    if (action === 'block' || action === 'unblock') await this.db.query(`INSERT INTO inbox_blocked_users(platform,channel_id,sender_id,blocked)
      VALUES($1,$2,$3,$4) ON CONFLICT(platform,channel_id,sender_id) DO UPDATE SET blocked=EXCLUDED.blocked,updated_at=now()`,
    [comment.platform ?? 'facebook',comment.channelId,comment.senderId,action === 'block']);
  }

  async audit(staff: Staff): Promise<AuditRow[]> {
    const result = await this.db.query(`SELECT * FROM comment_action_audit WHERE ($1::boolean OR staff_user_id=$2)
      ORDER BY created_at DESC LIMIT 100`, [staff.role === 'admin',staff.id]);
    const labels = { like:'点赞评论', unlike:'取消点赞', delete:'删除评论', block:'屏蔽用户', unblock:'取消屏蔽用户' };
    return result.rows.map(row => ({ id: String(row.id), eventId:String(row.normalized_event_id), kind:'comment',
      platform:row.platform === 'instagram' ? 'instagram' : 'facebook', action:row.action as CommentAction,
      staffName:String(row.staff_name), staffUnionId:'', channelName:String(row.channel_name), channelId:String(row.channel_id),
      senderId:String(row.sender_id), externalId:String(row.external_id), commentBody:String(row.comment_body),
      replyBody:labels[row.action as CommentAction], status:String(row.status), platformMessageId:null,
      errorCode:typeof row.error_code === 'string' ? row.error_code : null, createdAt:new Date(String(row.created_at)),
      postId:typeof row.post_id === 'string' ? row.post_id : null }));
  }
}
