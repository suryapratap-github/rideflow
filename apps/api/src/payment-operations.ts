import { BadRequestException, Body, Controller, Get, HttpException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Database } from './database';
import { JwtAuthGuard, Roles, RolesGuard } from './security';

// Admin-only reconciliation and refund requests. A request is NOT a completed refund.
@Controller('admin/payments')
@UseGuards(JwtAuthGuard,RolesGuard)
@Roles('ADMIN')
export class PaymentOperationsController {
 constructor(private readonly db:Database){}
 @Get('reconciliation') async reconciliation(){
  const payments=await this.db.ridePayment.findMany({orderBy:{createdAt:'desc'},take:250});
  const events=await this.db.paymentWebhookEvent.findMany({orderBy:{receivedAt:'desc'},take:100});
  return {payments:payments.map(p=>({id:p.id,rideId:p.rideId,method:p.method,status:p.status,amountPaise:p.amountPaise,providerOrderId:p.providerOrderId,providerPaymentId:p.providerPaymentId,stripeIntentId:p.stripeIntentId,refundProviderId:p.refundProviderId,refundRequestedAt:p.refundRequestedAt,refundedAt:p.refundedAt,createdAt:p.createdAt})),events:events.map(e=>({id:e.id,eventType:e.eventType,outcome:e.outcome,processed:e.processed,receivedAt:e.receivedAt})),note:'Provider settlement reconciliation requires independent provider balance/settlement exports.'};
 }
 @Post(':paymentId/refund') async refund(@Param('paymentId') paymentId:string,@Body() body:{reason?:string}){
  const p=await this.db.ridePayment.findUnique({where:{id:paymentId}});
  if(!p||p.status!=='RECORDED'||!p.providerPaymentId)throw new BadRequestException('Only verified captured online payments can be refunded');
  if(!['ONLINE','UPI'].includes(p.method))throw new BadRequestException('Cash refunds require manual processing');
  const reason=(body?.reason||'requested_by_customer').slice(0,200);
  let providerRefundId:string;
  if(p.method==='ONLINE'){
   if(!p.stripeIntentId||!process.env.STRIPE_SECRET_KEY)throw new HttpException('Stripe not configured',503);
   const resp=await fetch('https://api.stripe.com/v1/refunds',{method:'POST',headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`rideflow-refund-${p.id}`},body:new URLSearchParams({payment_intent:p.stripeIntentId,reason:'requested_by_customer'}).toString()});
   if(!resp.ok)throw new HttpException('Stripe refund request failed',502);
   const data=await resp.json() as any;providerRefundId=data.id;
  }else{
   if(!p.providerOrderId||!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)throw new HttpException('Razorpay not configured',503);
   const auth=Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
   const resp=await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(p.providerPaymentId)}/refund`,{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json','X-Razorpay-Idempotency-Key':`rideflow-refund-${p.id}`},body:JSON.stringify({amount:p.amountPaise,notes:{rideId:p.rideId}})});
   if(!resp.ok)throw new HttpException('Razorpay refund request failed',502);
   const data=await resp.json() as any;providerRefundId=data.id;
  }
  if(!providerRefundId)throw new HttpException('Invalid provider refund response',502);
  const changed=await this.db.ridePayment.updateMany({where:{id:p.id,status:'RECORDED'},data:{status:'REFUND_PENDING',refundProviderId:providerRefundId,refundRequestedAt:new Date(),refundReason:reason}});
  if(changed.count!==1)throw new HttpException('Refund submitted to provider; reconcile before retry',409);
  return {status:'REFUND_PENDING',refundId:providerRefundId,notice:'Await verified provider refund confirmation'};
 }
}
