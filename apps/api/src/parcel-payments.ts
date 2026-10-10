import { providerConfig } from './payment-credentials';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpException, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Database } from './database';
import { MobileGuard } from './mobile-auth';
import { JwtAuthGuard, RolesGuard, Roles } from './security';
import { verifyStripeSignature, verifyRazorpaySignature, providerEventKey } from './payment-signatures';

// Online parcel charges are independent of RidePayment. Gateway confirmation is webhook-only.
@Controller('parcel-payments')
export class ParcelPaymentController {
 constructor(private readonly db:Database){}
 private async eligible(req:any,id:string){
  if(req.mobile?.role!=='CUSTOMER')throw new UnauthorizedException();
  const parcel=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!parcel||parcel.customerId!==req.mobile.sub)throw new BadRequestException('Parcel not found');
  if(!parcel.fareApprovedAt)throw new ConflictException('Customer must approve the parcel fare before online payment');
  if(parcel.status==='CANCELLED'||!parcel.estimatedFarePaise||parcel.estimatedFarePaise<50)throw new BadRequestException('Parcel fare unavailable');
  if(parcel.parcelPaymentStatus==='COLLECTED')throw new ConflictException('Cash already collected');
  return parcel;
 }
 private async record(id:string,provider:'STRIPE'|'RAZORPAY',amount:number){
  const existing=await this.db.parcelPayment.findUnique({where:{parcelId:id}});
  if(existing){if(existing.provider!==provider||existing.amountPaise!==amount)throw new ConflictException('Payment provider or amount already locked');return existing;}
  try{return await this.db.parcelPayment.create({data:{parcelId:id,provider,amountPaise:amount}});}
  catch(e){const current=await this.db.parcelPayment.findUnique({where:{parcelId:id}});if(current&&current.provider===provider&&current.amountPaise===amount)return current;throw e;}
 }
 @Get(':id/status') @UseGuards(MobileGuard)
 async status(@Req() req:any,@Param('id') id:string){const parcel=await this.eligible(req,id);const p=await this.db.parcelPayment.findUnique({where:{parcelId:id}});return {status:parcel.parcelPaymentStatus==='COLLECTED'?'RECORDED':(p?.status||'UNPAID'),refundRequestedAt:p?.refundRequestedAt||null,refundedAt:p?.refundedAt||null,provider:p?.provider||parcel.parcelPaymentMethod||null,amountPaise:p?.amountPaise||parcel.estimatedFarePaise||null};}
 @Post(':id/stripe') @UseGuards(MobileGuard)
 async stripe(@Req() req:any,@Param('id') id:string){
  const parcel=await this.eligible(req,id);const p=await this.record(id,'STRIPE',parcel.estimatedFarePaise!);
  if(p.status!=='PENDING')throw new ConflictException('Payment already processed');
  const stripeConfig=await providerConfig(this.db,'STRIPE');const key=stripeConfig.STRIPE_SECRET_KEY,publishableKey=stripeConfig.STRIPE_PUBLISHABLE_KEY;
  if(!key||!publishableKey)throw new HttpException('Stripe not configured',503);
  let intent:any;
  if(p.stripeIntentId){const response=await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(p.stripeIntentId)}`,{headers:{Authorization:`Bearer ${key}`}});if(!response.ok)throw new HttpException('Stripe retrieval failed',502);intent=await response.json();}
  else{const params=new URLSearchParams({amount:String(p.amountPaise),currency:'inr','automatic_payment_methods[enabled]':'true','metadata[parcelId]':id,'metadata[parcelPaymentId]':p.id});const response=await fetch('https://api.stripe.com/v1/payment_intents',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`rideflow-parcel-${p.id}`},body:params.toString()});if(!response.ok)throw new HttpException('Stripe creation failed',502);intent=await response.json();const changed=await this.db.parcelPayment.updateMany({where:{id:p.id,status:'PENDING',stripeIntentId:null},data:{stripeIntentId:intent.id}});if(changed.count!==1)throw new ConflictException('Concurrent payment initiation; retry');}
  if(intent.amount!==p.amountPaise||intent.currency!=='inr'||intent.metadata?.parcelPaymentId!==p.id||intent.metadata?.parcelId!==id||!intent.client_secret)throw new HttpException('Stripe intent mismatch',502);
  return {clientSecret:intent.client_secret,publishableKey,merchantCountryCode:'IN',currency:'INR'};
 }
 @Post(':id/razorpay') @UseGuards(MobileGuard)
 async razorpay(@Req() req:any,@Param('id') id:string){
  const parcel=await this.eligible(req,id);const p=await this.record(id,'RAZORPAY',parcel.estimatedFarePaise!);
  if(p.status!=='PENDING')throw new ConflictException('Payment already processed');
  const razorConfig=await providerConfig(this.db,'RAZORPAY');const keyId=razorConfig.RAZORPAY_KEY_ID,secret=razorConfig.RAZORPAY_KEY_SECRET;
  if(!keyId||!secret)throw new HttpException('Razorpay not configured',503);
  if(p.providerOrderId)return {orderId:p.providerOrderId,keyId,amountPaise:p.amountPaise,currency:'INR'};
  const response=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${keyId}:${secret}`).toString('base64'),'Content-Type':'application/json'},body:JSON.stringify({amount:p.amountPaise,currency:'INR',receipt:p.id,notes:{parcelId:id,parcelPaymentId:p.id}})});
  if(!response.ok)throw new HttpException('Razorpay order creation failed',502);
  const order=await response.json() as any;
  if(!order.id||order.amount!==p.amountPaise||order.currency!=='INR')throw new HttpException('Order mismatch',502);
  const changed=await this.db.parcelPayment.updateMany({where:{id:p.id,status:'PENDING',providerOrderId:null},data:{providerOrderId:order.id}});
  if(changed.count!==1)throw new ConflictException('Concurrent order initiation; retry');
  return {orderId:order.id,keyId,amountPaise:p.amountPaise,currency:'INR'};
 }
 @Post('stripe/webhook')
 async stripeWebhook(@Req() req:any,@Headers('stripe-signature') signature:string){
  const stripeConfig=await providerConfig(this.db,'STRIPE');if(!stripeConfig.STRIPE_WEBHOOK_SECRET||!Buffer.isBuffer(req.rawBody)||!verifyStripeSignature(req.rawBody,signature||'',stripeConfig.STRIPE_WEBHOOK_SECRET))throw new UnauthorizedException();
  const event=req.body,pi=event?.data?.object;if(typeof event?.id!=='string'||typeof event?.type!=='string')throw new BadRequestException();
  return this.db.$transaction(async tx=>{
   const eventKey=providerEventKey('stripe',event.id);if(await tx.paymentWebhookEvent.findUnique({where:{providerEventId:eventKey}}))return {received:true,duplicate:true};
   const row=await tx.paymentWebhookEvent.create({data:{providerEventId:eventKey,eventType:event.type}});let outcome='ignored';
   if(event.type==='payment_intent.succeeded'&&pi?.status==='succeeded'&&typeof pi.id==='string'){
    const p=await tx.parcelPayment.findUnique({where:{stripeIntentId:pi.id}});
    if(p&&p.provider==='STRIPE'&&p.status==='PENDING'&&pi.amount_received===p.amountPaise&&pi.currency==='inr'&&pi.metadata?.parcelPaymentId===p.id&&pi.metadata?.parcelId===p.parcelId){
     const changed=await tx.parcelPayment.updateMany({where:{id:p.id,status:'PENDING'},data:{status:'RECORDED',providerPaymentId:pi.id,capturedAt:new Date()}});
     if(changed.count){await tx.parcelDelivery.update({where:{id:p.parcelId},data:{parcelPaymentStatus:'COLLECTED',parcelPaymentMethod:'STRIPE',parcelPaymentRecordedAt:new Date()}});outcome='captured';}
    }else outcome='unmatched';
   }
   if(event.type==='charge.refunded'&&pi?.payment_intent&&pi?.refunded===true){
    const p=await tx.parcelPayment.findUnique({where:{stripeIntentId:pi.payment_intent}});
    const refunds=pi.refunds?.data;
    const matched=Array.isArray(refunds)&&refunds.some((r:any)=>r.id===p?.refundProviderId&&r.status==='succeeded'&&r.amount===p?.amountPaise);
    if(p?.provider==='STRIPE'&&p.status==='REFUND_PENDING'&&matched){
     const changed=await tx.parcelPayment.updateMany({where:{id:p.id,status:'REFUND_PENDING'},data:{status:'REFUNDED',refundedAt:new Date()}});
     if(changed.count)outcome='parcel_refunded';
    }else outcome='unmatched_refund';
   }
   await tx.paymentWebhookEvent.update({where:{id:row.id},data:{processed:true,outcome}});return {received:true,outcome};
  });
 }
 @Post('razorpay/webhook')
 async razorpayWebhook(@Req() req:any,@Headers('x-razorpay-signature') signature:string,@Headers('x-razorpay-event-id') eventId:string){
  const razorConfig=await providerConfig(this.db,'RAZORPAY');if(!razorConfig.RAZORPAY_WEBHOOK_SECRET||!Buffer.isBuffer(req.rawBody)||!verifyRazorpaySignature(req.rawBody,signature||'',razorConfig.RAZORPAY_WEBHOOK_SECRET))throw new UnauthorizedException();
  const event=req.body,entity=event?.payload?.payment?.entity;if(!eventId||eventId.length>200||typeof event?.event!=='string')throw new BadRequestException();
  return this.db.$transaction(async tx=>{
   const eventKey=providerEventKey('razorpay',eventId);if(await tx.paymentWebhookEvent.findUnique({where:{providerEventId:eventKey}}))return {received:true,duplicate:true};
   const row=await tx.paymentWebhookEvent.create({data:{providerEventId:eventKey,eventType:event.event}});let outcome='ignored';
   if(event.event==='payment.captured'&&entity?.status==='captured'&&typeof entity.order_id==='string'&&typeof entity.id==='string'){
    const p=await tx.parcelPayment.findUnique({where:{providerOrderId:entity.order_id}});
    if(p&&p.provider==='RAZORPAY'&&p.status==='PENDING'&&entity.amount===p.amountPaise&&entity.currency==='INR'){
     const changed=await tx.parcelPayment.updateMany({where:{id:p.id,status:'PENDING'},data:{status:'RECORDED',providerPaymentId:entity.id,capturedAt:new Date()}});
     if(changed.count){await tx.parcelDelivery.update({where:{id:p.parcelId},data:{parcelPaymentStatus:'COLLECTED',parcelPaymentMethod:'RAZORPAY',parcelPaymentRecordedAt:new Date()}});outcome='captured';}
    }else outcome='unmatched';
   }
   if(event.event==='refund.processed'){
    const refund=event?.payload?.refund?.entity;
    if(refund?.id&&refund?.payment_id&&refund?.status==='processed'){
     const p=await tx.parcelPayment.findUnique({where:{providerPaymentId:refund.payment_id}});
     if(p?.provider==='RAZORPAY'&&p.status==='REFUND_PENDING'&&p.refundProviderId===refund.id&&refund.amount===p.amountPaise){
      const changed=await tx.parcelPayment.updateMany({where:{id:p.id,status:'REFUND_PENDING'},data:{status:'REFUNDED',refundedAt:new Date()}});
      if(changed.count)outcome='parcel_refunded';
     }else outcome='unmatched_refund';
    }
   }
   await tx.paymentWebhookEvent.update({where:{id:row.id},data:{processed:true,outcome}});return {received:true,outcome};
  });
 }
}

// Refund requests are restricted to administrators; gateway confirmation remains authoritative.
@Controller('admin/parcel-payments')
@UseGuards(JwtAuthGuard,RolesGuard)
@Roles('ADMIN')
export class AdminParcelPaymentController {
 constructor(private readonly db:Database){}
 @Get('reconciliation')
 async reconciliation(){
  const payments=await this.db.parcelPayment.findMany({orderBy:{createdAt:'desc'},take:250});
  return {payments:payments.map(p=>({id:p.id,parcelId:p.parcelId,provider:p.provider,status:p.status,amountPaise:p.amountPaise,currency:p.currency,providerPaymentId:p.providerPaymentId,providerOrderId:p.providerOrderId,stripeIntentId:p.stripeIntentId,refundProviderId:p.refundProviderId,refundRequestedAt:p.refundRequestedAt,refundedAt:p.refundedAt,createdAt:p.createdAt})),note:'Internal reconciliation only. Compare provider payout reports and bank deposits separately.'};
 }
 @Post(':paymentId/refund')
 async refund(@Param('paymentId') id:string,@Body() body:{reason?:string}){
  const p=await this.db.parcelPayment.findUnique({where:{id}});
  if(!p||p.status!=='RECORDED'||!p.providerPaymentId)throw new BadRequestException('Only captured parcel payments can be refunded');
  const reason=String(body?.reason||'requested_by_customer').slice(0,200);
  // Claim before contacting a provider. Concurrent requests must not issue two refunds.
  const claim=await this.db.parcelPayment.updateMany({where:{id:p.id,status:'RECORDED'},data:{status:'REFUND_REQUESTING',refundRequestedAt:new Date(),refundReason:reason}});
  if(claim.count!==1)throw new ConflictException('Refund already requested; reconcile existing attempt');
  let refundId:string|undefined;
  try {
  if(p.provider==='STRIPE'){
   const stripeRefundConfig=await providerConfig(this.db,'STRIPE');if(!p.stripeIntentId||!stripeRefundConfig.STRIPE_SECRET_KEY)throw new HttpException('Stripe not configured',503);
   const response=await fetch('https://api.stripe.com/v1/refunds',{method:'POST',headers:{Authorization:`Bearer ${stripeRefundConfig.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`rideflow-parcel-refund-${p.id}`},body:new URLSearchParams({payment_intent:p.stripeIntentId,reason:'requested_by_customer'}).toString()});
   if(!response.ok)throw new HttpException('Stripe refund request failed',502);
   const result=await response.json() as any;
   if(result.amount!==p.amountPaise||result.currency!=='inr'||result.payment_intent!==p.stripeIntentId)throw new HttpException('Stripe refund mismatch',502);
   refundId=result.id;
  }else if(p.provider==='RAZORPAY'){
   const razorRefundConfig=await providerConfig(this.db,'RAZORPAY');if(!razorRefundConfig.RAZORPAY_KEY_ID||!razorRefundConfig.RAZORPAY_KEY_SECRET)throw new HttpException('Razorpay not configured',503);
   const auth=Buffer.from(`${razorRefundConfig.RAZORPAY_KEY_ID}:${razorRefundConfig.RAZORPAY_KEY_SECRET}`).toString('base64');
   const response=await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(p.providerPaymentId)}/refund`,{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({amount:p.amountPaise,notes:{parcelId:p.parcelId,parcelPaymentId:p.id}})});
   if(!response.ok)throw new HttpException('Razorpay refund request failed',502);
   const result=await response.json() as any;
   if(result.amount!==p.amountPaise||result.payment_id!==p.providerPaymentId)throw new HttpException('Razorpay refund mismatch',502);
   refundId=result.id;
  }else throw new BadRequestException('Unsupported gateway');
  if(typeof refundId!=='string'||!refundId)throw new HttpException('Invalid provider refund response',502);
  const changed=await this.db.parcelPayment.updateMany({where:{id:p.id,status:'REFUND_REQUESTING'},data:{status:'REFUND_PENDING',refundProviderId:refundId}});
  if(changed.count!==1)throw new ConflictException('Refund submitted but local state changed; manual reconciliation required');
  return {status:'REFUND_PENDING',refundId,notice:'Refund requested; awaiting verified provider event'};
  } catch(error) {
   // An HTTP timeout may mean the gateway accepted the refund. Never reset to
   // RECORDED and retry automatically: this could issue a second refund.
   await this.db.parcelPayment.updateMany({where:{id:p.id,status:'REFUND_REQUESTING'},data:{status:'REFUND_REVIEW'}});
   throw error;
  }
 }
}
