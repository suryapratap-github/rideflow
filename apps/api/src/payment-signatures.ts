import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verify the exact bytes delivered by a payment provider. */
export function verifyRazorpaySignature(body: Buffer, signature: string, secret: string): boolean {
  if (!Buffer.isBuffer(body) || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function verifyStripeSignature(body: Buffer, header: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!Buffer.isBuffer(body) || !header || !secret) return false;
  const fields = header.split(',').map(x => x.trim());
  const timestamp = fields.find(x => x.startsWith('t='))?.slice(2);
  const signatures = fields.filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
  return signatures.some(s => /^[a-f0-9]{64}$/i.test(s) && timingSafeEqual(expected, Buffer.from(s, 'hex')));
}

export function providerEventKey(provider: 'stripe' | 'razorpay', eventId: string): string {
  if (!eventId || eventId.length > 200) throw new Error('Invalid event ID');
  return `${provider}:${eventId}`;
}
