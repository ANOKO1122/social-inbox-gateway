const POST_ID = /^[0-9]{5,20}_[0-9]{5,20}$/;
const COMMENT_ID = /^[0-9_]{8,80}$/;
const MAX_THREAD_PAGES = 1;
const GRAPH_VERSION = /^v[0-9]+\.[0-9]+$/;
const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;
const AUTH_RETRY = /^(graph_10|graph_102|graph_104|graph_190|graph_200)$/;
const FACEBOOK_URL = /^https:\/\/(?:www\.|m\.)?facebook\.com\/[^\s]+$/;

export class CommentContextError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CommentContextError';
    this.code = code;
  }
}

export interface ThreadLine {
  id?: string;
  name: string;
  text: string;
  current: boolean;
  reply: boolean;
}

export interface CommentMention {
  name: string;
  offset: number;
  length: number;
}

export interface PulledComment {
  id: string;
  text: string;
  createdAt: string;
  parentId: string | null;
  likeCount: number;
  commentCount: number;
  mentions: CommentMention[];
  hidden?: boolean;
  canHide?: boolean;
}

export interface CommentContextView {
  status: 'ok' | 'unavailable';
  postText: string | null;
  postUrl: string | null;
  lines: ThreadLine[];
  /** Absent means the full thread has not been read yet. An empty array was read. */
  comments?: PulledComment[];
}

export interface CommentContextClient {
  load(input: {
    platform?: 'facebook' | 'instagram';
    postId: string;
    commentId: string;
    accessToken: string;
  }): Promise<CommentContextView>;
  /** `null` means the read failed and must not be cached. */
  loadThread(input: { postId: string; accessToken: string }): Promise<PulledComment[] | null>;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function facebookPostUrl(postId: string, permalink: unknown): string | null {
  const direct = clean(permalink, 300);
  if (FACEBOOK_URL.test(direct)) {
    return direct;
  }
  return POST_ID.test(postId) ? `https://www.facebook.com/${postId}` : null;
}

function postTextFrom(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const message = clean(body.message, 800);
  if (message) {
    return message;
  }
  const story = clean(body.story, 800);
  if (story) {
    return story;
  }
  const attachment = isRecord(body.attachments) && Array.isArray(body.attachments.data) ? body.attachments.data[0] : undefined;
  if (!isRecord(attachment)) {
    return null;
  }
  return clean(attachment.title, 800) || clean(attachment.description, 800) || null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 256 * 1024) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorCode(body: unknown, status: number): string {
  if (!isRecord(body) || !isRecord(body.error)) {
    return status === 401 ? 'graph_190' : 'graph_error';
  }
  const code = body.error.code;
  if (typeof code === 'number' && Number.isInteger(code)) {
    return SAFE_CODE.test(`graph_${code}`) ? `graph_${code}` : 'graph_error';
  }
  return 'graph_error';
}

export function createCommentContextClient(options: {
  graphVersion: string;
  fetchImpl?: typeof fetch;
}): CommentContextClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const version = GRAPH_VERSION.test(options.graphVersion) ? options.graphVersion : 'v23.0';

  return {
    async loadThread(input): Promise<PulledComment[] | null> {
      if (!POST_ID.test(input.postId) || input.accessToken.length < 8) {
        return null;
      }
      const comments: PulledComment[] = [];
      let next = `/${encodeURIComponent(input.postId)}/comments`;
      const query = {
        filter: 'stream',
        limit: '100',
        order: 'reverse_chronological',
        fields: 'id,message,created_time,parent,like_count,comment_count,message_tags,is_hidden,can_hide',
      };
      for (let page = 0; page < MAX_THREAD_PAGES && next; page += 1) {
        const result = page === 0
          ? await graphGet(fetchImpl, version, next, query, input.accessToken)
          : await graphGetUrl(fetchImpl, next, input.accessToken);
        if (!result.ok) {
          if (AUTH_RETRY.test(result.code)) {
            throw new CommentContextError(result.code);
          }
          return page === 0 ? null : comments;
        }
        if (!isRecord(result.body) || !Array.isArray(result.body.data)) {
          return page === 0 ? null : comments;
        }
        for (const item of result.body.data) {
          const comment = commentFrom(item);
          if (comment) {
            comments.push(comment);
          }
        }
        next = nextPage(result.body);
      }
      return comments.slice(0, 100);
    },
    async load(input): Promise<CommentContextView> {
      if (input.platform === 'instagram') {
        if (!/^[0-9]{5,32}$/.test(input.postId)) return { status: 'unavailable', postText: null, postUrl: null, lines: [] };
        const media = await graphGet(fetchImpl, version, `/${input.postId}`, { fields: 'caption,permalink' }, input.accessToken);
        if (!media.ok) {
          if (AUTH_RETRY.test(media.code)) throw new CommentContextError(media.code);
          return { status: 'unavailable', postText: null, postUrl: null, lines: [] };
        }
        const body = isRecord(media.body) ? media.body : {};
        const permalink = clean(body.permalink, 300);
        return { status: 'ok', postText: clean(body.caption, 800) || null,
          postUrl: /^https:\/\/(?:www\.)?instagram\.com\//.test(permalink) ? permalink : null, lines: [] };
      }
      const postUrl = facebookPostUrl(input.postId, undefined);
      if (!POST_ID.test(input.postId) || input.accessToken.length < 8) {
        return { status: 'unavailable', postText: null, postUrl, lines: [] };
      }
      const post = await graphGet(fetchImpl, version, `/${encodeURIComponent(input.postId)}`, {
        fields: 'message,story,permalink_url,attachments{title,description}',
      }, input.accessToken);
      if (!post.ok) {
        if (AUTH_RETRY.test(post.code)) {
          throw new CommentContextError(post.code);
        }
        return { status: 'unavailable', postText: null, postUrl, lines: [] };
      }
      return {
        status: 'ok',
        postText: postTextFrom(post.body),
        postUrl: facebookPostUrl(input.postId, isRecord(post.body) ? post.body.permalink_url : undefined),
        lines: [],
      };
    },
  };
}

export function orderPulledComments(comments: PulledComment[]): Array<{ comment: PulledComment; depth: number }> {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const children = new Map<string, PulledComment[]>();
  const roots: PulledComment[] = [];
  for (const comment of comments) {
    if (comment.parentId && byId.has(comment.parentId)) {
      const list = children.get(comment.parentId) ?? [];
      list.push(comment);
      children.set(comment.parentId, list);
    } else {
      roots.push(comment);
    }
  }
  const time = (comment: PulledComment) => Date.parse(comment.createdAt);
  roots.sort((left, right) => time(right) - time(left) || left.id.localeCompare(right.id));
  for (const list of children.values()) {
    list.sort((left, right) => time(left) - time(right) || left.id.localeCompare(right.id));
  }
  const ordered: Array<{ comment: PulledComment; depth: number }> = [];
  const walk = (comment: PulledComment, depth: number) => {
    ordered.push({ comment, depth: Math.min(depth, 4) });
    for (const child of children.get(comment.id) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return ordered;
}

function commentFrom(value: unknown): PulledComment | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !COMMENT_ID.test(value.id)) {
    return null;
  }
  const createdAt = typeof value.created_time === 'string' ? value.created_time : '';
  if (Number.isNaN(Date.parse(createdAt))) {
    return null;
  }
  const parent = isRecord(value.parent) && typeof value.parent.id === 'string' && COMMENT_ID.test(value.parent.id)
    ? value.parent.id
    : null;
  return {
    id: value.id,
    text: clean(value.message, 8000),
    createdAt,
    parentId: parent,
    likeCount: countOf(value.like_count),
    commentCount: countOf(value.comment_count),
    mentions: mentionsFrom(value.message_tags),
    ...(typeof value.is_hidden === 'boolean' ? { hidden: value.is_hidden } : {}),
    ...(typeof value.can_hide === 'boolean' ? { canHide: value.can_hide } : {}),
  };
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
}

function mentionsFrom(value: unknown): CommentMention[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mentions: CommentMention[] = [];
  for (const item of value) {
    if (!isRecord(item) || mentions.length >= 8) {
      continue;
    }
    const name = clean(item.name, 80);
    const offset = item.offset;
    const length = item.length;
    if (!name || typeof offset !== 'number' || typeof length !== 'number' || offset < 0 || length < 1 || length > 80) {
      continue;
    }
    mentions.push({ name, offset, length });
  }
  return mentions;
}

function nextPage(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.paging) || typeof body.paging.next !== 'string') {
    return '';
  }
  try {
    const url = new URL(body.paging.next);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
      return '';
    }
    url.searchParams.delete('access_token');
    return url.toString();
  } catch {
    return '';
  }
}

async function graphGetUrl(
  fetchImpl: typeof fetch,
  pageUrl: string,
  accessToken: string,
): Promise<{ ok: true; body: unknown } | { ok: false; code: string }> {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return { ok: false, code: 'invalid_graph_host' };
  }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || url.searchParams.has('access_token')) {
    return { ok: false, code: 'invalid_graph_host' };
  }
  return graphFetch(fetchImpl, url, accessToken);
}

async function graphGet(
  fetchImpl: typeof fetch,
  version: string,
  path: string,
  query: Record<string, string>,
  accessToken: string,
): Promise<{ ok: true; body: unknown } | { ok: false; code: string }> {
  const url = new URL(`https://graph.facebook.com/${version}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  if (url.hostname !== 'graph.facebook.com' || url.protocol !== 'https:' || url.searchParams.has('access_token')) {
    return { ok: false, code: 'invalid_graph_host' };
  }
  return graphFetch(fetchImpl, url, accessToken);
}

async function graphFetch(
  fetchImpl: typeof fetch,
  url: URL,
  accessToken: string,
): Promise<{ ok: true; body: unknown } | { ok: false; code: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { ok: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'graph_unreachable' };
  }
  const body = await readJson(response);
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: errorCode(body, response.status) };
  }
  return { ok: true, body };
}
