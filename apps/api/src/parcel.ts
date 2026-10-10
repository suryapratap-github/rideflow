import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards, ForbiddenException, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { IsString, IsNumber, IsBoolean, Min, Max, MinLength, Matches, IsOptional } from 'class-validator';
import { Database } from './database';
import { MobileGuard } from './mobile-auth';
import { JwtAuthGuard, RolesGuard, Roles } from './security';

export const PARCEL_KEY='parcel_delivery';
export async function parcelEnabled(db:Database):Promise<boolean>{
 const setting=await db.serviceSetting.findUnique({where:{key:PARCEL_KEY}});
 return setting?.enabled ?? true;
}
class ParcelDto {
 @IsString() cityId!:string;
 @IsString() @MinLength(3) pickup!:string;
 @IsString() @MinLength(3) dropoff!:string;
 @IsString() @MinLength(2) recipientName!:string;
 @IsString() @Matches(/^\+?[0-9]{10,15}$/) recipientPhone!:string;
 @IsString() @MinLength(3) description!:string;
 @IsNumber() @Min(0.1) @Max(20) weightKg!:number;
}
class QuoteDto { @IsNumber() @Min(0.1) @Max(20) weightKg!:number; @IsNumber() @Min(0.1) @Max(100) distanceKm!:number; }
class AssignDto { @IsString() driverId!:string; @IsNumber() @Min(0.1) @Max(100) distanceKm!:number; }
class VerifyDto { @IsString() @Matches(/^\d{6}$/) code!:string; }
class PhotoDto { @IsString() @Matches(/^image\/(jpeg|png)$/) mime!:string; @IsString() @MinLength(100) base64!:string; }
class ParcelCashDto { @IsString() @Matches(/^CASH$/) method!:string; }
const photoDir=()=>process.env.PARCEL_PROOF_DIR||path.resolve(process.cwd(),'private-parcel-proofs');
export function validateParcelPhoto(mime:string,base64:string){
 if(!['image/jpeg','image/png'].includes(mime)||base64.length>2800000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw new BadRequestException('Invalid photo');
 const data=Buffer.from(base64,'base64');
 if(data.length<64||data.length>2*1024*1024)throw new BadRequestException('Photo must be under 2 MB');
 const jpeg=data[0]===255&&data[1]===216&&data[2]===255;
 const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==='image/jpeg'&&!jpeg||mime==='image/png'&&!png)throw new BadRequestException('Photo signature mismatch');
 return data;
}
class EvidenceDto { @IsString() @MinLength(3) @Max(500) note!:string; }

const digest=(code:string)=>crypto.createHmac('sha256',process.env.PARCEL_CODE_SECRET||'local-development-only-parcel-secret').update(code).digest('hex');
const codeExpiry=()=>new Date(Date.now()+5*60*1000);
const newCode=()=>String(crypto.randomInt(0,1000000)).padStart(6,'0');
// Indicative city-agnostic tariff. Configure regulated tariffs before launch.
export function parcelFarePaise(distanceKm:number,weightKg:number){return Math.round(4000+distanceKm*1200+Math.max(0,weightKg-1)*600);}
class RequoteDto { @IsNumber() @Min(0.1) @Max(100) distanceKm!:number; }
class SettingDto { @IsBoolean() enabled!:boolean; }
@Controller('mobile/parcel') @UseGuards(MobileGuard)
export class MobileParcelController {
 constructor(private readonly db:Database){}
 @Get('availability') async availability(){return {enabled:await parcelEnabled(this.db)};}
 @Get('deliveries') async mine(@Req() req:any){if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();return this.db.parcelDelivery.findMany({where:{customerId:req.mobile.sub},orderBy:{createdAt:'desc'},take:50});}
 @Post('deliveries/:id/code') async issueCode(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  return this.db.$transaction(async tx=>{
   const p=await tx.parcelDelivery.findUnique({where:{id}});
   if(!p||p.customerId!==req.mobile.sub)throw new NotFoundException();
   const pickup=p.status==='ACCEPTED';const delivery=p.status==='PICKED_UP'||p.status==='IN_TRANSIT';
   if(!pickup&&!delivery)throw new ConflictException('No verification needed');
   if(pickup&&p.pickupAttempts>=5||delivery&&p.deliveryAttempts>=5)throw new ForbiddenException('Code locked');
   const code=newCode();
   await tx.parcelDelivery.update({where:{id},data:pickup?{pickupCodeHash:digest(code),pickupCodeExpiresAt:codeExpiry()}:{deliveryCodeHash:digest(code),deliveryCodeExpiresAt:codeExpiry()}});
   return {code,expiresInSeconds:300,purpose:pickup?'PICKUP':'DELIVERY',note:'Share code with courier only at handover'};
  });
 }
 @Get('deliveries/:id/tracking') async tracking(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const p=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!p||p.customerId!==req.mobile.sub)throw new NotFoundException();
  if(!p.driverId||!['ACCEPTED','PICKED_UP','IN_TRANSIT'].includes(p.status))return {status:p.status,location:null};
  const gps=await this.db.driverLocation.findUnique({where:{driverId:p.driverId}});
  if(!gps||Date.now()-gps.updatedAt.getTime()>120000)return {status:p.status,location:null,reason:'No recent courier location'};
  return {status:p.status,location:{latitude:gps.latitude,longitude:gps.longitude,updatedAt:gps.updatedAt}};
 }
 @Post('quote') async quote(@Req() req:any,@Body() dto:QuoteDto){if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();if(!await parcelEnabled(this.db))throw new ForbiddenException('Parcel delivery unavailable');return {estimatedFarePaise:parcelFarePaise(dto.distanceKm,dto.weightKg),currency:'INR',indicative:true,note:'Distance must be verified by dispatch; not a locked quote'};}
 @Get('deliveries/:id/fare') async fare(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  const p=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!p||p.customerId!==req.mobile.sub)throw new NotFoundException();
  return {amountPaise:p.estimatedFarePaise,currency:'INR',expiresAt:p.fareQuoteExpiresAt,approvedAt:p.fareApprovedAt,canApprove:!!p.estimatedFarePaise&&!p.fareApprovedAt&&!!p.fareQuoteExpiresAt&&p.fareQuoteExpiresAt.getTime()>Date.now()};
 }
 @Post('deliveries/:id/fare/approve') async approveFare(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  return this.db.$transaction(async tx=>{
   const p=await tx.parcelDelivery.findUnique({where:{id}});
   if(!p||p.customerId!==req.mobile.sub)throw new NotFoundException();
   if(p.fareApprovedAt)return {approved:true,amountPaise:p.estimatedFarePaise};
   if(!p.estimatedFarePaise||!p.fareQuoteExpiresAt||p.fareQuoteExpiresAt.getTime()<=Date.now())throw new ConflictException('Fare quote expired; request a new quote from dispatch');
   if(p.parcelPaymentStatus==='COLLECTED')throw new ConflictException('Already paid');
   const updated=await tx.parcelDelivery.updateMany({where:{id,fareApprovedAt:null,fareQuoteExpiresAt:{gt:new Date()},estimatedFarePaise:p.estimatedFarePaise},data:{fareApprovedAt:new Date()}});
   if(updated.count!==1)throw new ConflictException('Fare changed; retry');
   return {approved:true,amountPaise:p.estimatedFarePaise,currency:'INR'};
  });
 }
 @Post('deliveries') async create(@Req() req:any,@Body() dto:ParcelDto){
  if(req.mobile.role!=='CUSTOMER')throw new ForbiddenException();
  // Serialize with admin setting changes using an advisory transaction lock.
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(74122319)`;
   const setting=await tx.serviceSetting.findUnique({where:{key:PARCEL_KEY}});
   if(setting?.enabled===false)throw new ForbiddenException('Parcel delivery is currently unavailable');
   const city=await tx.city.findUnique({where:{id:dto.cityId}});
   if(!city?.active)throw new BadRequestException('City unavailable');
   return tx.parcelDelivery.create({data:{reference:'RFP-'+crypto.randomUUID().slice(0,12).toUpperCase(),customerId:req.mobile.sub,...dto}});
  });
 }
}
@Controller('admin/parcel') @UseGuards(JwtAuthGuard,RolesGuard)
export class AdminParcelController {
 constructor(private readonly db:Database){}
 @Get('settings') @Roles('ADMIN','DISPATCH') async settings(){return {enabled:await parcelEnabled(this.db)};}
 @Patch('settings') @Roles('ADMIN') async update(@Req() req:any,@Body() dto:SettingDto){
  return this.db.$transaction(async tx=>{
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(74122319)`;
   const setting=await tx.serviceSetting.upsert({where:{key:PARCEL_KEY},create:{key:PARCEL_KEY,enabled:dto.enabled},update:{enabled:dto.enabled}});
   await tx.auditLog.create({data:{actor:req.user.sub,action:dto.enabled?'PARCEL_ENABLED':'PARCEL_DISABLED',resource:PARCEL_KEY}});
   return {enabled:setting.enabled};
  });
 }
 @Get('deliveries') @Roles('ADMIN','DISPATCH') deliveries(){return this.db.parcelDelivery.findMany({orderBy:{createdAt:'desc'},take:100});}
 @Post('deliveries/:id/requote') @Roles('ADMIN','DISPATCH') async requote(@Req() req:any,@Param('id') id:string,@Body() dto:RequoteDto){
  return this.db.$transaction(async tx=>{
   const parcel=await tx.parcelDelivery.findUnique({where:{id}});
   if(!parcel)throw new NotFoundException();
   if(parcel.status!=='ACCEPTED')throw new ConflictException('Only accepted, uncollected parcels can be re-quoted');
   if(parcel.fareApprovedAt||parcel.parcelPaymentStatus!=='UNPAID')throw new ConflictException('Approved or paid fares cannot be changed');
   if(await tx.parcelPayment.findUnique({where:{parcelId:id}}))throw new ConflictException('Online payment already initiated');
   const amount=parcelFarePaise(dto.distanceKm,parcel.weightKg);
   const changed=await tx.parcelDelivery.updateMany({where:{id,status:'ACCEPTED',fareApprovedAt:null,parcelPaymentStatus:'UNPAID'},data:{distanceKm:dto.distanceKm,estimatedFarePaise:amount,fareQuoteExpiresAt:new Date(Date.now()+300000)}});
   if(changed.count!==1)throw new ConflictException('Parcel changed; retry');
   await tx.auditLog.create({data:{actor:req.user.sub,action:'PARCEL_REQUOTE',resource:id}});
   return {amountPaise:amount,currency:'INR',expiresInSeconds:300};
  });
 }
 @Post('deliveries/:id/assign') @Roles('ADMIN','DISPATCH') async assign(@Param('id') id:string,@Body() dto:AssignDto){
  return this.db.$transaction(async tx=>{
   const parcel=await tx.parcelDelivery.findUnique({where:{id}});
   if(!parcel)throw new NotFoundException('Parcel not found');
   if(parcel.status!=='REQUESTED')throw new ConflictException('Parcel already assigned');
   const driver=await tx.driver.findUnique({where:{id:dto.driverId},include:{vehicle:true}});
   if(!driver||driver.status!=='APPROVED'||!driver.online||driver.cityId!==parcel.cityId||!driver.vehicle?.active)throw new BadRequestException('Courier is not eligible');
   const active=await tx.parcelDelivery.count({where:{driverId:dto.driverId,status:{in:['ACCEPTED','PICKED_UP','IN_TRANSIT']}}});
   if(active)throw new ConflictException('Courier already has an active parcel');
   const updated=await tx.parcelDelivery.updateMany({where:{id,status:'REQUESTED'},data:{driverId:dto.driverId,status:'ACCEPTED',assignedAt:new Date(),distanceKm:dto.distanceKm,estimatedFarePaise:parcelFarePaise(dto.distanceKm,parcel.weightKg),fareQuoteExpiresAt:new Date(Date.now()+5*60*1000),fareApprovedAt:null,pickupCodeHash:null,pickupCodeExpiresAt:null}});
   if(updated.count!==1)throw new ConflictException('Parcel was assigned concurrently');
   return {parcelId:id,driverId:dto.driverId,estimatedFarePaise:parcelFarePaise(dto.distanceKm,parcel.weightKg),note:'Customer generates pickup code in their authenticated app'};
  });
 }
 @Patch('deliveries/:id/evidence') @Roles('ADMIN','DISPATCH') async evidence(@Req() req:any,@Param('id') id:string,@Body() dto:EvidenceDto){
  const p=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!p||p.status!=='DELIVERED')throw new ConflictException('Evidence requires completed delivery');
  const saved=await this.db.parcelDelivery.update({where:{id},data:{deliveryEvidenceNote:dto.note,deliveryEvidenceAt:new Date()}});
  await this.db.auditLog.create({data:{actor:req.user.sub,action:'PARCEL_DELIVERY_EVIDENCE',resource:id}});
  return {id:saved.id,deliveryEvidenceNote:saved.deliveryEvidenceNote,deliveryEvidenceAt:saved.deliveryEvidenceAt};
 }
 @Get('deliveries/:id/proof') @Roles('ADMIN','DISPATCH') async proof(@Param('id') id:string){
  const p=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!p?.proofPhotoSha256)throw new NotFoundException('No photo evidence');
  const bytes=await fs.readFile(path.join(photoDir(),p.proofPhotoSha256));
  return {mime:p.proofPhotoMime,base64:bytes.toString('base64'),sha256:p.proofPhotoSha256};
 }
 @Get('payments') @Roles('ADMIN','DISPATCH') async parcelPayments(){return this.db.parcelDelivery.findMany({where:{estimatedFarePaise:{not:null}},select:{id:true,reference:true,estimatedFarePaise:true,parcelPaymentMethod:true,parcelPaymentStatus:true,parcelPaymentRecordedAt:true,status:true},orderBy:{createdAt:'desc'},take:100});}
 @Get('drivers/:cityId') @Roles('ADMIN','DISPATCH') async couriers(@Param('cityId') cityId:string){return this.db.driver.findMany({where:{cityId,online:true,status:'APPROVED',vehicle:{is:{active:true}}},select:{id:true,name:true,vehicle:{select:{plate:true,type:true}}},take:50});}
 @Get('deliveries/:id') @Roles('ADMIN','DISPATCH') async details(@Param('id') id:string){const parcel=await this.db.parcelDelivery.findUnique({where:{id}});if(!parcel)throw new NotFoundException();return parcel;}

}

@Controller('mobile/parcel/courier') @UseGuards(MobileGuard)
export class CourierParcelController {
 constructor(private readonly db:Database){}
 @Get('deliveries') async mine(@Req() req:any){if(req.mobile.role!=='DRIVER')throw new ForbiddenException();return this.db.parcelDelivery.findMany({where:{driverId:req.mobile.sub},orderBy:{createdAt:'desc'},take:50});}
 @Get('deliveries/:id/tracking') async tracking(@Req() req:any,@Param('id') id:string){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  const p=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!p||p.driverId!==req.mobile.sub)throw new NotFoundException();
  return {status:p.status,trackingEnabled:['ACCEPTED','PICKED_UP','IN_TRANSIT'].includes(p.status)};
 }
 @Post('deliveries/:id/proof') async uploadProof(@Req() req:any,@Param('id') id:string,@Body() dto:PhotoDto){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  const p=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!p||p.driverId!==req.mobile.sub)throw new NotFoundException();
  if(p.status!=='DELIVERED')throw new ConflictException('Complete delivery first');
  if(p.proofPhotoSha256)throw new ConflictException('Proof already submitted');
  const bytes=validateParcelPhoto(dto.mime,dto.base64);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.mkdir(photoDir(),{recursive:true,mode:0o700});
  await fs.writeFile(path.join(photoDir(),hash),bytes,{flag:'wx',mode:0o600}).catch(async(e:any)=>{if(e.code!=='EEXIST')throw e;});
  const updated=await this.db.parcelDelivery.updateMany({where:{id,driverId:req.mobile.sub,status:'DELIVERED',proofPhotoSha256:null},data:{proofPhotoSha256:hash,proofPhotoMime:dto.mime,proofPhotoBytes:bytes.length,proofPhotoUploadedAt:new Date()}});
  if(updated.count!==1)throw new ConflictException('Proof already submitted');
  return {sha256:hash,bytes:bytes.length,stored:true};
 }
 @Post('deliveries/:id/cash-collected') async cash(@Req() req:any,@Param('id') id:string,@Body() dto:ParcelCashDto){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  const approved=await this.db.parcelDelivery.findUnique({where:{id}});
  if(!approved?.fareApprovedAt)throw new ConflictException('Customer must approve the parcel fare before cash collection');
  const online=await this.db.parcelPayment.findUnique({where:{parcelId:id}});
  if(online)throw new ConflictException('Online payment already initiated');
  const updated=await this.db.parcelDelivery.updateMany({where:{id,driverId:req.mobile.sub,status:'DELIVERED',parcelPaymentStatus:'UNPAID',estimatedFarePaise:{not:null}},data:{parcelPaymentStatus:'COLLECTED',parcelPaymentMethod:dto.method,parcelPaymentRecordedAt:new Date()}});
  if(updated.count!==1)throw new ConflictException('Parcel is not eligible for cash collection');
  return {status:'COLLECTED',method:'CASH',note:'Driver-reported collection, not bank verified'};
 }
 @Post('deliveries/:id/pickup') async pickup(@Req() req:any,@Param('id') id:string,@Body() dto:VerifyDto){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  return this.db.$transaction(async tx=>{
   const p=await tx.parcelDelivery.findUnique({where:{id}});
   if(!p||p.driverId!==req.mobile.sub)throw new NotFoundException();
   if(p.status!=='ACCEPTED')throw new ConflictException('Pickup not allowed');
   if(p.pickupAttempts>=5)throw new ForbiddenException('Too many attempts');
   if(!p.pickupCodeExpiresAt||p.pickupCodeExpiresAt.getTime()<Date.now())throw new ForbiddenException('Pickup code expired');
   if(p.pickupCodeHash!==digest(dto.code)){await tx.parcelDelivery.update({where:{id},data:{pickupAttempts:{increment:1}}});return {verified:false};}
   await tx.parcelDelivery.update({where:{id},data:{status:'PICKED_UP',pickedUpAt:new Date(),pickupCodeHash:null,pickupCodeExpiresAt:null}});
   return {verified:true,status:'PICKED_UP'};
  });
 }
 @Post('deliveries/:id/deliver') async deliver(@Req() req:any,@Param('id') id:string,@Body() dto:VerifyDto){
  if(req.mobile.role!=='DRIVER')throw new ForbiddenException();
  return this.db.$transaction(async tx=>{
   const p=await tx.parcelDelivery.findUnique({where:{id}});
   if(!p||p.driverId!==req.mobile.sub)throw new NotFoundException();
   if(p.status!=='PICKED_UP'&&p.status!=='IN_TRANSIT')throw new ConflictException('Delivery not allowed');
   if(p.deliveryAttempts>=5)throw new ForbiddenException('Too many attempts');
   if(!p.deliveryCodeExpiresAt||p.deliveryCodeExpiresAt.getTime()<Date.now())throw new ForbiddenException('Delivery code expired');
   if(p.deliveryCodeHash!==digest(dto.code)){await tx.parcelDelivery.update({where:{id},data:{deliveryAttempts:{increment:1}}});return {verified:false};}
   await tx.parcelDelivery.update({where:{id},data:{status:'DELIVERED',deliveredAt:new Date(),deliveryCodeHash:null,deliveryCodeExpiresAt:null}});
   return {verified:true,status:'DELIVERED'};
  });
 }
}
