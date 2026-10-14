import { createHmac, timingSafeEqual } from 'node:crypto';

/** Sevari's signed-webhook scheme: v1=hex(HMAC-SHA256(secret, `${unixSeconds}.${body}`)). */
export function signWebhook(secret: Buffer, unixSeconds: number, body: Buffer | string): string {
  return 'v1=' + createHmac('sha256', secret).update(`${unixSeconds}.`).update(body).digest('hex');
}

export function verifySignature(secret: Buffer, unixSeconds: number, body: Buffer, presented: string): boolean {
  const expected = Buffer.from(signWebhook(secret, unixSeconds, body));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const SIGNATURE_TOLERANCE_SECONDS = 300;
