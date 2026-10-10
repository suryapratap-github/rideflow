import { BadRequestException, Controller, Headers, HttpException, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { verifyStripeSignature, providerEventKey } from './payment-signatures';
import { Database } from './database';
import { providerConfig } from './payment-credentials';
import { MobileGuard } from './mobile-auth';

// Stripe PaymentSheet supports cards, Apple Pay and Google Pay where available.
// The client never determines the paid status: only a verified Stripe webhook does.
async function stripePost(db:Database,path:string, data:URLSearchParams, idempotencyKey?:string){
 const key=(await providerConfig(db,'STRIPE')).STRIPE_SECRET_KEY;
 if(!key)throw new HttpException('Stripe not configured',503);
 const response=await fetch(`https://api.stripe.com/v1/${path}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:data.toString()});
 const result=await response.json() as any;
 if(!response.ok)throw new HttpException('Stripe request failed',502);
 return result;
}
@Controller('payments/stripe') export class StripeController {
 constructor(private readonly db:Database){}
 @Post('intents/:rideId') @UseGuards(MobileGuard)
 async intent(@Req() req:any,@Param('rideId') rideId:string){
  if(req.mobile?.role!=='CUSTOMER')throw new UnauthorizedException();
  const ride=await this.db.ride.findUnique({where:{id:rideId}});
  if(!ride||ride.customerId!==req.mobile.sub||ride.status==='CANCELLED')throw new BadRequestException('Ride unavailable');
  if(ride.poolGroupId){
   const group=await this.db.poolGroup.findUnique({where:{id:ride.poolGroupId}});
   if(group?.status!=='ASSIGNED'||!ride.poolFareApprovedAt||!ride.poolConsentAt||!ride.poolFarePaise||ride.poolFarePaise<50)throw new BadRequestException('Approved pooled fare required');
  }
  const p=await this.db.ridePayment.findUnique({where:{rideId}});
  if(!p||p.method!=='ONLINE'||p.status!=='PENDING'||p.amountPaise<50||(ride.poolGroupId&&p.amountPaise!==ride.poolFarePaise))throw new BadRequestException('Select online payment first');
  const publishableKey=(await providerConfig(this.db,'STRIPE')).STRIPE_PUBLISHABLE_KEY;
  if(!publishableKey)throw new HttpException('Stripe publishable key not configured',503);
  const params=new URLSearchParams({amount:String(p.amountPaise),currency:'inr','automatic_payment_methods[enabled]':'true','metadata[rideId]':rideId,'metadata[paymentId]':p.id});
  let intent:any;
  if(p.stripeIntentId){
   // Retrieve the same intent rather than generating multiple charges for a ride.
   const key=(await providerConfig(this.db,'STRIPE')).STRIPE_SECRET_KEY;
   if(!key)throw new HttpException('Stripe not configured',503);
   const res=await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(p.stripeIntentId)}`,{headers:{Authorization:`Bearer ${key}`}});
   if(!res.ok)throw new HttpException('Stripe intent retrieval failed',502);
   intent=await res.json();
  }else{
   intent=await stripePost(this.db,'payment_intents',params,`rideflow-intent-${p.id}`);
   const updated=await this.db.ridePayment.updateMany({where:{id:p.id,status:'PENDING',method:'ONLINE',stripeIntentId:null},data:{stripeIntentId:intent.id,stripeClientSecretIssuedAt:new Date()}});
   if(updated.count!==1)throw new HttpException('Concurrent payment request; retry',409);
  }
  if(intent.amount!==p.amountPaise||intent.currency!=='inr'||intent.metadata?.paymentId!==p.id||!intent.client_secret)throw new HttpException('Stripe intent mismatch',502);
  return {clientSecret:intent.client_secret,publishableKey,merchantCountryCode:'IN',currency:'INR',status:p.status};
 }
 @Post('webhook')
 async webhook(@Req() req:any,@Headers('stripe-signature') signature:string){
  const secret=(await providerConfig(this.db,'STRIPE')).STRIPE_WEBHOOK_SECRET;
  if(!secret||!Buffer.isBuffer(req.rawBody)||!verifyStripeSignature(req.rawBody,signature||'',secret))throw new UnauthorizedException('Invalid Stripe webhook signature');
  const event=req.body;
  if(!event||typeof event.id!=='string'||typeof event.type!=='string')throw new BadRequestException('Invalid event');
  const pi=event.data?.object;
  const result=await this.db.$transaction(async tx=>{
   const eventId=providerEventKey('stripe', event.id);
   const existing=await tx.paymentWebhookEvent.findUnique({where:{providerEventId:eventId}});
   if(existing)return {duplicate:true,outcome:existing.outcome};
   const record=await tx.paymentWebhookEvent.create({data:{providerEventId:eventId,eventType:event.type,providerPaymentId:typeof pi?.id==='string'?pi.id:null}});
   let outcome='ignored';
   if(event.type==='payment_intent.succeeded'&&pi?.status==='succeeded'&&typeof pi.id==='string'){
    const p=await tx.ridePayment.findUnique({where:{stripeIntentId:pi.id}});
    if(p&&p.method==='ONLINE'&&p.amountPaise===pi.amount_received&&pi.currency==='inr'&&pi.metadata?.paymentId===p.id&&pi.metadata?.rideId===p.rideId){
     const updated=await tx.ridePayment.updateMany({where:{id:p.id,status:'PENDING',method:'ONLINE',stripeIntentId:pi.id},data:{status:'RECORDED',providerPaymentId:pi.id,providerCapturedAt:new Date(),collectedAt:new Date()}});
     outcome=updated.count===1?'captured':'already-processed';
    }else outcome='unmatched-intent-or-amount';
   }
   if(event.type==='charge.refunded'&&typeof pi?.payment_intent==='string'&&pi?.refunded===true){
    const p=await tx.ridePayment.findUnique({where:{stripeIntentId:pi.payment_intent}});
    if(p&&p.status==='REFUND_PENDING'&&pi.amount_refunded>=p.amountPaise&&p.refundProviderId&&Array.isArray(pi.refunds?.data)&&pi.refunds.data.some((r:any)=>r.id===p.refundProviderId&&r.status==='succeeded')){await tx.ridePayment.updateMany({where:{id:p.id,status:'REFUND_PENDING'},data:{status:'REFUNDED',refundedAt:new Date()}});outcome='refunded';}
   }
   await tx.paymentWebhookEvent.update({where:{id:record.id},data:{processed:true,outcome}});
   return {duplicate:false,outcome};
  });
  return {received:true,...result};
 }
}
