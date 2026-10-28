import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error('token key');
  }
}

/** AES-256-GCM. The stored string is `v1.iv.tag.ciphertext`, all base64url. */
export function encryptToken(key: Buffer, plaintext: string): string {
  assertKey(key);
  if (plaintext.length === 0 || /[\u0000-\u001f\u007f]/.test(plaintext)) {
    throw new Error('token box');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptToken(key: Buffer, stored: string): string {
  assertKey(key);
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('token box');
  }

  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('token box');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (plaintext.length === 0) {
      throw new Error('token box');
    }
    return plaintext;
  } catch (error) {
    if (error instanceof Error && error.message === 'token box') {
      throw error;
    }
    throw new Error('token box');
  }
}
