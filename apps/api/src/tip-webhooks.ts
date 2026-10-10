import { JwtAuthGuard, RolesGuard, Roles } from './security';
import { Controller, Post, Get, Req, Headers, UseGuards, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { Database } from './database';
import { providerConfig } from './payment-credentials';
import { verifyStripeSignature, verifyRazorpaySignature, providerEventKey } from './payment-signatures';

/** Quarantine verified tip events until gateway initiation binds a provider reference to the ledger. */
@Controller('tip-payments')
export class TipPaymentWebhookController {
 constructor(private readonly db:Database){}
 private async record(provider:'stripe'|'razorpay',eventId:string,eventType:string,outcome='TIP_UNBOUND_MANUAL_REVIEW'){
  if(!eventId||eventId.length>200||!eventType)throw new BadRequestException('Invalid event');
  const key=providerEventKey(provider,eventId);
  return this.db.$transaction(async tx=>{
   const existing=await tx.paymentWebhookEvent.findUnique({where:{providerEventId:key}});
   if(existing)return {received:true,duplicate:true,outcome:existing.outcome};
   await tx.paymentWebhookEvent.create({data:{providerEventId:key,eventType,processed:true,outcome}});
   return {received:true,duplicate:false,outcome};
  });
 }
 @Post('stripe/webhook') async stripe(@Req() req:any,@Headers('stripe-signature') signature:string){
  const config=await providerConfig(this.db,'STRIPE');
  if(!Buffer.isBuffer(req.rawBody)||!verifyStripeSignature(req.rawBody,signature||'',config.STRIPE_WEBHOOK_SECRET))throw new UnauthorizedException('Invalid signature');
  const event=req.body;
  if(typeof event?.id!=='string'||!event.id||event.id.length>200)throw new BadRequestException('Invalid event ID');
  if(event?.type==='charge.refunded'||event?.type==='refund.created'||event?.type==='refund.updated')return this.record('stripe',event?.id,event?.type,'TIP_REFUND_EVENT_REQUIRES_PROVIDER_RECONCILIATION');
  if(event?.type!=='payment_intent.succeeded')return this.record('stripe',event?.id,event?.type);
  const pi=event?.data?.object;
  if(!pi?.id||!pi?.metadata?.tipPaymentId||!Number.isSafeInteger(pi.amount_received)||pi.currency!=='inr')return this.record('stripe',event?.id,event?.type);
  return this.db.$transaction(async tx=>{
   const eventKey=providerEventKey('stripe',event.id);
   const prior=await tx.paymentWebhookEvent.findUnique({where:{providerEventId:eventKey}});
   if(prior)return {received:true,duplicate:true,outcome:prior.outcome};
   const tip=await tx.rideTipPayment.findUnique({where:{id:pi.metadata.tipPaymentId}});
   let outcome='TIP_UNBOUND_MANUAL_REVIEW';
   if(tip&&tip.provider==='STRIPE'&&tip.providerPaymentId===pi.id&&tip.amountPaise===pi.amount_received&&tip.currency==='INR'&&tip.rideId===pi.metadata.rideId){
    if(tip.status==='AWAITING_PAYMENT'){
     const changed=await tx.rideTipPayment.updateMany({where:{id:tip.id,status:'AWAITING_PAYMENT',providerPaymentId:pi.id},data:{status:'CAPTURE_REPORTED',verifiedAt:new Date()}});
     if(changed.count===1)outcome='TIP_CAPTURE_REPORTED_NOT_SETTLED';
    }else if(tip.status==='CAPTURE_REPORTED')outcome='TIP_CAPTURE_ALREADY_REPORTED';
   }
   await tx.paymentWebhookEvent.create({data:{providerEventId:eventKey,eventType:event.type,providerPaymentId:pi.id,processed:true,outcome}});
   return {received:true,duplicate:false,outcome};
  });
 }
 @Post('razorpay/webhook') async razorpay(@Req() req:any,@Headers('x-razorpay-signature') signature:string,@Headers('x-razorpay-event-id') eventId:string){
  const config=await providerConfig(this.db,'RAZORPAY');
  if(!Buffer.isBuffer(req.rawBody)||!verifyRazorpaySignature(req.rawBody,signature||'',config.RAZORPAY_WEBHOOK_SECRET))throw new UnauthorizedException('Invalid signature');
  const event=req.body?.event;
  const payment=req.body?.payload?.payment?.entity;
  if(event==='refund.created'||event==='refund.processed'||event==='refund.failed')return this.record('razorpay',eventId,event,'TIP_REFUND_EVENT_REQUIRES_PROVIDER_RECONCILIATION');
  if(event!=='payment.captured'||typeof payment?.order_id!=='string'||typeof payment?.id!=='string'||!Number.isSafeInteger(payment?.amount)||payment?.currency!=='INR'||payment?.status!=='captured')return this.record('razorpay',eventId,event);
  if(!eventId||eventId.length>200)throw new BadRequestException('Invalid event ID');
  return this.db.$transaction(async tx=>{
   const eventKey=providerEventKey('razorpay',eventId);
   const prior=await tx.paymentWebhookEvent.findUnique({where:{providerEventId:eventKey}});
   if(prior)return {received:true,duplicate:true,outcome:prior.outcome};
   const tip=await tx.rideTipPayment.findFirst({where:{provider:'RAZORPAY',providerPaymentId:payment.order_id}});
   let outcome='TIP_UNBOUND_MANUAL_REVIEW';
   if(tip&&tip.amountPaise===payment.amount&&tip.currency===payment.currency){
    if(tip.status==='AWAITING_PAYMENT'){
     const changed=await tx.rideTipPayment.updateMany({where:{id:tip.id,status:'AWAITING_PAYMENT',provider:'RAZORPAY',providerPaymentId:payment.order_id},data:{status:'CAPTURE_REPORTED',verifiedAt:new Date()}});
     if(changed.count===1)outcome='TIP_CAPTURE_REPORTED_NOT_SETTLED';
    }else if(tip.status==='CAPTURE_REPORTED')outcome='TIP_CAPTURE_ALREADY_REPORTED';
   }
   await tx.paymentWebhookEvent.create({data:{providerEventId:eventKey,eventType:event,providerPaymentId:payment.id,processed:true,outcome}});
   return {received:true,duplicate:false,outcome};
  });
 }
}

@Controller('admin/tip-webhooks') @UseGuards(JwtAuthGuard,RolesGuard)
export class AdminTipWebhookReviewController {
 constructor(private readonly db:Database){}
 @Get('unmatched') @Roles('ADMIN') async unmatched(){
  return {events:await this.db.paymentWebhookEvent.findMany({where:{outcome:'TIP_UNBOUND_MANUAL_REVIEW'},orderBy:{receivedAt:'desc'},take:100}),notice:'Read-only queue; no payouts or automatic refunds'};
 }
}
