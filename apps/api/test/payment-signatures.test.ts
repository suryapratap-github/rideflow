import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyRazorpaySignature, verifyStripeSignature, providerEventKey } from '../src/payment-signatures.ts';
const secret = 'test_webhook_secret';
const payload = Buffer.from('{"event":"payment.captured","id":"evt_1"}');
test('Razorpay accepts a valid signature of exact bytes', () => {
 const sig=createHmac('sha256',secret).update(payload).digest('hex');
 assert.equal(verifyRazorpaySignature(payload,sig,secret),true);
 assert.equal(verifyRazorpaySignature(Buffer.from('{}'),sig,secret),false);
 assert.equal(verifyRazorpaySignature(payload,'invalid',secret),false);
});
test('Stripe checks signed payload, timestamp, and rejects replay outside 5 minutes', () => {
 const now=1700000000;
 const sig=createHmac('sha256',secret).update(`${now}.`).update(payload).digest('hex');
 const header=`t=${now},v1=${sig}`;
 assert.equal(verifyStripeSignature(payload,header,secret,now),true);
 assert.equal(verifyStripeSignature(payload,header,secret,now+301),false);
 assert.equal(verifyStripeSignature(Buffer.from('{}'),header,secret,now),false);
 assert.equal(verifyStripeSignature(payload,'t=invalid,v1='+sig,secret,now),false);
});
test('Provider event IDs are namespaced and reject empty IDs', () => {
 assert.notEqual(providerEventKey('stripe','evt_1'),providerEventKey('razorpay','evt_1'));
 assert.throws(()=>providerEventKey('stripe',''));
});
