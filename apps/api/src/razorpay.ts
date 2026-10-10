import { BadRequestException, Controller, Headers, HttpException, HttpStatus, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { verifyRazorpaySignature, providerEventKey } from './payment-signatures';
import { Database } from './database';
import { providerConfig } from './payment-credentials';
import { MobileGuard } from './mobile-auth';
import { PushService } from './push';

@Controller('payments/razorpay') export class RazorpayController {
 constructor(private readonly db:Database,private readonly push:PushService){}

 // Order creation uses Razorpay's server-side REST API. Never expose key secret to Flutter.
 @Post('orders/:rideId') @UseGuards(MobileGuard)
 async createOrder(@Req() req:any,@Param('rideId') rideId:string){
  if(req.mobile?.role!=='CUSTOMER')throw new UnauthorizedException();
  const ride=await this.db.ride.findUnique({where:{id:rideId}});
  if(!ride||ride.customerId!==req.mobile.sub||ride.status==='CANCELLED')throw new BadRequestException('Ride unavailable');
  if(ride.poolGroupId){
   const group=await this.db.poolGroup.findUnique({where:{id:ride.poolGroupId}});
   if(group?.status!=='ASSIGNED'||!ride.poolFareApprovedAt||!ride.poolConsentAt||!ride.poolFarePaise||ride.poolFarePaise<50)throw new BadRequestException('Approved pooled fare required');
  }
  const payment=await this.db.ridePayment.findUnique({where:{rideId}});
  if(!payment||payment.method!=='UPI'||payment.status!=='PENDING'||payment.amountPaise<=0||(ride.poolGroupId&&payment.amountPaise!==ride.poolFarePaise))throw new BadRequestException('UPI payment not pending');
  const {RAZORPAY_KEY_ID:keyId,RAZORPAY_KEY_SECRET:secret}=await providerConfig(this.db,'RAZORPAY');
  if(!keyId||!secret)throw new HttpException('Payment provider not configured',503);
  if(payment.providerOrderId)return {orderId:payment.providerOrderId,keyId,amountPaise:payment.amountPaise,currency:'INR',status:'PENDING'};
  const response=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(keyId+':'+secret).toString('base64'),'Content-Type':'application/json'},body:JSON.stringify({amount:payment.amountPaise,currency:'INR',receipt:payment.id,notes:{rideId}})});
  if(!response.ok)throw new HttpException('Payment provider order creation failed',502);
  const order=await response.json() as {id?:string,amount?:number,currency?:string};
  if(!order.id||order.amount!==payment.amountPaise||order.currency!=='INR')throw new HttpException('Unexpected payment provider response',502);
  const result=await this.db.ridePayment.updateMany({where:{id:payment.id,status:'PENDING',providerOrderId:null},data:{providerOrderId:order.id}});
  if(result.count!==1)throw new HttpException('Concurrent order creation; retry',409);
  return {orderId:order.id,keyId,amountPaise:payment.amountPaise,currency:'INR',status:'PENDING'};
 }

 // Configure Razorpay to deliver payment.captured events. Signature is HMAC-SHA256 of exact raw bytes.
 @Post('webhook')
 async webhook(@Req() req:any,@Headers('x-razorpay-signature') signature:string,@Headers('x-razorpay-event-id') eventId:string){
  const secret=(await providerConfig(this.db,'RAZORPAY')).RAZORPAY_WEBHOOK_SECRET;
  if(!secret||!req.rawBody||!verifyRazorpaySignature(req.rawBody,signature||'',secret))throw new UnauthorizedException('Invalid webhook signature');
  const event=req.body;
  if(!eventId||eventId.length>200||!event||typeof event.event!=='string')throw new BadRequestException('Invalid webhook event');
  const entity=event.payload?.payment?.entity;
  const result=await this.db.$transaction(async tx=>{
   const existing=await tx.paymentWebhookEvent.findUnique({where:{providerEventId:providerEventKey('razorpay', eventId)}});
   if(existing)return {duplicate:true,outcome:existing.outcome};
   const record=await tx.paymentWebhookEvent.create({data:{providerEventId:providerEventKey('razorpay', eventId),eventType:event.event,providerPaymentId:typeof entity?.id==='string'?entity.id:null}});
   let outcome='ignored';
   if(event.event==='payment.captured'&&entity?.status==='captured'&&typeof entity.order_id==='string'&&typeof entity.id==='string'){
    const payment=await tx.ridePayment.findUnique({where:{providerOrderId:entity.order_id}});
    if(payment&&payment.method==='UPI'&&payment.amountPaise===entity.amount&&entity.currency==='INR'){
     const updated=await tx.ridePayment.updateMany({where:{id:payment.id,status:'PENDING',method:'UPI',providerOrderId:entity.order_id},data:{status:'RECORDED',providerPaymentId:entity.id,providerCapturedAt:new Date(),collectedAt:new Date()}});
     outcome=updated.count===1?'captured':'already-processed';
    }else outcome='unmatched-order-or-amount';
   }
   if(event.event==='refund.processed'){
    const refund=event.payload?.refund?.entity;
    if(typeof refund?.id==='string'&&refund.status==='processed'){
     const p=await tx.ridePayment.findUnique({where:{refundProviderId:refund.id}});
     if(p&&p.status==='REFUND_PENDING'&&refund.amount===p.amountPaise){await tx.ridePayment.updateMany({where:{id:p.id,status:'REFUND_PENDING'},data:{status:'REFUNDED',refundedAt:new Date()}});outcome='refunded';}
    }
   }
   await tx.paymentWebhookEvent.update({where:{id:record.id},data:{processed:true,outcome}});
   return {duplicate:false,outcome};
  });
  if(!result.duplicate&&['captured','refunded'].includes(result.outcome)){
   const paymentId=event.event==='payment.captured'?entity?.order_id:event.payload?.refund?.entity?.id;
   const payment=event.event==='payment.captured'
    ?await this.db.ridePayment.findUnique({where:{providerOrderId:paymentId}})
    :await this.db.ridePayment.findUnique({where:{refundProviderId:paymentId}});
   if(payment)void this.push.sendPaymentUpdate(payment.rideId,result.outcome as 'captured'|'refunded').catch(()=>{});
  }
  return {received:true,...result};
 }
}
