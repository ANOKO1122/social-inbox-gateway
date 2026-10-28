const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GRAPH_VERSION = /^v[0-9]+\.[0-9]+$/;
const SAFE_ERROR_TYPE = /^[A-Za-z0-9_]{1,64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';
const DEFAULT_GRAPH_VERSION = 'v23.0';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const TEXT_LIMITS = {
  facebook: { comment: 8000, message: 2000 },
  instagram: { comment: 2200, message: 1000 },
} as const;

export interface GraphReplyInput {
  platform: 'facebook' | 'instagram';
  kind: 'comment' | 'message';
  channelId: string;
  senderId: string;
  externalId: string;
  text: string;
  accessToken: string;
}

export type GraphReplyResult =
  | { ok: true; platformMessageId: string }
  | { ok: false; code: string; type?: string };

export type VisibilityResult = { ok: true; hidden: boolean; canHide: boolean; liked?: boolean; changed?: boolean } | { ok: false; code: string };
export interface VisibilityInput { platform: 'facebook' | 'instagram'; externalId: string; accessToken: string }
export type CommentAction = 'like' | 'unlike' | 'delete' | 'block' | 'unblock';
export interface CommentActionInput {
  platform: 'facebook' | 'instagram';
  channelId: string;
  externalId: string;
  senderId: string;
  accessToken: string;
  action: CommentAction;
  linkedPageId?: string;
  senderHasConversation?: boolean;
}
export type CommentActionResult = { ok: true } | { ok: false; code: string };
export interface GraphReplyClient {
  commentAction?(input: CommentActionInput): Promise<CommentActionResult>;
  react?(input: Omit<GraphReplyInput, 'text'> & { reaction: string }): Promise<{ ok: true } | { ok: false; code: string }>;
  visibility?(input: VisibilityInput): Promise<VisibilityResult>;
  setHidden?(input: VisibilityInput & { hidden: boolean }): Promise<VisibilityResult>;
  send(input: GraphReplyInput): Promise<GraphReplyResult>;
}

export interface GraphReplyClientOptions {
  fetchImpl?: typeof fetch;
  graphBaseUrl?: string;
  graphVersion?: string;
  timeoutMs?: number;
}

function failure(code: string, type?: string): GraphReplyResult {
  return type === undefined ? { ok: false, code } : { ok: false, code, type };
}

function allowedGraphBase(graphBaseUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(graphBaseUrl);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'graph.facebook.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }

  return url;
}

function concatBytes(chunks: Uint8Array[], received: number): Uint8Array {
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readWithByob(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader({ mode: 'byob' });
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < limit) {
      const pending = new Uint8Array(limit - received);
      const { done, value } = await reader.read(pending);
      if (done || !value || value.byteLength === 0) {
        break;
      }

      chunks.push(new Uint8Array(value));
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return concatBytes(chunks, received);
}

async function readWithDefaultReader(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      const room = limit - received;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        received += room;
        break;
      }

      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return concatBytes(chunks, received);
}

async function readAtMost(response: Response, limit: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    return new Uint8Array();
  }

  // Byte streams can honour an exact 64KB ceiling. Other bodies fall back to
  // the default reader, which still stops after 64KB and cancels the rest.
  try {
    return await readWithByob(body, limit);
  } catch (error) {
    if (body.locked) {
      throw error;
    }
    return readWithDefaultReader(body, limit);
  }
}

function parseGraphError(bytes: Uint8Array): { code?: string; type?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return {};
  }

  const { code, type } = error as { code?: unknown; type?: unknown };
  const result: { code?: string; type?: string } = {};

  if (typeof code === 'number' && Number.isInteger(code) && code >= 0) {
    result.code = String(code);
  }

  if (typeof type === 'string' && SAFE_ERROR_TYPE.test(type)) {
    result.type = type;
  }

  return result;
}

function successId(kind: GraphReplyInput['kind'], bytes: Uint8Array): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as { id?: unknown; message_id?: unknown };
  const value = kind === 'comment' ? record.id : record.message_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function localReplyFailure(
  input: Pick<GraphReplyInput, 'platform' | 'kind' | 'channelId' | 'senderId' | 'externalId' | 'text'>,
): 'text_invalid' | 'invalid_object_id' | undefined {
  const limit = TEXT_LIMITS[input.platform][input.kind];
  if (input.text.trim().length === 0 || input.text.length > limit) {
    return 'text_invalid';
  }

  const pathId = input.kind === 'comment' ? input.externalId : input.channelId;
  if (!OBJECT_ID.test(pathId) || (input.kind === 'message' && !OBJECT_ID.test(input.senderId))) {
    return 'invalid_object_id';
  }

  return undefined;
}

export function createGraphReplyClient(options: GraphReplyClientOptions = {}): GraphReplyClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBaseUrl = options.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL;
  const graphVersion = options.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function visibility(input: VisibilityInput): Promise<VisibilityResult> {
    if (!/^[0-9_]{5,80}$/.test(input.externalId) || !GRAPH_VERSION.test(graphVersion)
      || !allowedGraphBase(graphBaseUrl) || !input.accessToken || CONTROL_CHARACTER.test(input.accessToken)) return { ok: false, code: 'invalid_target' };
    const url = new URL(`/${graphVersion}/${input.externalId}`, graphBaseUrl);
    url.searchParams.set('fields', input.platform === 'facebook' ? 'id,is_hidden,can_hide,user_likes' : 'id,hidden');
    try {
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${input.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const body = await readAtMost(r, MAX_ERROR_BODY_BYTES);
      if (!r.ok) return { ok: false, code: parseGraphError(body).code ?? 'graph_http_error' };
      const value = JSON.parse(new TextDecoder().decode(body));
      const hidden = input.platform === 'facebook' ? value.is_hidden : value.hidden;
      if (typeof hidden !== 'boolean') return { ok: false, code: 'visibility_unavailable' };
      return { ok: true, hidden, canHide: input.platform === 'instagram' || value.can_hide === true,
        ...(input.platform === 'facebook' && typeof value.user_likes === 'boolean' ? { liked: value.user_likes } : {}) };
    } catch { return { ok: false, code: 'graph_unreachable' }; }
  }

  return {
    visibility,
    async commentAction(input): Promise<CommentActionResult> {
      if (!['facebook', 'instagram'].includes(input.platform)
        || !['like', 'unlike', 'delete', 'block', 'unblock'].includes(input.action)) {
        return { ok: false, code: 'unsupported' };
      }
      const blocking = input.action === 'block' || input.action === 'unblock';
      if (blocking && input.senderHasConversation !== true) return { ok: false, code: 'unsupported_sender' };
      const commentIdPattern = input.platform === 'instagram' ? /^[0-9]{5,80}$/ : /^[0-9]{5,40}(?:_[0-9]{5,40})?$/;
      if (!/^[0-9]{5,80}$/.test(input.channelId)
        || (!blocking && !commentIdPattern.test(input.externalId))
        || (blocking && !/^[0-9]{5,80}$/.test(input.senderId))
        || (blocking && input.platform === 'instagram' && !/^[0-9]{5,80}$/.test(input.linkedPageId ?? ''))
        || !GRAPH_VERSION.test(graphVersion) || !allowedGraphBase(graphBaseUrl)
        || !input.accessToken || CONTROL_CHARACTER.test(input.accessToken)) {
        return { ok: false, code: 'invalid_target' };
      }

      const liking = input.action === 'like' || input.action === 'unlike';
      const instagramBlocking = blocking && input.platform === 'instagram';
      const path = instagramBlocking ? `${input.linkedPageId}/moderate_conversations`
        : blocking ? `${input.channelId}/blocked`
        : liking ? `${input.platform === 'instagram' ? input.channelId : input.externalId}/likes`
          : input.externalId;
      const method = instagramBlocking || input.action === 'like' || input.action === 'block' ? 'POST' : 'DELETE';
      const url = new URL(`/${graphVersion}/${path}`, graphBaseUrl);
      const parameters: Record<string, string | string[]> = blocking
        ? { psid: input.action === 'block' ? [input.senderId] : input.senderId }
        : liking && input.platform === 'instagram' ? { comment_id: input.externalId } : {};
      if (method === 'DELETE') {
        for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
      }
      try {
        const response = await fetchImpl(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(instagramBlocking
            ? { user_ids: [{ id: input.senderId }], actions: [input.action === 'block' ? 'block_user' : 'unblock_user'] }
            : parameters) } : {}),
        });
        const bytes = await readAtMost(response, MAX_ERROR_BODY_BYTES);
        if (!response.ok) return { ok: false, code: parseGraphError(bytes).code ?? 'graph_http_error' };
        let value: unknown;
        try { value = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { return { ok: false, code: 'invalid_graph_response' }; }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { ok: false, code: 'invalid_graph_response' };
        }
        const record = value as Record<string, unknown>;
        // Blocking returns a map keyed by the submitted Page-scoped ID.
        // The Instagram moderation guide also shows the string "true".
        const confirmed = instagramBlocking ? record.success === true || record.success === 'true'
          : input.action === 'block' ? record[input.senderId] === true : record.success === true;
        return confirmed ? { ok: true } : { ok: false, code: 'action_unconfirmed' };
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        return { ok: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'graph_unreachable' };
      }
    },
    async react(input) {
      const allowed = input.platform === 'instagram' ? ['', '❤️'] : ['', '❤️', '👍', '😊', '😂', '😮', '😢', '🎉'];
      if (input.kind !== 'message' || !allowed.includes(input.reaction) || !OBJECT_ID.test(input.channelId)
        || !OBJECT_ID.test(input.senderId) || !input.externalId || input.externalId.length > 2048
        || CONTROL_CHARACTER.test(input.externalId) || !allowedGraphBase(graphBaseUrl) || !GRAPH_VERSION.test(graphVersion)
        || !input.accessToken || CONTROL_CHARACTER.test(input.accessToken)) return { ok: false, code: 'invalid_reaction' };
      try {
        const r = await fetchImpl(new URL(`/${graphVersion}/${input.channelId}/messages`, graphBaseUrl), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: { id: input.senderId }, sender_action: input.reaction ? 'react' : 'unreact',
            payload: { message_id: input.externalId, ...(input.reaction ? { reaction: input.platform === 'instagram' ? 'love' : input.reaction } : {}) } }),
        });
        const body = await readAtMost(r, MAX_ERROR_BODY_BYTES);
        if (!r.ok) return { ok: false, code: parseGraphError(body).code ?? 'graph_http_error' };
        if (JSON.parse(new TextDecoder().decode(body)).recipient_id !== input.senderId) return { ok: false, code: 'invalid_graph_response' };
        return { ok: true };
      } catch { return { ok: false, code: 'graph_unreachable' }; }
    },
    async setHidden(input): Promise<VisibilityResult> {
      const current = await visibility(input);
      if (!current.ok) return current;
      if (current.hidden === input.hidden) return { ...current, changed: false };
      if (!current.canHide) return { ok: false, code: 'cannot_hide' };
      try {
        const r = await fetchImpl(new URL(`/${graphVersion}/${input.externalId}`, graphBaseUrl), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input.platform === 'facebook' ? { is_hidden: input.hidden } : { hide: input.hidden }),
        });
        const body = await readAtMost(r, MAX_ERROR_BODY_BYTES);
        if (!r.ok) return { ok: false, code: parseGraphError(body).code ?? 'graph_http_error' };
        if (JSON.parse(new TextDecoder().decode(body)).success !== true) return { ok: false, code: 'visibility_unconfirmed' };
        return { ok: true, hidden: input.hidden, canHide: true, changed: true };
      } catch { return { ok: false, code: 'graph_unreachable' }; }
    },
    async send(input: GraphReplyInput): Promise<GraphReplyResult> {
      const localFailure = localReplyFailure(input);
      if (localFailure) {
        return failure(localFailure);
      }

      const pathId = input.kind === 'comment' ? input.externalId : input.channelId;
      if (input.accessToken.length === 0) {
        return failure('missing_token');
      }

      if (CONTROL_CHARACTER.test(input.accessToken)) {
        return failure('invalid_token');
      }

      const base = allowedGraphBase(graphBaseUrl);
      if (!base) {
        return failure('invalid_graph_host');
      }

      if (!GRAPH_VERSION.test(graphVersion)) {
        return failure('invalid_graph_version');
      }

      const action = input.kind === 'message'
        ? 'messages'
        : input.platform === 'facebook'
          ? 'comments'
          : 'replies';
      const url = new URL(
        `/${graphVersion}/${encodeURIComponent(pathId)}/${action}`,
        base,
      );
      if (url.hostname !== 'graph.facebook.com' || url.protocol !== 'https:' || url.search !== '') {
        return failure('invalid_graph_host');
      }

      const body = input.kind === 'comment'
        ? { message: input.text }
        : input.platform === 'facebook'
          ? {
              recipient: { id: input.senderId },
              messaging_type: 'RESPONSE',
              message: { text: input.text },
            }
          : {
              recipient: { id: input.senderId },
              message: { text: input.text },
            };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          return failure('timeout');
        }
        return failure('graph_unreachable');
      }

      if (response.status >= 300 && response.status < 400) {
        return failure('graph_redirect');
      }

      if (response.status < 200 || response.status >= 300) {
        const parsed = parseGraphError(await readAtMost(response, MAX_ERROR_BODY_BYTES));
        return parsed.code ? failure(parsed.code, parsed.type) : failure('graph_http_error');
      }

      const platformMessageId = successId(input.kind, await readAtMost(response, MAX_ERROR_BODY_BYTES));
      if (!platformMessageId) {
        return failure('invalid_graph_response');
      }

      return { ok: true, platformMessageId };
    },
  };
}
