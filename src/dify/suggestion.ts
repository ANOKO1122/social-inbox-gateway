/**
 * On-demand reply draft. The workflow must return structured fields and must
 * not be asked to translate. An empty source list forces needs_human, because
 * a miss in the knowledge base is not a fact the draft may invent.
 */

export interface SuggestionRequest {
  staffId: string;
  platform: 'facebook' | 'instagram';
  kind: 'comment' | 'message';
  text: string;
  postText: string | null;
  replyTo: string | null;
  context: string;
}

export interface SuggestionResult {
  intent: string;
  suggestedReply: string;
  needsHuman: boolean;
  sources: string[];
}

export class SuggestionError extends Error {
  readonly code: 'timeout' | 'unavailable' | 'invalid' | 'model_auth';

  constructor(code: 'timeout' | 'unavailable' | 'invalid' | 'model_auth') {
    super(code);
    this.name = code === 'timeout'
      ? 'SuggestionTimeout'
      : code === 'invalid'
        ? 'SuggestionInvalid'
        : code === 'model_auth'
          ? 'SuggestionModelAuth'
          : 'SuggestionUnavailable';
    this.code = code;
  }
}

const INTENT = /^[a-z0-9_]{1,64}$/;

export function parseSuggestion(payload: unknown): SuggestionResult | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  if ((data as { status?: unknown }).status !== 'succeeded') {
    return undefined;
  }
  const outputs = (data as { outputs?: unknown }).outputs;
  return fromOutputs(outputs);
}

function fromOutputs(outputs: unknown): SuggestionResult | undefined {
  if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) {
    return undefined;
  }
  const record = outputs as Record<string, unknown>;
  const nested = record.suggested_reply === undefined ? nestedObject(record.result ?? record.text) : undefined;
  const source = nested ?? record;
  const reply = cleanReply(source.suggested_reply);
  if (!reply) {
    return undefined;
  }
  const sources = cleanSources(source.sources);
  const stated = source.needs_human;
  const needsHuman = stated === false || stated === 'false' ? sources.length === 0 : true;
  return {
    intent: intentCode(source.intent),
    suggestedReply: reply,
    needsHuman,
    sources,
  };
}

function modelAuthFailed(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  if ((data as { status?: unknown }).status !== 'failed') {
    return false;
  }
  const error = (data as { error?: unknown }).error;
  return typeof error === 'string' && /authentication_error|\b401\b|API Key/i.test(error);
}

function nestedObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function intentCode(value: unknown): string {
  const raw = typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';
  return INTENT.test(raw) ? raw : 'unknown';
}

function cleanReply(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(/\u0000/g, '').trim();
  if (text.length === 0 || text.length > 8000) {
    return undefined;
  }
  return text;
}

function cleanSources(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\n')
      : [];
  const sources: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || sources.length >= 8) {
      continue;
    }
    const text = item.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    if (text.length > 0) {
      sources.push(text);
    }
  }
  return sources;
}

export function createSuggestionClient(options: {
  apiBase: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): { draft(input: SuggestionRequest): Promise<SuggestionResult> } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 45_000;
  return {
    async draft(input) {
      let response: Response;
      try {
        response = await fetchImpl(`${options.apiBase}/workflows/run`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            inputs: {
              platform: input.platform,
              kind: input.kind,
              text: input.text.slice(0, 4000),
              post_text: (input.postText ?? '').slice(0, 2000),
              reply_to: (input.replyTo ?? '').slice(0, 80),
              context: input.context.slice(0, 4000),
            },
            response_mode: 'blocking',
            user: input.staffId,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        throw new SuggestionError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SuggestionError('unavailable');
      }
      let payload: unknown;
      try {
        payload = await response.json() as unknown;
      } catch {
        throw new SuggestionError('invalid');
      }
      if (modelAuthFailed(payload)) {
        throw new SuggestionError('model_auth');
      }
      const suggestion = parseSuggestion(payload);
      if (!suggestion) {
        throw new SuggestionError('invalid');
      }
      return suggestion;
    },
  };
}
