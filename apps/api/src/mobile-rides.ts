import { channelEnabled } from './payment-channels';
import * as crypto from 'crypto';
import { Controller, Get, Post, Patch, Param, Body, Req, UseGuards, BadRequestException, ForbiddenException } from '@nestjs/common';
import { IsEnum, IsString, MinLength, IsNumber, Min, Max, Matches, IsOptional, IsBoolean } from 'class-validator';
import { RideStatus, VehicleType } from '@prisma/client';
import { Database } from './database';
import { MobileGuard } from './mobile-auth';
import { LiveGateway } from './realtime';
import { pickupRoute } from './route-planner';
import { matchRoadFix } from './road-match';
import { calculateFareQuote } from './fare-quote';
import { poolingEnabled } from './pooling';
class BookDto { @IsOptional() @IsBoolean() poolingRequested?:boolean; @IsString() quoteId!:string; @IsString() cityId!:string; @IsString() @MinLength(3) pickup!:string; @IsString() @MinLength(3) dropoff!:string; @IsEnum(VehicleType) type!:VehicleType; @IsOptional() @IsNumber() @Min(-90) @Max(90) pickupLatitude?:number; @IsOptional() @IsNumber() @Min(-180) @Max(180) pickupLongitude?:number; @IsOptional() @IsNumber() @Min(-90) @Max(90) dropoffLatitude?:number; @IsOptional() @IsNumber() @Min(-180) @Max(180) dropoffLongitude?:number; }
class LocationDto { @IsNumber() @Min(-90) @Max(90) latitude!:number; @IsNumber() @Min(-180) @Max(180) longitude!:number; @IsNumber() @Min(0) @Max(5000) accuracyMeters!:number; }
class PickupCodeDto { @IsString() @Matches(/^[0-9]{4}$/) code!:string; }
class SelectPaymentDto { @IsEnum(['COD','CASH','UPI','ONLINE']) method!:'COD'|'CASH'|'UPI'|'ONLINE'; }
class StatusDto { @IsEnum(RideStatus) status!:RideStatus; }
class QuoteDto { @IsString() cityId!:string; @IsEnum(VehicleType) type!:VehicleType; @IsNumber() @Min(-90) @Max(90) pickupLatitude!:number; @IsNumber() @Min(-180) @Max(180) pickupLongitude!:number; @IsNumber() @Min(-90) @Max(90) dropoffLatitude!:number; @IsNumber() @Min(-180) @Max(180) dropoffLongitude!:number; }
@Controller('mobile') @UseGuards(MobileGuard) export class MobileRideController {
 constructor(private db:Database,private live:LiveGateway){}
 @Get('pooling/availability') async poolingAvailability(){return {enabled:await poolingEnabled(this.db),note:'Pooling requests are recorded; matching and shared fares are not yet active'};}
 @Post('rides/:id/pooling-consent') async poolingConsent(@Req() req:any,@Param('id') id:string,@Body() dto:{consent?:boolean}){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  if(typeof dto?.consent!=='boolean')throw new BadRequestException('consent must be boolean');
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_group'))`;
   const ride=await tx.ride.findUnique({where:{id}});
   if(!ride||ride.customerId!==req.mobile.sub)throw new ForbiddenException();
   if(!ride.poolGroupId||!ride.poolingRequested)throw new BadRequestException('No active pooling proposal');
   const group=await tx.poolGroup.findUnique({where:{id:ride.poolGroupId}});
   if(group?.status!=='FORMING'||ride.driverId||!['REQUESTED','MATCHING'].includes(ride.status))throw new BadRequestException('Pooling proposal is no longer editable');
   if(dto.consent){
    await tx.ride.update({where:{id},data:{poolConsentAt:new Date()}});
    return {rideId:id,groupId:group.id,consented:true,note:'Consent recorded. No shared dispatch or discount is active.'};
   }
   const changed=await tx.ride.updateMany({where:{poolGroupId:group.id},data:{poolGroupId:null,poolConsentAt:null}});
   await tx.poolGroup.update({where:{id:group.id},data:{status:'DISSOLVED'}});
   await tx.auditLog.create({data:{actor:'CUSTOMER',action:'POOL_GROUP_DECLINED',resource:group.id}});
   return {rideId:id,groupId:group.id,consented:false,groupDissolved:true,ridesReleased:changed.count};
  });
 }
 @Get('cities') cities(){return this.db.city.findMany({where:{active:true},select:{id:true,name:true,state:true}});}
 @Get('rides') rides(@Req() req:any){return this.db.ride.findMany({where:req.mobile.role==='CUSTOMER'?{customerId:req.mobile.sub}:{driverId:req.mobile.sub},orderBy:{createdAt:'desc'},take:50});}
 @Post('fare-quote') async quote(@Req() req:any,@Body() dto:QuoteDto){if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();const city=await this.db.city.findUnique({where:{id:dto.cityId}});if(!city?.active)throw new BadRequestException('City unavailable');const rule=await this.db.pricingRule.findUnique({where:{city_vehicleType:{city:city.name,vehicleType:dto.type}}});
 if(!rule?.active)throw new BadRequestException('No active fare rule for this city and vehicle');
 const route=await calculateFareQuote(dto);
 if(!route.available)throw new BadRequestException('Road route unavailable; quote cannot be issued');
 const farePaise=rule.basePaise+Math.ceil(route.distanceKm*rule.perKmPaise)+Math.ceil(route.estimatedMinutes*rule.perMinPaise);
 const saved=await this.db.fareQuote.create({data:{customerId:req.mobile.sub,cityId:dto.cityId,type:dto.type,pickupLatitude:dto.pickupLatitude,pickupLongitude:dto.pickupLongitude,dropoffLatitude:dto.dropoffLatitude,dropoffLongitude:dto.dropoffLongitude,distanceKm:route.distanceKm,estimatedMinutes:Math.ceil(route.estimatedMinutes),farePaise,pricingRuleId:rule.id,expiresAt:new Date(Date.now()+5*60*1000)}});
 return {...route,estimatedFarePaise:farePaise,quoteId:saved.id,expiresAt:saved.expiresAt,disclaimer:'Locked for 5 minutes at booking. Demonstration tariff; taxes, tolls and regulatory pricing not finalized.'};}
 @Post('rides') async book(@Req() req:any,@Body() dto:BookDto){if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();const city=await this.db.city.findUnique({where:{id:dto.cityId}});if(!city?.active)throw new BadRequestException('City unavailable');if(dto.poolingRequested&&!await poolingEnabled(this.db))throw new ForbiddenException('Ride pooling is disabled');if(dto.poolingRequested&&!['MINI','SEDAN','SUV'].includes(dto.type))throw new BadRequestException('Pooling requires a car');if((dto.dropoffLatitude==null)!==(dto.dropoffLongitude==null)||(dto.pickupLatitude==null)!==(dto.pickupLongitude==null))throw new BadRequestException('Coordinate pairs required');const created=await this.db.$transaction(async tx=>{
 const q=await tx.fareQuote.findUnique({where:{id:dto.quoteId}});
 if(!q||q.customerId!==req.mobile.sub||q.cityId!==dto.cityId||q.type!==dto.type||q.consumedAt||q.expiresAt<=new Date())throw new BadRequestException('Fare quote expired, already used, or mismatched');
 if([dto.pickupLatitude,dto.pickupLongitude,dto.dropoffLatitude,dto.dropoffLongitude].some(x=>x==null)||Math.abs(q.pickupLatitude-dto.pickupLatitude!)>0.000001||Math.abs(q.pickupLongitude-dto.pickupLongitude!)>0.000001||Math.abs(q.dropoffLatitude-dto.dropoffLatitude!)>0.000001||Math.abs(q.dropoffLongitude-dto.dropoffLongitude!)>0.000001)throw new BadRequestException('Route changed; request a new quote');
 const claimed=await tx.fareQuote.updateMany({where:{id:q.id,consumedAt:null,expiresAt:{gt:new Date()}},data:{consumedAt:new Date()}});
 if(claimed.count!==1)throw new BadRequestException('Quote already consumed');
 const ride=await tx.ride.create({data:{reference:'RF-'+crypto.randomUUID().slice(0,12).toUpperCase(),customerId:req.mobile.sub,cityId:q.cityId,pickup:dto.pickup,pickupLatitude:q.pickupLatitude,pickupLongitude:q.pickupLongitude,dropoffLatitude:q.dropoffLatitude,dropoffLongitude:q.dropoffLongitude,dropoff:dto.dropoff,type:q.type,farePaise:q.farePaise,poolingRequested:dto.poolingRequested===true,status:'REQUESTED'}});
 await tx.ridePayment.create({data:{rideId:ride.id,method:'CASH',status:'PENDING',amountPaise:ride.farePaise}});
 return ride;
 },{isolationLevel:'Serializable'});
 await this.live.rideChanged(created.id);return created;}
 @Patch('rides/:id/status') async status(@Req() req:any,@Param('id') id:string,@Body() dto:StatusDto){const ride=await this.db.ride.findUnique({where:{id}});if(!ride)throw new BadRequestException('Ride not found');if(ride.poolGroupId)throw new ForbiddenException('Grouped rides require the pooling-specific workflow; contact dispatch for cancellation');if(req.mobile.role==='CUSTOMER'){if(ride.customerId!==req.mobile.sub||dto.status!=='CANCELLED'||!['REQUESTED','MATCHING','ASSIGNED','ARRIVING'].includes(ride.status))throw new ForbiddenException();}else{if(ride.driverId!==req.mobile.sub||!({ARRIVING:['IN_PROGRESS'],IN_PROGRESS:['COMPLETED']} as Record<string,string[]>)[ride.status]?.includes(dto.status))throw new ForbiddenException();if(dto.status==='IN_PROGRESS' && !(await this.db.pickupChallenge.findFirst({where:{rideId:id,verifiedAt:{not:null},expiresAt:{gt:new Date()}}})))throw new ForbiddenException('Valid pickup code verification required');}const updated=await this.db.ride.updateMany({where:{id,status:ride.status},data:{status:dto.status}});if(updated.count!==1)throw new BadRequestException('Ride status changed; retry');await this.live.rideChanged(id);return this.db.ride.findUnique({where:{id}});}

 @Get('rides/:id') async rideDetails(@Req() req:any,@Param('id') id:string){const ride=await this.db.ride.findUnique({where:{id},include:{driver:{select:{id:true,name:true}},vehicle:{select:{plate:true,type:true}}}});if(!ride||!(req.mobile.role==='CUSTOMER'&&ride.customerId===req.mobile.sub||req.mobile.role==='DRIVER'&&ride.driverId===req.mobile.sub))throw new ForbiddenException();return ride;}
 @Get('driver/offers') async offers(@Req() req:any){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  return this.db.rideOffer.findMany({where:{driverId:req.mobile.sub,status:'PENDING',expiresAt:{gt:new Date()}},orderBy:{createdAt:'desc'},take:10});
 }
 @Post('rides/:id/accept') async accept(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  const updated=await this.db.$transaction(async tx=>{
   const offer=await tx.rideOffer.findUnique({where:{rideId:id}});
   if(!offer||offer.driverId!==req.mobile.sub||offer.status!=='PENDING'||offer.expiresAt<=new Date())throw new BadRequestException('Offer no longer available');
   const changed=await tx.ride.updateMany({where:{id,driverId:req.mobile.sub,status:'ASSIGNED'},data:{status:'ARRIVING'}});
   if(changed.count!==1)throw new BadRequestException('Ride changed');
   await tx.rideOffer.update({where:{id:offer.id},data:{status:'ACCEPTED',respondedAt:new Date()}});
   await tx.rideOfferAttempt.updateMany({where:{rideId:id,driverId:req.mobile.sub,outcome:'PENDING'},data:{outcome:'ACCEPTED'}});
   return tx.ride.findUnique({where:{id}});
  });await this.live.rideChanged(id);return updated;
 }
 @Post('rides/:id/decline') async decline(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  await this.db.$transaction(async tx=>{
   const offer=await tx.rideOffer.findUnique({where:{rideId:id}});
   if(!offer||offer.driverId!==req.mobile.sub||offer.status!=='PENDING')throw new BadRequestException('Offer no longer available');
   const changed=await tx.ride.updateMany({where:{id,status:'ASSIGNED',driverId:req.mobile.sub},data:{status:'MATCHING',driverId:null,vehicleId:null}});
   if(changed.count!==1)throw new BadRequestException('Ride changed');
   await tx.rideOffer.update({where:{id:offer.id},data:{status:'DECLINED',respondedAt:new Date()}});
   await tx.rideOfferAttempt.updateMany({where:{rideId:id,driverId:req.mobile.sub,outcome:'PENDING'},data:{outcome:'DECLINED'}});
  });await this.live.rideChanged(id);return {status:'MATCHING',needsReassignment:true};
 }
 @Post('rides/:id/pickup-code') async pickupCode(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.customerId!==req.mobile.sub||ride.status!=='ARRIVING')throw new ForbiddenException();
  const code=crypto.randomInt(0,10000).toString().padStart(4,'0');
  const secret=process.env.PICKUP_CODE_SECRET||process.env.JWT_SECRET;
  if(!secret)throw new BadRequestException('Pickup code secret missing');
  const codeHash=crypto.createHmac('sha256',secret).update(id+':'+code).digest('hex');
  const expiresAt=new Date(Date.now()+10*60*1000);
  await this.db.pickupChallenge.upsert({where:{rideId:id},create:{rideId:id,codeHash,expiresAt},update:{codeHash,expiresAt,attempts:0,verifiedAt:null}});
  return {code,expiresAt}; // Return only to the authenticated customer; do not log.
 }
 @Post('rides/:id/verify-pickup') async verifyPickup(@Req() req:any,@Param('id') id:string,@Body() dto:PickupCodeDto){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.driverId!==req.mobile.sub||ride.status!=='ARRIVING')throw new ForbiddenException();
  const secret=process.env.PICKUP_CODE_SECRET||process.env.JWT_SECRET;
  if(!secret)throw new BadRequestException('Pickup code secret missing');
  const digest=crypto.createHmac('sha256',secret).update(id+':'+dto.code).digest('hex');
  const result=await this.db.pickupChallenge.updateMany({where:{rideId:id,verifiedAt:null,expiresAt:{gt:new Date()},attempts:{lt:5},codeHash:digest},data:{verifiedAt:new Date()}});
  if(result.count===0){await this.db.pickupChallenge.updateMany({where:{rideId:id,verifiedAt:null,attempts:{lt:5}},data:{attempts:{increment:1}}});throw new BadRequestException('Invalid or expired pickup code');}
  return {verified:true};
 }
 @Get('rides/:id/tracking') async rideTracking(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id},select:{id:true,reference:true,customerId:true,driverId:true,status:true,pickupLatitude:true,pickupLongitude:true,dropoffLatitude:true,dropoffLongitude:true}});
  if(!ride||ride.customerId!==req.mobile.sub)throw new ForbiddenException();
  const active=['ASSIGNED','ARRIVING','IN_PROGRESS'].includes(ride.status);
  if(!active||!ride.driverId)return {rideId:ride.id,status:ride.status,active:false,location:null,reason:'Ride is not actively assigned'};
  const loc=await this.db.driverLocation.findUnique({where:{driverId:ride.driverId},select:{latitude:true,longitude:true,accuracyMeters:true,updatedAt:true}});
  if(!loc||Date.now()-loc.updatedAt.getTime()>30000||loc.accuracyMeters!=null&&loc.accuracyMeters>200)
   return {rideId:ride.id,status:ride.status,active:true,location:null,reason:'Recent accurate driver GPS unavailable'};
  const matched=await matchRoadFix(loc,{driverId:ride.driverId});
  return {rideId:ride.id,status:ride.status,active:true,location:matched.location,locationSource:matched.source,pickup:{latitude:ride.pickupLatitude,longitude:ride.pickupLongitude},dropoff:{latitude:ride.dropoffLatitude,longitude:ride.dropoffLongitude}};
 }
 @Get('rides/:id/driver-location') async rideLocation(@Req() req:any,@Param('id') id:string){if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();const ride=await this.db.ride.findUnique({where:{id}});if(!ride||ride.customerId!==req.mobile.sub||!ride.driverId||!['ASSIGNED','ARRIVING','IN_PROGRESS'].includes(ride.status))throw new ForbiddenException();const loc=await this.db.driverLocation.findUnique({where:{driverId:ride.driverId},select:{latitude:true,longitude:true,accuracyMeters:true,updatedAt:true}});return loc&&Date.now()-loc.updatedAt.getTime()<=30000&&(loc.accuracyMeters==null||loc.accuracyMeters<=200)?loc:null;}
 @Get('rides/:id/pickup-route') async pickupRoute(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.customerId!==req.mobile.sub||!ride.driverId||!['ASSIGNED','ARRIVING'].includes(ride.status))throw new ForbiddenException();
  if(ride.pickupLatitude==null||ride.pickupLongitude==null)throw new BadRequestException('Pickup map coordinates not available');
  const loc=await this.db.driverLocation.findUnique({where:{driverId:ride.driverId}});
  if(!loc||Date.now()-loc.updatedAt.getTime()>120000)throw new BadRequestException('Recent driver location unavailable');
  return pickupRoute({latitude:loc.latitude,longitude:loc.longitude},{latitude:ride.pickupLatitude,longitude:ride.pickupLongitude});
 }
 @Patch('driver/location') async location(@Req() req:any,@Body() dto:LocationDto){if(req.mobile.role!=='DRIVER')throw new ForbiddenException();const driver=await this.db.driver.findUnique({where:{id:req.mobile.sub}});if(!driver||!driver.online||driver.status!=='APPROVED')throw new ForbiddenException('Driver must be approved and online');const result=await this.db.driverLocation.upsert({where:{driverId:driver.id},create:{driverId:driver.id,...dto},update:dto});await this.live.driverLocation(driver.id,dto.latitude,dto.longitude);return {updatedAt:result.updatedAt};}
 @Get('rides/:id/payment') async payment(@Req() req:any,@Param('id') id:string){
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||!(req.mobile.role==='CUSTOMER'&&ride.customerId===req.mobile.sub||req.mobile.role==='DRIVER'&&ride.driverId===req.mobile.sub))throw new ForbiddenException();
  return this.db.ridePayment.findUnique({where:{rideId:id},select:{method:true,status:true,amountPaise:true,collectedAt:true}});
 }
 @Post('rides/:id/select-payment') async selectPayment(@Req() req:any,@Param('id') id:string,@Body() dto:SelectPaymentDto){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  if(!await channelEnabled(this.db,dto.method))throw new ForbiddenException('Payment method disabled by admin');
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.customerId!==req.mobile.sub||['CANCELLED'].includes(ride.status))throw new ForbiddenException('Ride unavailable');
  if(ride.poolGroupId){
   if(dto.method==='COD'||dto.method==='CASH')throw new BadRequestException('Pooled COD collection is not enabled');
   return this.db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rideflow_pool_payment'))`;
    const fresh=await tx.ride.findUnique({where:{id}});
    const group=fresh?.poolGroupId?await tx.poolGroup.findUnique({where:{id:fresh.poolGroupId}}):null;
    if(!fresh||fresh.customerId!==req.mobile.sub||group?.status!=='ASSIGNED'||!fresh.poolFareApprovedAt||!fresh.poolFarePaise||fresh.poolFarePaise<50||!fresh.poolConsentAt)throw new BadRequestException('Approved pooled fare required');
    const existing=await tx.ridePayment.findUnique({where:{rideId:id}});
    if(!existing||existing.status!=='PENDING'||existing.providerOrderId||existing.stripeIntentId||existing.upiReference)throw new BadRequestException('Payment already initiated');
    const changed=await tx.ridePayment.updateMany({where:{id:existing.id,status:'PENDING',providerOrderId:null,stripeIntentId:null,upiReference:null},data:{method:dto.method==='COD'?'CASH':dto.method,amountPaise:fresh.poolFarePaise,upiReference:null,upiInitiatedAt:null}});
    if(changed.count!==1)throw new BadRequestException('Payment selection conflict');
    return tx.ridePayment.findUnique({where:{rideId:id},select:{method:true,status:true,amountPaise:true}});
   });
  }
  const changed=await this.db.ridePayment.updateMany({where:{rideId:id,status:'PENDING'},data:{method:dto.method==='COD'?'CASH':dto.method,upiReference:null,upiInitiatedAt:null,providerOrderId:null,stripeIntentId:null}});
  if(changed.count!==1)throw new BadRequestException('Payment already recorded or unavailable');
  return this.db.ridePayment.findUnique({where:{rideId:id},select:{method:true,status:true,amountPaise:true}});
 }
 @Post('rides/:id/upi-intent') async upiIntent(@Req() req:any,@Param('id') id:string){
  if(!await channelEnabled(this.db,'UPI'))throw new ForbiddenException('UPI disabled by admin');
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.customerId!==req.mobile.sub||ride.status==='CANCELLED')throw new ForbiddenException('Ride unavailable');
  if(ride.poolGroupId)throw new BadRequestException('Pooled ride UPI checkout is disabled pending fare settlement integration');
  const vpa=process.env.UPI_MERCHANT_VPA;
  if(!vpa||!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(vpa))throw new BadRequestException('UPI merchant VPA is not configured');
  const payment=await this.db.ridePayment.findUnique({where:{rideId:id}});
  if(!payment||payment.method!=='UPI'||payment.status!=='PENDING')throw new BadRequestException('Select UPI for this pending ride first');
  const ref=payment.upiReference||('RFUPI'+crypto.randomBytes(10).toString('hex').toUpperCase());
  await this.db.ridePayment.updateMany({where:{id:payment.id,status:'PENDING',method:'UPI'},data:{upiReference:ref,upiInitiatedAt:new Date()}});
  const params=new URLSearchParams({pa:vpa,pn:process.env.UPI_MERCHANT_NAME||'RideFlow',tr:ref,tn:'RideFlow '+ride.reference,am:(payment.amountPaise/100).toFixed(2),cu:'INR'});
  return {uri:'upi://pay?'+params.toString(),reference:ref,amountPaise:payment.amountPaise,status:'PENDING',notice:'Opening a UPI app does not confirm payment. Do not mark paid without a trusted provider callback.'};
 }
 @Post('rides/:id/collect-cash') async collectCash(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id}});
  if(!ride||ride.driverId!==req.mobile.sub||ride.status!=='COMPLETED')throw new ForbiddenException('Only the assigned driver may record cash for a completed ride');
  if(ride.poolGroupId)throw new BadRequestException('Pooled ride cash collection requires a separate approved-fare settlement flow');
  const result=await this.db.ridePayment.updateMany({where:{rideId:id,method:'CASH',status:'PENDING',amountPaise:ride.farePaise},data:{status:'RECORDED',recordedByDriverId:req.mobile.sub,collectedAt:new Date()}});
  if(result.count!==1)throw new BadRequestException('Cash collection already recorded or payment unavailable');
  return this.db.ridePayment.findUnique({where:{rideId:id},select:{method:true,status:true,amountPaise:true,collectedAt:true}});
 }
 @Get('rides/:id/receipt') async receipt(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const ride=await this.db.ride.findUnique({where:{id},include:{city:{select:{name:true}},driver:{select:{name:true}}}});
  if(!ride||ride.customerId!==req.mobile.sub||ride.status!=='COMPLETED')throw new ForbiddenException();
  const payment=await this.db.ridePayment.findUnique({where:{rideId:id}});
  return {reference:ride.reference,city:ride.city.name,pickup:ride.pickup,dropoff:ride.dropoff,driver:ride.driver?.name||null,completedAt:ride.updatedAt,amountPaise:ride.farePaise,currency:'INR',paymentMethod:payment?.method||null,paymentStatus:payment?.status||'PENDING',collectedAt:payment?.collectedAt||null,notice:'Development receipt; not a tax invoice.'};
 }

}
