import { Body, Controller, Get, Patch, Post, Param, Req, UseGuards, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { Database } from './database';
import { MobileGuard } from './mobile-auth';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { compatiblePoolRides } from './pooling-matcher';
import { capacityForType, validatePoolGroup } from './pooling-group';
import { buildPoolStopPreview } from './pooling-route';
import { fetchOsrmRoute, validateRoadPool } from './pooling-road';
import { JwtAuthGuard, RolesGuard, Roles } from './security';
import { checkPoolGateway } from './pooling-gateway-reconcile';
export const POOLING_KEY='ride_pooling';
export async function poolingEnabled(db:Database):Promise<boolean>{
 const setting=await db.serviceSetting.findUnique({where:{key:POOLING_KEY}});
 return setting?.enabled ?? true;
}
class PoolingSettingDto { @IsBoolean() enabled!:boolean; }
@Controller('admin/pooling') @UseGuards(JwtAuthGuard,RolesGuard)
export class AdminPoolingController {
 constructor(private db:Database){}
 @Get('settings') @Roles('ADMIN','DISPATCH') async settings(){return {enabled:await poolingEnabled(this.db)};}
 @Get('candidates') @Roles('ADMIN','DISPATCH') async candidates(){
  if(!await poolingEnabled(this.db))return {enabled:false,pairs:[],notice:'Pooling is disabled; no new matches are suggested.'};
  const rides=await this.db.ride.findMany({where:{poolingRequested:true,status:{in:['REQUESTED','MATCHING']},type:{in:['MINI','SEDAN','SUV']}},orderBy:{createdAt:'desc'},take:150});
  const pairs: {firstRideId:string;secondRideId:string;pickupGapKm:number;dropoffGapKm:number}[]=[];
  for(let i=0;i<rides.length;i++)for(let j=i+1;j<rides.length;j++){
   const match=compatiblePoolRides(rides[i],rides[j]);
   if(match)pairs.push({firstRideId:rides[i].id,secondRideId:rides[j].id,...match});
  }
  pairs.sort((a,b)=>a.pickupGapKm+a.dropoffGapKm-b.pickupGapKm-b.dropoffGapKm);
  return {enabled:true,pairs:pairs.slice(0,30),notice:'Suggestions only: no shared dispatch, seat allocation, route detour or discounted fare is applied.'};
 }
 @Post('groups') @Roles('ADMIN','DISPATCH') async createGroup(@Body() body:{rideIds?:string[]}) {
  if(!await poolingEnabled(this.db))throw new BadRequestException('Pooling is disabled');
  const ids=body?.rideIds;
  if(!Array.isArray(ids)||ids.length!==2||ids.some(id=>typeof id!=='string')||new Set(ids).size!==2)throw new BadRequestException('Exactly two distinct ride IDs required');
  return this.db.$transaction(async tx=>{
   // Serializes competing grouping requests, including requests on different API instances.
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   const rides=await tx.ride.findMany({where:{id:{in:ids}}});
   if(rides.length!==2)throw new BadRequestException('Ride not found');
   const reason=validatePoolGroup(rides);
   if(reason)throw new ConflictException(reason);
   const capacity=capacityForType(rides[0].type);
   const group=await tx.poolGroup.create({data:{cityId:rides[0].cityId,vehicleType:rides[0].type,seatCapacity:capacity}});
   const result=await tx.ride.updateMany({where:{id:{in:ids},poolGroupId:null,status:{in:['REQUESTED','MATCHING']}},data:{poolGroupId:group.id}});
   if(result.count!==2)throw new ConflictException('Rides changed during grouping');
   await tx.auditLog.create({data:{actor:'DISPATCH',action:'POOL_GROUP_CREATED',resource:group.id}});
   return {groupId:group.id,rideIds:ids,seatCapacity:capacity,seatsUsed:rides.reduce((sum,r)=>sum+r.poolSeats,0),status:'FORMING',notice:'Grouping only. Do not dispatch or charge discounted fares until multi-stop route and consent are confirmed.'};
  });
 }
 @Post('groups/:id/dissolve') @Roles('ADMIN','DISPATCH') async dissolve(@Param('id') id:string){
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   const group=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   if(!group||group.status!=='FORMING')throw new ConflictException('Only forming groups may be dissolved');
   if(group.rides.some(r=>r.driverId||r.vehicleId||!['REQUESTED','MATCHING'].includes(r.status)))throw new ConflictException('Cannot dissolve dispatched group');
   await tx.ride.updateMany({where:{poolGroupId:id},data:{poolGroupId:null,poolConsentAt:null}});
   await tx.poolGroup.update({where:{id},data:{status:'DISSOLVED'}});
   await tx.auditLog.create({data:{actor:'DISPATCH',action:'POOL_GROUP_DISSOLVED',resource:id}});
   return {groupId:id,status:'DISSOLVED'};
  });
 }
 @Post('groups/:id/cancel-unpaid') @Roles('ADMIN','DISPATCH') async cancelUnpaid(@Param('id') id:string){
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   const group=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   if(!group||group.status!=='FORMING'||group.rides.length!==2)throw new ConflictException('Only unassigned forming groups may be cancelled automatically');
   if(group.driverId||group.vehicleId||group.currentStopIndex!==0||group.rides.some(r=>r.driverId||r.vehicleId||!['REQUESTED','MATCHING'].includes(r.status)))throw new ConflictException('Dispatched or progressed group requires manual reconciliation');
   const ids=group.rides.map(r=>r.id);
   const payments=await tx.ridePayment.findMany({where:{rideId:{in:ids}}});
   if(payments.length!==ids.length||payments.some(p=>p.status!=='PENDING'||p.providerOrderId||p.providerPaymentId||p.stripeIntentId||p.capturedAt||p.refundRequestedAt||p.refundProviderId))throw new ConflictException('Payment attempt or uncertain payment state; reconcile before cancellation');
   if(group.fareOfferedAt||group.rides.some(r=>r.poolFarePaise!==null||r.poolFareApprovedAt||r.poolFareExpiresAt))throw new ConflictException('Fare offers exist; reconcile before cancellation');
   const changed=await tx.ride.updateMany({where:{id:{in:ids},poolGroupId:id,status:{in:['REQUESTED','MATCHING']}},data:{status:'CANCELLED'}});
   if(changed.count!==ids.length)throw new ConflictException('Ride state changed during cancellation');
   await tx.poolGroup.update({where:{id},data:{status:'CANCELLED'}});
   await tx.auditLog.create({data:{actor:'DISPATCH',action:'POOL_GROUP_UNPAID_CANCELLED',resource:id}});
   return {groupId:id,status:'CANCELLED',rideIds:ids,notice:'No payment or refund was initiated'};
  },{isolationLevel:'Serializable'});
 }
 @Post('groups/:id/request-cancellation') @Roles('ADMIN','DISPATCH') async requestCancellation(@Param('id') id:string,@Body() body:{reason?:string}){
  const reason=typeof body?.reason==='string'?body.reason.trim():'';
  if(reason.length<8||reason.length>500)throw new BadRequestException('Reason must be 8 to 500 characters');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   const existing=await tx.poolCancellationReview.findUnique({where:{groupId:id}});
   if(existing){
    if(existing.status==='PENDING_REVIEW')return {requestId:existing.id,groupId:id,status:existing.status,alreadyRequested:true,notice:'Existing review remains pending; no ride or payment was changed'};
    throw new ConflictException('A prior cancellation review exists; resolve it before another request');
   }
   const group=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   if(!group||!['ASSIGNED','IN_PROGRESS'].includes(group.status)||group.rides.length!==2)throw new ConflictException('Only assigned or in-progress two-passenger groups may request review');
   if(group.rides.some(r=>!['ASSIGNED','ARRIVING','IN_PROGRESS'].includes(r.status)))throw new ConflictException('Ride status requires manual investigation');
   const ids=group.rides.map(r=>r.id);
   const payments=await tx.ridePayment.findMany({where:{rideId:{in:ids}}});
   if(payments.length!==2)throw new ConflictException('Missing payment record; investigate before review');
   // No automatic cancellation, refund, or driver release. Snapshot is for reconciliation only.
   const snapshot=payments.map(p=>({rideId:p.rideId,status:p.status,amountPaise:p.amountPaise,method:p.method,
    hasProviderOrder:!!p.providerOrderId,hasProviderPayment:!!p.providerPaymentId,
    hasStripeIntent:!!p.stripeIntentId,refundRequested:!!p.refundRequestedAt,
    captured:!!p.providerCapturedAt||!!p.collectedAt}));
   const review=await tx.poolCancellationReview.create({data:{groupId:id,requestedBy:'DISPATCH',reason,paymentSnapshotJson:JSON.stringify(snapshot)}});
   await tx.auditLog.create({data:{actor:'DISPATCH',action:'POOL_CANCELLATION_REVIEW_REQUESTED',resource:id}});
   return {requestId:review.id,groupId:id,status:review.status,payments:snapshot,notice:'Manual reconciliation required. Ride, driver assignment and payment state remain unchanged'};
  },{isolationLevel:'Serializable'});
 }
 @Get('cancellation-reviews') @Roles('ADMIN','DISPATCH') async cancellationReviews(){
  const reviews=await this.db.poolCancellationReview.findMany({where:{status:'PENDING_REVIEW'},orderBy:{createdAt:'asc'},take:100});
  return {reviews:reviews.map(r=>({requestId:r.id,groupId:r.groupId,status:r.status,reason:r.reason,createdAt:r.createdAt})),notice:'Pending queue only. Review payment records and gateway reconciliation outside this screen before any decision.'};
 }
 @Post('groups/:id/reject-cancellation') @Roles('ADMIN') async rejectCancellation(@Param('id') id:string,@Body() body:{reason?:string}){
  const reason=typeof body?.reason==='string'?body.reason.trim():'';
  if(reason.length<12||reason.length>500)throw new BadRequestException('Decision reason must be 12 to 500 characters');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   const review=await tx.poolCancellationReview.findUnique({where:{groupId:id}});
   if(!review||review.status!=='PENDING_REVIEW')throw new ConflictException('No pending cancellation review');
   const group=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   if(!group||!['ASSIGNED','IN_PROGRESS'].includes(group.status)||group.rides.length!==2)throw new ConflictException('Group state changed; investigate manually');
   const changed=await tx.poolCancellationReview.updateMany({where:{id:review.id,status:'PENDING_REVIEW'},data:{status:'REJECTED'}});
   if(changed.count!==1)throw new ConflictException('Review was already resolved');
   await tx.auditLog.create({data:{actor:'ADMIN',action:'POOL_CANCELLATION_REJECTED',resource:`${id}: ${reason}`.slice(0,500)}});
   return {groupId:id,status:'REJECTED',notice:'Cancellation request rejected; no ride, driver or payment record was modified. Normal stop progression can resume.'};
  },{isolationLevel:'Serializable'});
 }
 @Get('groups/:id/cancellation-review') @Roles('ADMIN','DISPATCH') async cancellationReview(@Param('id') id:string){
  const review=await this.db.poolCancellationReview.findUnique({where:{groupId:id}}});
  if(!review)throw new BadRequestException('No cancellation review for this group');
  const live=await this.db.ridePayment.findMany({where:{rideId:{in:(JSON.parse(review.paymentSnapshotJson) as {rideId:string}[]).map(p=>p.rideId)}}});
  const livePayments=live.map(p=>({rideId:p.rideId,status:p.status,amountPaise:p.amountPaise,method:p.method,
   hasProviderOrder:!!p.providerOrderId,hasProviderPayment:!!p.providerPaymentId,hasStripeIntent:!!p.stripeIntentId,
   refundRequested:!!p.refundRequestedAt,captured:!!p.providerCapturedAt||!!p.collectedAt}));
  const snapshot=JSON.parse(review.paymentSnapshotJson) as {rideId:string}[];
  const complete=livePayments.length===snapshot.length&&snapshot.every(p=>livePayments.some(l=>l.rideId===p.rideId));
  return {requestId:review.id,groupId:id,status:review.status,reason:review.reason,createdAt:review.createdAt,
   paymentsAtRequest:snapshot,livePayments,complete,requiresGatewayReconciliation:true,
   notice:'Live database payment state is NOT a gateway status verification. No automatic cancellation or refund is permitted.'};
 }
 @Post('groups/:id/reconcile-gateway') @Roles('ADMIN') async reconcileGateway(@Param('id') id:string){
  const review=await this.db.poolCancellationReview.findUnique({where:{groupId:id}});
  if(!review||review.status!=='PENDING_REVIEW')throw new ConflictException('Pending cancellation review required');
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  if(!group||group.rides.length!==2)throw new ConflictException('Group changed; manual investigation required');
  const payments=await this.db.ridePayment.findMany({where:{rideId:{in:group.rides.map(r=>r.id)}}});
  if(payments.length!==2)throw new ConflictException('Missing payment records');
  // Read gateway data outside the DB transaction; never hold a DB lock over network I/O.
  const checks=[];
  for(const p of payments)checks.push(await checkPoolGateway(this.db,p));
  const allVerified=checks.length===2&&checks.every(c=>c.verified&&c.amountMatches===true);
  // A verified payment status is NOT proof of settlement or refund eligibility.
  // Preserve exact references/amounts so a later reviewer can detect changed records.
  const fingerprints=payments.map(p=>({rideId:p.rideId,amountPaise:p.amountPaise,
   status:p.status,stripeIntentId:p.stripeIntentId,providerPaymentId:p.providerPaymentId,
   providerOrderId:p.providerOrderId,refundProviderId:p.refundProviderId,
   refundRequestedAt:p.refundRequestedAt})).sort((a,b)=>a.rideId.localeCompare(b.rideId));
  const evidence=await this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   const current=await tx.poolCancellationReview.findUnique({where:{groupId:id}});
   if(!current||current.id!==review.id||current.status!=='PENDING_REVIEW')throw new ConflictException('Review changed while querying gateway');
   const latest=await tx.ridePayment.findMany({where:{rideId:{in:fingerprints.map(p=>p.rideId)}}});
   const latestFingerprint=latest.map(p=>({rideId:p.rideId,amountPaise:p.amountPaise,
    status:p.status,stripeIntentId:p.stripeIntentId,providerPaymentId:p.providerPaymentId,
    providerOrderId:p.providerOrderId,refundProviderId:p.refundProviderId,
    refundRequestedAt:p.refundRequestedAt})).sort((a,b)=>a.rideId.localeCompare(b.rideId));
   if(JSON.stringify(latestFingerprint)!==JSON.stringify(fingerprints))throw new ConflictException('Payment changed during gateway check; retry reconciliation');
   const saved=await tx.poolGatewayReconciliation.create({data:{reviewId:review.id,groupId:id,
    paymentFingerprintJson:JSON.stringify(fingerprints),checksJson:JSON.stringify(checks),
    allVerified,eligibleForManualReview:allVerified}});
   await tx.auditLog.create({data:{actor:'ADMIN',action:'POOL_GATEWAY_EVIDENCE_RECORDED',resource:`${id}:${saved.id}`}});
   return saved;
  },{isolationLevel:'Serializable'});
  return {groupId:id,evidenceId:evidence.id,checkedAt:evidence.checkedAt,checks,allVerified,
   eligibleForManualReview:allVerified,
   notice:'Persisted read-only evidence, not a settlement or refund authorization. No cancellation, driver release or refund was performed.'};
 }
 @Get('groups/:id/reconciliation-history') @Roles('ADMIN') async reconciliationHistory(@Param('id') id:string){
  const review=await this.db.poolCancellationReview.findUnique({where:{groupId:id}}});
  if(!review)throw new BadRequestException('No cancellation review for this group');
  const history=await this.db.poolGatewayReconciliation.findMany({where:{groupId:id,reviewId:review.id},orderBy:{checkedAt:'desc'},take:30});
  return {groupId:id,history:history.map(e=>({id:e.id,checkedAt:e.checkedAt,
   allVerified:e.allVerified,eligibleForManualReview:e.eligibleForManualReview,
   checks:JSON.parse(e.checksJson),paymentFingerprint:JSON.parse(e.paymentFingerprintJson)})),
   notice:'Historical observations only; gateway status may have changed. No cancellation or refund authorization.'};
 }
 @Get('groups/:id/route-preview') @Roles('ADMIN','DISPATCH') async routePreview(@Param('id') id:string){
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  if(!group||group.status!=='FORMING')throw new ConflictException('Group is not forming');
  if(group.rides.length!==2||group.rides.some(r=>!r.poolConsentAt||r.driverId||r.vehicleId||!['REQUESTED','MATCHING'].includes(r.status)))throw new ConflictException('Both passengers must consent before route planning');
  if(group.rides.reduce((n,r)=>n+r.poolSeats,0)>group.seatCapacity)throw new ConflictException('Seat capacity exceeded');
  try{return {groupId:id,stops:buildPoolStopPreview(group.rides),dispatchReady:false,notice:'Straight-line planning preview only. No driver assignment, route-detour validation, pickup verification or discounted fares.'};}
  catch{throw new BadRequestException('Unable to plan stops without valid passenger coordinates');}
 }
 @Get('groups/:id/road-validation') @Roles('ADMIN','DISPATCH') async roadValidation(@Param('id') id:string){
  if(!await poolingEnabled(this.db))throw new ConflictException('Pooling is disabled');
  const routingUrl=process.env.POOLING_OSRM_BASE_URL;
  if(!routingUrl)throw new ConflictException('Road routing is not configured; validation unavailable');
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  if(!group||group.status!=='FORMING'||group.rides.length!==2)throw new ConflictException('Group is not eligible');
  if(group.rides.some(r=>!r.poolConsentAt||r.driverId||r.vehicleId||!['REQUESTED','MATCHING'].includes(r.status)))throw new ConflictException('Both passengers must consent and remain unassigned');
  if(group.rides.reduce((n,r)=>n+r.poolSeats,0)>group.seatCapacity)throw new ConflictException('Seat capacity exceeded');
  let stops;
  try{stops=buildPoolStopPreview(group.rides);}catch{throw new BadRequestException('Invalid route coordinates');}
  try{
   const result=await validateRoadPool(stops,route=>fetchOsrmRoute(route,routingUrl));
   return {groupId:id,...result,notice:'Road-based screening only. Not approved for dispatch, fare discount or pickup verification.'};
  }catch{throw new ConflictException('Road routing unavailable or invalid; do not dispatch');}
 }
 @Post('groups/:id/assign') @Roles('ADMIN','DISPATCH') async assignGroup(@Param('id') id:string,@Body() body:{driverId?:string}){
  if(!await poolingEnabled(this.db))throw new ConflictException('Pooling is disabled');
  if(typeof body?.driverId!=='string'||!body.driverId.trim())throw new BadRequestException('driverId required');
  const routingUrl=process.env.POOLING_OSRM_BASE_URL;
  if(!routingUrl)throw new ConflictException('Road routing must be configured');
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  if(!group||group.status!=='FORMING'||group.rides.length!==2)throw new ConflictException('Group is not forming');
  const rides=group.rides;
  if(rides.some(r=>!r.poolConsentAt||r.driverId||r.vehicleId||!['REQUESTED','MATCHING'].includes(r.status)||r.scheduledAt))throw new ConflictException('Group rides must be consenting and unassigned');
  if(rides.reduce((n,r)=>n+r.poolSeats,0)>group.seatCapacity)throw new ConflictException('Seat capacity exceeded');
  let stops;
  try{stops=buildPoolStopPreview(rides);}catch{throw new BadRequestException('Invalid route coordinates');}
  let validation;
  try{validation=await validateRoadPool(stops,route=>fetchOsrmRoute(route,routingUrl));}
  catch{throw new ConflictException('Road routing unavailable; assignment denied');}
  if(!validation.withinDetourLimits)throw new ConflictException('Passenger detour limit exceeded');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   // Re-read under the cross-instance lock; consent, coordinates, status and seat counts cannot change unnoticed.
   const current=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   if(!current||current.status!=='FORMING'||current.rides.length!==2)throw new ConflictException('Group changed');
   for(const prior of rides){
    const now=current.rides.find(r=>r.id===prior.id);
    if(!now||now.updatedAt.getTime()!==prior.updatedAt.getTime()||!now.poolConsentAt||now.driverId||now.vehicleId||!['REQUESTED','MATCHING'].includes(now.status))throw new ConflictException('Ride changed during routing; retry');
   }
   const driver=await tx.driver.findUnique({where:{id:body.driverId},include:{vehicle:true}});
   if(!driver||driver.status!=='APPROVED'||!driver.online||driver.cityId!==current.cityId||!driver.vehicle||!driver.vehicle.active||driver.vehicle.type!==current.vehicleType||driver.vehicle.cityId!==current.cityId)throw new ConflictException('Driver or vehicle is not eligible');
   if(driver.vehicle.documentExpiry&&driver.vehicle.documentExpiry<new Date())throw new ConflictException('Vehicle documents expired');
   const busy=await tx.ride.count({where:{driverId:driver.id,status:{in:['ASSIGNED','ARRIVING','IN_PROGRESS']}}});
   if(busy)throw new ConflictException('Driver is already busy');
   if(current.rides.reduce((n,r)=>n+r.poolSeats,0)>current.seatCapacity)throw new ConflictException('Seat capacity exceeded');
   const result=await tx.ride.updateMany({where:{id:{in:rides.map(r=>r.id)},poolGroupId:id,driverId:null,vehicleId:null,status:{in:['REQUESTED','MATCHING']}},data:{driverId:driver.id,vehicleId:driver.vehicle.id,status:'ASSIGNED'}});
   if(result.count!==2)throw new ConflictException('Ride assignment conflict');
   await tx.poolGroup.update({where:{id},data:{status:'ASSIGNED',driverId:driver.id,vehicleId:driver.vehicle.id,confirmedStopsJson:JSON.stringify(stops),roadValidatedAt:new Date()}});
   await tx.auditLog.create({data:{actor:'DISPATCH',action:'POOL_GROUP_ASSIGNED',resource:id}});
   return {groupId:id,status:'ASSIGNED',driverId:driver.id,vehicleId:driver.vehicle.id,stops,detours:validation.riders,notice:'Assignment recorded. Driver multi-stop pickup/drop-off OTP workflow is not yet available; do not use for live operations.'};
  });
 }
 @Post('groups/:id/fare-offers') @Roles('ADMIN','DISPATCH') async fareOffers(@Param('id') id:string){
  if(!await poolingEnabled(this.db))throw new ConflictException('Pooling is disabled');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_fares'))`;
   const group=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   if(!group||group.status!=='ASSIGNED'||group.rides.length!==2||!group.roadValidatedAt)throw new ConflictException('Assigned, road-validated group required');
   if(group.rides.some(r=>!r.poolConsentAt||r.status!=='ASSIGNED'||r.farePaise<=0||r.poolFareApprovedAt))throw new ConflictException('Rides not eligible for a new fare offer');
   // A conservative fixed discount; no charge is made here. Production pricing requires tariff review.
   const expiresAt=new Date(Date.now()+5*60_000);
   const offers=[];
   for(const ride of group.rides){
    const amount=Math.max(1,Math.floor(ride.farePaise*0.8));
    await tx.ride.update({where:{id:ride.id},data:{poolFarePaise:amount,poolFareExpiresAt:expiresAt,poolFareApprovedAt:null}});
    offers.push({rideId:ride.id,originalFarePaise:ride.farePaise,offeredFarePaise:amount});
   }
   await tx.poolGroup.update({where:{id},data:{fareOfferedAt:new Date()}});
   await tx.auditLog.create({data:{actor:'DISPATCH',action:'POOL_FARES_OFFERED',resource:id}});
   return {groupId:id,offers,expiresAt,notice:'Indicative discounted fares only; existing ride checkout is NOT enabled for these offers.'};
  });
 }
 @Get('groups/:id') @Roles('ADMIN','DISPATCH') async group(@Param('id') id:string){
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:{select:{id:true,status:true,poolSeats:true}}}});
  if(!group)throw new BadRequestException('Group not found');
  return group;
 }
 @Patch('settings') @Roles('ADMIN') async update(@Body() dto:PoolingSettingDto){
  if(typeof dto.enabled!=='boolean')throw new BadRequestException('enabled must be boolean');
  const updated=await this.db.serviceSetting.upsert({where:{key:POOLING_KEY},create:{key:POOLING_KEY,enabled:dto.enabled},update:{enabled:dto.enabled}});
  await this.db.auditLog.create({data:{actor:'ADMIN',action:dto.enabled?'POOLING_ENABLED':'POOLING_DISABLED',resource:POOLING_KEY}});
  return {enabled:updated.enabled};
 }
}


// A pickup code is generated only for an assigned, consenting passenger.
// Driver cannot advance to a dropoff until that passenger has been verified.
function pickupDigest(groupId:string,rideId:string,code:string){
 const secret=process.env.POOLING_OTP_SECRET;
 if(!secret||secret.length<32)throw new ConflictException('Pooling OTP secret must be configured');
 return createHmac('sha256',secret).update(`${groupId}:${rideId}:${code}`).digest('hex');
}
function safeEqualHex(a:string,b:string){
 const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex');
 return x.length===y.length&&timingSafeEqual(x,y);
}
function groupStops(group:any):{rideId:string;kind:'PICKUP'|'DROPOFF';address:string}[]{
 if(!group.confirmedStopsJson)throw new ConflictException('Confirmed stops unavailable');
 const stops=JSON.parse(group.confirmedStopsJson);
 if(!Array.isArray(stops)||stops.length!==4)throw new ConflictException('Invalid confirmed stops');
 return stops;
}
@Controller('mobile/pooling') @UseGuards(MobileGuard)
export class MobilePoolingStopsController {
 constructor(private db:Database){}
 @Get('groups/:id/stops') async stops(@Param('id') id:string,@Req() req:any){
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  if(!group||!['ASSIGNED','IN_PROGRESS'].includes(group.status))throw new ConflictException('Group unavailable');
  if(req.mobile.role==='DRIVER'?group.driverId!==req.mobile.sub:!group.rides.some(r=>r.customerId===req.mobile.sub))throw new ForbiddenException();
  const stops=groupStops(group);
  return {groupId:id,status:group.status,currentStopIndex:group.currentStopIndex,stops:stops.map((s,i)=>({index:i,kind:s.kind,address:s.address,rideId:s.rideId,completed:i<group.currentStopIndex}))};
 }
 @Get('groups/:id/my-fare') async myFare(@Param('id') id:string,@Req() req:any){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException('Customer only');
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  const ride=group?.rides.find(r=>r.customerId===req.mobile.sub);
  if(!group||!ride)throw new ForbiddenException();
  return {groupId:id,rideId:ride.id,originalFarePaise:ride.farePaise,offeredFarePaise:ride.poolFarePaise,expiresAt:ride.poolFareExpiresAt,approvedAt:ride.poolFareApprovedAt,checkoutEnabled:true};
 }
 @Post('groups/:id/approve-fare') async approveFare(@Param('id') id:string,@Req() req:any){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException('Customer only');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_fares'))`;
   const group=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   const ride=group?.rides.find(r=>r.customerId===req.mobile.sub);
   if(!group||!ride)throw new ForbiddenException();
   if(group.status!=='ASSIGNED'||ride.status!=='ASSIGNED'||!ride.poolConsentAt||!ride.poolFarePaise||!ride.poolFareExpiresAt||ride.poolFareExpiresAt<=new Date())throw new ConflictException('Fare offer unavailable or expired');
   if(ride.poolFareApprovedAt)return {rideId:ride.id,approved:true,amountPaise:ride.poolFarePaise,checkoutEnabled:true};
   await tx.ride.update({where:{id:ride.id},data:{poolFareApprovedAt:new Date()}});
   await tx.auditLog.create({data:{actor:'CUSTOMER',action:'POOL_FARE_APPROVED',resource:ride.id}});
   return {rideId:ride.id,approved:true,amountPaise:ride.poolFarePaise,checkoutEnabled:true};
  });
 }
 @Post('groups/:id/pickup-code') async code(@Param('id') id:string,@Req() req:any){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException('Customer only');
  const group=await this.db.poolGroup.findUnique({where:{id},include:{rides:true}});
  const ride=group?.rides.find(r=>r.customerId===req.mobile.sub);
  if(!group||!ride||!['ASSIGNED','IN_PROGRESS'].includes(group.status))throw new ForbiddenException('No assigned pooling ride');
  const stops=groupStops(group),index=stops.findIndex(s=>s.rideId===ride.id&&s.kind==='PICKUP');
  if(index<group.currentStopIndex)throw new ConflictException('Pickup already completed');
  const code=String(randomInt(0,1000000)).padStart(6,'0');
  const expiresAt=new Date(Date.now()+5*60_000);
  await this.db.poolPickupChallenge.upsert({where:{rideId:ride.id},create:{groupId:id,rideId:ride.id,codeDigest:pickupDigest(id,ride.id,code),expiresAt},update:{codeDigest:pickupDigest(id,ride.id,code),expiresAt,attempts:0,verifiedAt:null}});
  return {code,expiresAt}; // authenticated customer only; never log or include in driver response
 }
 @Post('groups/:id/advance') async advance(@Param('id') id:string,@Req() req:any,@Body() body:{code?:string}){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException('Driver only');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_stops'))`;
   const group=await tx.poolGroup.findUnique({where:{id},include:{rides:true}});
   if(!group||group.driverId!==req.mobile.sub||!['ASSIGNED','IN_PROGRESS'].includes(group.status))throw new ForbiddenException('Not assigned');
   // A pending cancellation review freezes driver progression until operations reconcile the case.
   const review=await tx.poolCancellationReview.findUnique({where:{groupId:id}});
   if(review?.status==='PENDING_REVIEW')throw new ConflictException('Cancellation review pending; driver stop progression is frozen');
   const stops=groupStops(group),stop=stops[group.currentStopIndex];
   if(!stop)throw new ConflictException('Group already completed');
   const ride=group.rides.find(r=>r.id===stop.rideId);
   if(!ride||ride.driverId!==req.mobile.sub)throw new ConflictException('Ride assignment changed');
   if(stop.kind==='PICKUP'){
    if(!/^\d{6}$/.test(body?.code||''))throw new BadRequestException('Six-digit passenger code required');
    const challenge=await tx.poolPickupChallenge.findUnique({where:{rideId:ride.id}});
    if(!challenge||challenge.groupId!==id||challenge.verifiedAt||challenge.expiresAt<new Date()||challenge.attempts>=5)throw new ConflictException('Pickup code expired or locked');
    // Count invalid attempts even if the code does not match.
    await tx.poolPickupChallenge.update({where:{id:challenge.id},data:{attempts:{increment:1}}});
    if(!safeEqualHex(challenge.codeDigest,pickupDigest(id,ride.id,body.code!)))return {verified:false,remainingAttempts:4-challenge.attempts};
    await tx.poolPickupChallenge.update({where:{id:challenge.id},data:{verifiedAt:new Date()}});
    await tx.ride.update({where:{id:ride.id},data:{status:'IN_PROGRESS'}});
   }else{
    const challenge=await tx.poolPickupChallenge.findUnique({where:{rideId:ride.id}});
    if(!challenge?.verifiedAt)throw new ConflictException('Passenger pickup not verified');
    await tx.ride.update({where:{id:ride.id},data:{status:'COMPLETED'}});
   }
   const next=group.currentStopIndex+1;
   await tx.poolGroup.update({where:{id},data:{currentStopIndex:next,status:next===stops.length?'COMPLETED':'IN_PROGRESS'}});
   await tx.auditLog.create({data:{actor:'DRIVER',action:stop.kind==='PICKUP'?'POOL_PICKUP_VERIFIED':'POOL_DROPOFF_COMPLETED',resource:ride.id}});
   return {verified:true,completedStopIndex:group.currentStopIndex,nextStopIndex:next,groupStatus:next===stops.length?'COMPLETED':'IN_PROGRESS'};
  });
 }
}
