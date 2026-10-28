import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const STAFF_COOKIE = 'sig_staff';
export const SESSION_COOKIE = 'sig_connect';
export const STATE_COOKIE = 'sig_oauth_state';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const STATE_TTL_SECONDS = 10 * 60;

export interface SessionPayload {
  kind: 'session';
  exp: number;
}

export interface StatePayload {
  kind: 'state';
  exp: number;
  nonce: string;
}

export interface StaffPayload {
  kind: 'staff';
  exp: number;
  unionId: string;
}

export type SealedPayload = SessionPayload | StatePayload | StaffPayload;

const UNION_ID = /^[A-Za-z0-9_-]{4,128}$/;

export function signingKey(tokenKey: Buffer): Buffer {
  if (tokenKey.length !== 32) {
    throw new Error('token key');
  }
  return Buffer.from(hkdfSync('sha256', tokenKey, Buffer.alloc(0), 'sig-connect-v1', 32));
}

export function staffSigningKey(tokenKey: Buffer): Buffer {
  if (tokenKey.length !== 32) {
    throw new Error('token key');
  }
  return Buffer.from(hkdfSync('sha256', tokenKey, Buffer.alloc(0), 'sig-staff-v1', 32));
}

export function sealPayload(key: Buffer, payload: SealedPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function openPayload(key: Buffer, token: string, nowSeconds: number): SealedPayload | undefined {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as { kind?: unknown; exp?: unknown; nonce?: unknown; unionId?: unknown };
  if (typeof record.exp !== 'number' || !Number.isFinite(record.exp) || record.exp <= nowSeconds) {
    return undefined;
  }

  if (record.kind === 'session') {
    return { kind: 'session', exp: record.exp };
  }

  if (record.kind === 'state' && typeof record.nonce === 'string' && record.nonce.length > 0) {
    return { kind: 'state', exp: record.exp, nonce: record.nonce };
  }

  if (record.kind === 'staff' && typeof record.unionId === 'string' && UNION_ID.test(record.unionId)) {
    return { kind: 'staff', exp: record.exp, unionId: record.unionId };
  }

  return undefined;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || trimmed.slice(0, eq) !== name) {
      continue;
    }
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function setCookie(name: string, value: string, path: string, maxAge: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}
