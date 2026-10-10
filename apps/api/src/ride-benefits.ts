import { providerConfig } from './payment-credentials';
import { channelEnabled } from './payment-channels';
import { Controller, Get, Post, Param, Body, Req, UseGuards, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { Database } from './database';
import { MobileGuard } from './mobile-auth';
import { JwtAuthGuard, RolesGuard, Roles } from './security';

@Controller('mobile/rides') @UseGuards(MobileGuard)
export class MobileRideBenefitsController {
 constructor(private db:Database){}
 @Post(':id/coupon-preview') async preview(@Req() req:any,@Param('id') id:string,@Body() body:{code?:string}){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const code=typeof body?.code==='string'?body.code.trim().toUpperCase():'';
  if(!/^[A-Z0-9_-]{3,24}$/.test(code))throw new BadRequestException('Invalid coupon code');
  return this.db.$transaction(async tx=>{
   const ride=await tx.ride.findUnique({where:{id}});
   if(!ride||ride.customerId!==req.mobile.sub)throw new ForbiddenException();
   const payMethod=await tx.ridePayment.findUnique({where:{rideId:id},select:{method:true}});
   if(!payMethod||payMethod.method==='CASH')throw new ConflictException('Coupons and tips are unavailable for COD rides');
   if(!['REQUESTED','MATCHING','ASSIGNED','ARRIVING'].includes(ride.status))throw new ConflictException('Ride is not eligible for coupon preview');
   const coupon=await tx.rideCoupon.findUnique({where:{code}});
   if(!coupon||!coupon.active||coupon.expiresAt<=new Date()||(coupon.redemptionLimit!==null&&coupon.redeemedCount>=coupon.redemptionLimit))throw new BadRequestException('Coupon unavailable');
   if(coupon.percentOff<1||coupon.percentOff>100||coupon.maxDiscountPaise<0)throw new ConflictException('Invalid promotion configuration');
   const basePaise=ride.poolGroupId?ride.poolFarePaise:ride.farePaise;
   if(basePaise==null||basePaise<0)throw new ConflictException('Pooled fare not finalized');
   const discountPaise=Math.min(coupon.maxDiscountPaise,Math.floor(basePaise*coupon.percentOff/100));
   const expiresAt=new Date(Math.min(coupon.expiresAt.getTime(),Date.now()+5*60_000));
   const preview=await tx.rideCouponPreview.create({data:{rideId:id,customerId:req.mobile.sub,couponId:coupon.id,basePaise,discountPaise,quotedPaise:basePaise-discountPaise,expiresAt}});
   return {previewId:preview.id,basePaise,discountPaise,quotedPaise:preview.quotedPaise,expiresAt,applied:false,notice:'Preview only: checkout and payment amounts remain unchanged.'};
  });
 }
 @Post(':id/apply-coupon') async applyCoupon(@Req() req:any,@Param('id') id:string,@Body() body:{previewId?:string}){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  if(typeof body?.previewId!=='string'||!body.previewId)throw new BadRequestException('Preview required');
  return this.db.$transaction(async tx=>{
   // Serialize coupon redemption, ride payment and gateway initiation across API workers.
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rideflow_coupon_${id}`}))`;
   const prior=await tx.rideCouponRedemption.findUnique({where:{rideId:id}});
   if(prior){if(prior.previewId===body.previewId&&prior.customerId===req.mobile.sub)return {applied:true,chargedPaise:prior.chargedPaise,discountPaise:prior.discountPaise,redemptionId:prior.id,duplicate:true};throw new ConflictException('Coupon already applied to ride');}
   const ride=await tx.ride.findUnique({where:{id}});
   if(!ride||ride.customerId!==req.mobile.sub)throw new ForbiddenException();
   const payMethod=await tx.ridePayment.findUnique({where:{rideId:id},select:{method:true}});
   if(!payMethod||payMethod.method==='CASH')throw new ConflictException('Coupons and tips are unavailable for COD rides');
   // Pooling approval has a separate fare contract; do not mutate it here.
   if(ride.poolGroupId)throw new ConflictException('Pooling coupons require separate fare reapproval');
   if(!['REQUESTED','MATCHING','ASSIGNED','ARRIVING'].includes(ride.status))throw new ConflictException('Ride not eligible');
   const preview=await tx.rideCouponPreview.findUnique({where:{id:body.previewId}});
   if(!preview||preview.rideId!==id||preview.customerId!==req.mobile.sub||preview.expiresAt<=new Date()||preview.basePaise!==ride.farePaise)throw new ConflictException('Coupon preview expired or fare changed');
   const coupon=await tx.rideCoupon.findUnique({where:{id:preview.couponId}});
   if(!coupon||!coupon.active||coupon.expiresAt<=new Date()||coupon.percentOff<1||coupon.percentOff>100||coupon.maxDiscountPaise<0)throw new ConflictException('Coupon no longer valid');
   const discount=Math.min(coupon.maxDiscountPaise,Math.floor(ride.farePaise*coupon.percentOff/100));
   const amount=ride.farePaise-discount;
   if(amount!==preview.quotedPaise||discount!==preview.discountPaise||amount<50)throw new ConflictException('Discounted amount invalid; request a new preview');
   const payment=await tx.ridePayment.findUnique({where:{rideId:id}});
   if(!payment||payment.status!=='PENDING'||payment.method!=='ONLINE'||payment.amountPaise!==ride.farePaise||payment.stripeIntentId||payment.providerOrderId||payment.providerPaymentId||payment.upiReference||payment.upiInitiatedAt||payment.stripeClientSecretIssuedAt||payment.refundRequestedAt)throw new ConflictException('Payment already initiated or incompatible');
   const updated=await tx.rideCoupon.updateMany({where:{id:coupon.id,active:true,expiresAt:{gt:new Date()},...(coupon.redemptionLimit===null?{}:{redeemedCount:{lt:coupon.redemptionLimit}})},data:{redeemedCount:{increment:1}}});
   if(updated.count!==1)throw new ConflictException('Coupon exhausted');
   const changed=await tx.ridePayment.updateMany({where:{id:payment.id,status:'PENDING',amountPaise:ride.farePaise,stripeIntentId:null,providerOrderId:null,providerPaymentId:null},data:{amountPaise:amount}});
   if(changed.count!==1)throw new ConflictException('Payment changed concurrently');
   const redemption=await tx.rideCouponRedemption.create({data:{rideId:id,customerId:req.mobile.sub,couponId:coupon.id,previewId:preview.id,basePaise:ride.farePaise,discountPaise:discount,chargedPaise:amount}});
   return {applied:true,chargedPaise:amount,discountPaise:discount,redemptionId:redemption.id,notice:'Coupon applied to pending online payment; no charge has been made.'};
  });
 }
 @Post(':id/tip-intent') async tip(@Req() req:any,@Param('id') id:string,@Body() body:{amountPaise?:number}){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const amount=body?.amountPaise;
  if(!Number.isSafeInteger(amount)||(amount as number)<0||(amount as number)>200000)throw new BadRequestException('Tip must be between ₹0 and ₹2,000');
  return this.db.$transaction(async tx=>{
   const ride=await tx.ride.findUnique({where:{id}});
   if(!ride||ride.customerId!==req.mobile.sub)throw new ForbiddenException();
   const payMethod=await tx.ridePayment.findUnique({where:{rideId:id},select:{method:true}});
   if(!payMethod||payMethod.method==='CASH')throw new ConflictException('Coupons and tips are unavailable for COD rides');
   if(ride.status!=='COMPLETED')throw new ConflictException('Tips can be requested after trip completion');
   const existing=await tx.rideTipIntent.findUnique({where:{rideId:id}});
   if(existing)throw new ConflictException('Tip request already exists; no repeat charges');
   const saved=await tx.rideTipIntent.create({data:{rideId:id,customerId:req.mobile.sub,amountPaise:amount!,status:'NOT_CHARGED'}});
   return {tipIntentId:saved.id,amountPaise:saved.amountPaise,status:saved.status,notice:'Tip intent recorded only; no payment or driver payout has occurred.'};
  });
 }
 @Post(':id/prepare-tip-payment') async prepareTipPayment(@Req() req:any,@Param('id') id:string,@Body() body:{idempotencyKey?:string}){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const key=body?.idempotencyKey;
  if(typeof key!=='string'||!/^[-_a-zA-Z0-9]{12,100}$/.test(key))throw new BadRequestException('Valid idempotency key required');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rideflow_tip_${id}`}))`;
   const ride=await tx.ride.findUnique({where:{id}});
   if(!ride||ride.customerId!==req.mobile.sub)throw new ForbiddenException();
   const payMethod=await tx.ridePayment.findUnique({where:{rideId:id},select:{method:true}});
   if(!payMethod||payMethod.method==='CASH')throw new ConflictException('Coupons and tips are unavailable for COD rides');
   if(ride.status!=='COMPLETED')throw new ConflictException('Ride must be completed');
   const intent=await tx.rideTipIntent.findUnique({where:{rideId:id}});
   if(!intent||intent.customerId!==req.mobile.sub||intent.status!=='NOT_CHARGED'||intent.amountPaise<=0)throw new ConflictException('Positive uncharged tip intent required');
   const existing=await tx.rideTipPayment.findUnique({where:{rideId:id}});
   if(existing){if(existing.idempotencyKey!==key)throw new ConflictException('Tip payment already prepared with a different key');return {paymentId:existing.id,status:existing.status,amountPaise:existing.amountPaise,duplicate:true,notice:'No charge has been made'};}
   const collision=await tx.rideTipPayment.findUnique({where:{idempotencyKey:key}});
   if(collision)throw new ConflictException('Idempotency key already used');
   const payment=await tx.rideTipPayment.create({data:{rideId:id,tipIntentId:intent.id,customerId:req.mobile.sub,amountPaise:intent.amountPaise,idempotencyKey:key,status:'PREPARED'}});
   return {paymentId:payment.id,status:payment.status,amountPaise:payment.amountPaise,duplicate:false,notice:'Prepared only; no gateway charge or driver payout'};
  });
 }
 @Post(':id/start-tip-checkout') async startTipCheckout(@Req() req:any,@Param('id') id:string,@Body() body:{idempotencyKey?:string}){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const key=body?.idempotencyKey;
  if(typeof key!=='string'||!/^[-_a-zA-Z0-9]{12,100}$/.test(key))throw new BadRequestException('Valid idempotency key required');
  if(!await channelEnabled(this.db,'ONLINE'))throw new ConflictException('Online payments disabled');
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.customerId!==req.mobile.sub||ride.status!=='COMPLETED')throw new ForbiddenException();
  const base=await this.db.ridePayment.findUnique({where:{rideId:id}});
  if(!base||base.method==='CASH')throw new ConflictException('COD tips unavailable');
  const tip=await this.db.rideTipPayment.findUnique({where:{rideId:id}});
  if(!tip||tip.customerId!==req.mobile.sub||tip.idempotencyKey!==key||!['PREPARED','AWAITING_PAYMENT'].includes(tip.status))throw new ConflictException('Prepare tip payment first');
  if(tip.providerPaymentId){return {paymentId:tip.id,status:tip.status,provider:'STRIPE',gatewayReference:tip.providerPaymentId,notice:'Existing gateway intent; obtain checkout secret through a fresh authenticated checkout session'};}
  const cfg=await providerConfig(this.db,'STRIPE');
  if(!cfg.STRIPE_SECRET_KEY)throw new ConflictException('Stripe credentials not configured');
  const params=new URLSearchParams({amount:String(tip.amountPaise),currency:'inr','metadata[tipPaymentId]':tip.id,'metadata[rideId]':id,'automatic_payment_methods[enabled]':'true'});
  const response=await fetch('https://api.stripe.com/v1/payment_intents',{method:'POST',headers:{Authorization:`Bearer ${cfg.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`rideflow-tip-${tip.id}`},body:params.toString(),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new ConflictException('Gateway checkout unavailable');
  const intent:any=await response.json();
  if(!intent?.id||!intent?.client_secret||intent.amount!==tip.amountPaise||intent.currency!=='inr'||intent.metadata?.tipPaymentId!==tip.id)throw new ConflictException('Gateway checkout mismatch');
  const updated=await this.db.rideTipPayment.updateMany({where:{id:tip.id,status:'PREPARED',providerPaymentId:null},data:{provider:'STRIPE',providerPaymentId:intent.id,status:'AWAITING_PAYMENT',gatewayClientSecretIssuedAt:new Date()}});
  if(updated.count!==1)throw new ConflictException('Tip payment state changed; retry with same key');
  return {paymentId:tip.id,status:'AWAITING_PAYMENT',provider:'STRIPE',gatewayReference:intent.id,clientSecret:intent.client_secret,notice:'Gateway intent created; payment not yet verified'};
 }
 @Post(':id/start-razorpay-tip-checkout') async startRazorpayTipCheckout(@Req() req:any,@Param('id') id:string,@Body() body:{idempotencyKey?:string}){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const key=body?.idempotencyKey;
  if(typeof key!=='string'||!/^[-_a-zA-Z0-9]{12,100}$/.test(key))throw new BadRequestException('Valid idempotency key required');
  if(!await channelEnabled(this.db,'ONLINE'))throw new ConflictException('Online payments disabled');
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.customerId!==req.mobile.sub||ride.status!=='COMPLETED')throw new ForbiddenException();
  const base=await this.db.ridePayment.findUnique({where:{rideId:id}});
  if(!base||base.method==='CASH')throw new ConflictException('COD tips unavailable');
  const tip=await this.db.rideTipPayment.findUnique({where:{rideId:id}});
  if(!tip||tip.customerId!==req.mobile.sub||tip.idempotencyKey!==key||!['PREPARED','AWAITING_PAYMENT'].includes(tip.status))throw new ConflictException('Prepare tip payment first');
  if(tip.providerPaymentId){
   if(tip.provider!=='RAZORPAY')throw new ConflictException('Tip checkout already bound to another gateway');
   const config=await providerConfig(this.db,'RAZORPAY');
   return {paymentId:tip.id,status:tip.status,provider:'RAZORPAY',gatewayReference:tip.providerPaymentId,keyId:config.RAZORPAY_KEY_ID,amountPaise:tip.amountPaise,notice:'Existing order; no additional gateway order created'};
  }
  const config=await providerConfig(this.db,'RAZORPAY');
  if(!config.RAZORPAY_KEY_ID||!config.RAZORPAY_KEY_SECRET)throw new ConflictException('Razorpay credentials not configured');
  const auth=Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({amount:tip.amountPaise,currency:'INR',receipt:tip.id.slice(0,40),notes:{tipPaymentId:tip.id,rideId:id}}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new ConflictException('Gateway order creation failed');
  const order:any=await response.json();
  if(typeof order?.id!=='string'||!order.id.startsWith('order_')||order.amount!==tip.amountPaise||order.currency!=='INR'||order.notes?.tipPaymentId!==tip.id)throw new ConflictException('Gateway order mismatch');
  const changed=await this.db.rideTipPayment.updateMany({where:{id:tip.id,status:'PREPARED',providerPaymentId:null},data:{provider:'RAZORPAY',providerPaymentId:order.id,status:'AWAITING_PAYMENT'}});
  if(changed.count!==1)throw new ConflictException('Tip payment state changed; reconcile orphaned gateway order before retry');
  return {paymentId:tip.id,status:'AWAITING_PAYMENT',provider:'RAZORPAY',gatewayReference:order.id,keyId:config.RAZORPAY_KEY_ID,amountPaise:tip.amountPaise,notice:'Gateway order created; payment not yet verified'};
 }
 @Get(':id/tip-payment') async tipPaymentStatus(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.customerId!==req.mobile.sub)throw new ForbiddenException();
   const payMethod=await this.db.ridePayment.findUnique({where:{rideId:id},select:{method:true}});
   if(!payMethod||payMethod.method==='CASH')throw new ConflictException('Coupons and tips are unavailable for COD rides');
  const payment=await this.db.rideTipPayment.findUnique({where:{rideId:id}});
  return {payment:payment?{id:payment.id,status:payment.status,amountPaise:payment.amountPaise,currency:payment.currency,preparedAt:payment.preparedAt}:null,notice:'PREPARED is not charged or settled'};
 }
 @Get(':id/tip-intent') async tipStatus(@Req() req:any,@Param('id') id:string){
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||!(req.mobile.role==='CUSTOMER'&&ride.customerId===req.mobile.sub||req.mobile.role==='DRIVER'&&ride.driverId===req.mobile.sub))throw new ForbiddenException();
  return {tip:await this.db.rideTipIntent.findUnique({where:{rideId:id}}),notice:'NOT_CHARGED is not a payment confirmation'};
 }
}

@Controller('admin/pooling') @UseGuards(JwtAuthGuard,RolesGuard)
export class AdminPoolSettlementController {
 constructor(private db:Database){}
 @Get('groups/:id/settlement-assessment') @Roles('ADMIN') async assessment(@Param('id') id:string){
  const review=await this.db.poolCancellationReview.findUnique({where:{groupId:id}});
  if(!review||review.status!=='PENDING_REVIEW')throw new ConflictException('Pending review required');
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  if(!group||group.rides.length!==2)throw new ConflictException('Group changed');
  const payments=await this.db.ridePayment.findMany({where:{rideId:{in:group.rides.map(r=>r.id)}}});
  const evidence=await this.db.poolGatewayReconciliation.findFirst({where:{groupId:id,reviewId:review.id},orderBy:{checkedAt:'desc'}});
  const reasons:string[]=[];
  if(payments.length!==2)reasons.push('Missing passenger payment records');
  if(!evidence||!evidence.allVerified)reasons.push('No complete verified gateway observation');
  if(!evidence||Date.now()-evidence.checkedAt.getTime()>5*60_000)reasons.push('Gateway observation is stale');
  if(payments.some(p=>p.refundRequestedAt||p.refundProviderId||p.status==='REFUND_PENDING'||p.status==='REFUNDED'))reasons.push('Existing refund activity requires investigation');
  if(payments.some(p=>!p.providerCapturedAt))reasons.push('Provider capture timestamp missing (not settlement proof)');
  // Captured payment is NOT settlement confirmation. No approval or refund execution permitted.
  reasons.push('Independent gateway settlement and refund eligibility have not been established');
  return {groupId:id,reviewId:review.id,eligibleForAutomaticRefund:false,eligibleForCancellationApproval:false,manualReviewRequired:true,reasons,evidenceId:evidence?.id??null,notice:'Read-only assessment; no cancellation, refund, driver release or payment mutation.'};
 }
}
