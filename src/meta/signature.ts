import { createHmac, timingSafeEqual } from 'node:crypto';

const META_SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

export function verifyMetaSignature(
  rawBody: Buffer,
  signature: string | undefined,
  appSecret: string,
): boolean {
  if (signature === undefined) {
    return false;
  }

  const match = META_SIGNATURE_PATTERN.exec(signature);
  if (match === null) {
    return false;
  }

  const suppliedDigest = Buffer.from(match[1], 'hex');
  const expectedDigest = createHmac('sha256', appSecret).update(rawBody).digest();

  if (suppliedDigest.length !== expectedDigest.length) {
    return false;
  }

  return timingSafeEqual(suppliedDigest, expectedDigest);
}
