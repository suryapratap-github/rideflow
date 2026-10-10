import { BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, Post, Patch, Param, Req, UseGuards, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, IsISO8601 } from 'class-validator';
import { MobileGuard } from './mobile-auth';
import { JwtAuthGuard, RolesGuard, Roles } from './security';
import { Database } from './database';
import * as admin from 'firebase-admin';

class PreferenceDto { @IsIn([true,false]) marketingEnabled!:boolean; }
class ReadDto { @IsString() @MinLength(1) id!:string; }
class TokenDto {
 @IsString() @MinLength(32) @MaxLength(4096) token!:string;
 @IsIn(['android','ios']) platform!:'android'|'ios';
}
@Injectable()
export class PushService implements OnModuleInit,OnModuleDestroy {
 private readonly log=new Logger(PushService.name);
 async record(accountId:string,role:'CUSTOMER'|'DRIVER',eventKey:string,category:string,title:string,body:string,rideId?:string){
  await this.db.mobileNotification.upsert({where:{eventKey_accountId_role:{eventKey,accountId,role}},
   create:{eventKey,accountId,role,category,title,body,rideId},update:{}});
 }

 private outboxTimer?:ReturnType<typeof setInterval>;
 onModuleInit(){this.outboxTimer=setInterval(()=>{void this.processOutbox().catch(e=>this.log.warn('Outbox polling failed'));},15000);}
 onModuleDestroy(){if(this.outboxTimer)clearInterval(this.outboxTimer);}
 async enqueue(accountId:string,role:'CUSTOMER'|'DRIVER',eventKey:string,category:string,title:string,body:string,rideId?:string){
  await this.record(accountId,role,eventKey,category,title,body,rideId);
  try{await this.db.notificationOutbox.create({data:{accountId,role,eventKey,category,title,body,rideId}});}
  catch(e){const existing=await this.db.notificationOutbox.findUnique({where:{eventKey_accountId_role:{eventKey,accountId,role}}});if(!existing)throw e;}
 }
 private async processOutbox(){
  const messaging=this.messaging();if(!messaging)return;
  // An ambiguous FCM outcome must not be automatically resent: doing so can
  // duplicate a push. Claims older than 2 minutes become REVIEW_REQUIRED.
  await this.db.notificationOutbox.updateMany({where:{status:'SENDING',claimedAt:{lt:new Date(Date.now()-120000)}},
   data:{status:'REVIEW_REQUIRED',lastError:'Worker interrupted during provider send; manual review required'}});
  const pending=await this.db.notificationOutbox.findMany({where:{status:'PENDING',nextAttemptAt:{lte:new Date()}},
   orderBy:{createdAt:'asc'},take:30});
  for(const item of pending){
   const claim=await this.db.notificationOutbox.updateMany({where:{id:item.id,status:'PENDING'},data:{status:'SENDING',claimedAt:new Date(),attempts:{increment:1}}});
   if(claim.count!==1)continue;
   try{
    const devices=await this.db.pushDevice.findMany({where:{accountId:item.accountId,role:item.role as 'CUSTOMER'|'DRIVER',enabled:true},take:20});
    if(!devices.length){await this.db.notificationOutbox.update({where:{id:item.id},data:{status:'NO_DEVICES'}});continue;}
    const response=await messaging.sendEachForMulticast({tokens:devices.map(d=>d.token),
     notification:{title:item.title,body:item.body},
     data:{type:item.category==='RIDE'?'ride_status':item.category==='PAYMENT'?'payment_status':item.category==='CHAT'?'chat_message':'admin_announcement',
      ...(item.rideId?{rideId:item.rideId}:{}),eventKey:item.eventKey},
     android:{priority:item.category==='RIDE'?'high':'normal'},apns:{payload:{aps:{sound:'default'}}}});
    for(let i=0;i<response.responses.length;i++){
     if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(response.responses[i].error?.code||'')){
      await this.db.pushDevice.deleteMany({where:{token:devices[i].token,accountId:item.accountId}});
     }
    }
    // Some tokens may fail transiently after other tokens were accepted.
    // Mark for review rather than resending the whole multicast.
    await this.db.notificationOutbox.update({where:{id:item.id},data:{
     status:response.failureCount?'REVIEW_REQUIRED':'ACCEPTED',
     providerAcceptedAt:response.successCount?new Date():null,
     lastError:response.failureCount?`${response.failureCount} of ${devices.length} token(s) failed; inspect before retry`:null}});
   }catch(e){
    // The provider may have accepted the request before transport failed.
    // No automatic retry after an ambiguous provider call.
    await this.db.notificationOutbox.update({where:{id:item.id},data:{status:'REVIEW_REQUIRED',lastError:'Ambiguous FCM send failure; inspect before retry'}});
   }
  }
 }
 constructor(private db:Database){}
 messaging(){
  if(process.env.PUSH_NOTIFICATIONS_ENABLED!=='true')return null;
  try {
   if(!admin.apps.length)admin.initializeApp({credential:admin.credential.applicationDefault()});
   return admin.messaging();
  }catch(e){this.log.warn('FCM unavailable; push disabled');return null;}
 }
 async sendPaymentUpdate(rideId:string,kind:'captured'|'refunded'){
  const ride=await this.db.ride.findUnique({where:{id:rideId},select:{customerId:true,reference:true}});
  if(!ride)return;
  await this.enqueue(ride.customerId,'CUSTOMER',`payment:${rideId}:${kind}`,'PAYMENT',
   kind==='captured'?'Payment received':'Refund processed',
   `Ride ${ride.reference}: ${kind==='captured'?'payment recorded':'refund processed'}.`,rideId);
 }
 async sendRideUpdate(ride:{id:string;reference:string;status:string;customerId:string;driverId:string|null;updatedAt:Date}){
  if(!['ASSIGNED','ARRIVING','IN_PROGRESS','COMPLETED','CANCELLED'].includes(ride.status))return;
  const key=[ride.id,ride.status,ride.driverId||'',ride.updatedAt.getTime()].join(':');
  const audience=[{accountId:ride.customerId,role:'CUSTOMER' as const},
   ...(ride.driverId?[{accountId:ride.driverId,role:'DRIVER' as const}]:[])];
  for(const user of audience)await this.enqueue(user.accountId,user.role,key,'RIDE','RideFlow ride update',
   `Ride ${ride.reference}: ${ride.status.replaceAll('_',' ').toLowerCase()}`,ride.id);
 }

}
@Controller('mobile/push') @UseGuards(MobileGuard)
export class MobilePushController {
 constructor(private db:Database){}
 @Get('inbox') async inbox(@Req() req:any){
  return this.db.mobileNotification.findMany({where:{accountId:req.mobile.sub,role:req.mobile.role},
   orderBy:{createdAt:'desc'},take:100,select:{id:true,category:true,title:true,body:true,rideId:true,readAt:true,createdAt:true}});
 }
 @Patch('inbox/:id/read') async markRead(@Req() req:any,@Param('id') id:string){
  const result=await this.db.mobileNotification.updateMany({where:{id,accountId:req.mobile.sub,role:req.mobile.role,readAt:null},data:{readAt:new Date()}});
  return {updated:result.count};
 }
 @Get('preferences') async preferences(@Req() req:any){
  const item=await this.db.pushPreference.findUnique({where:{accountId_role:{accountId:req.mobile.sub,role:req.mobile.role}}});
  return {marketingEnabled:item?.marketingEnabled===true};
 }
 @Patch('preferences') async setPreferences(@Req() req:any,@Body() dto:PreferenceDto){
  await this.db.pushPreference.upsert({where:{accountId_role:{accountId:req.mobile.sub,role:req.mobile.role}},
   create:{accountId:req.mobile.sub,role:req.mobile.role,marketingEnabled:dto.marketingEnabled},update:{marketingEnabled:dto.marketingEnabled}});
  return {marketingEnabled:dto.marketingEnabled};
 }

 @Post('token') async register(@Req() req:any,@Body() dto:TokenDto){
  if(!['CUSTOMER','DRIVER'].includes(req.mobile.role))throw new BadRequestException('Invalid role');
  await this.db.pushDevice.upsert({where:{token:dto.token},
   create:{token:dto.token,accountId:req.mobile.sub,role:req.mobile.role,platform:dto.platform},
   update:{accountId:req.mobile.sub,role:req.mobile.role,platform:dto.platform,enabled:true}});
  return {registered:true};
 }
 @Delete('token') async remove(@Req() req:any,@Body() dto:TokenDto){
  await this.db.pushDevice.deleteMany({where:{token:dto.token,accountId:req.mobile.sub,role:req.mobile.role}});
  return {registered:false};
 }
}

const campaignCategories=['GENERAL','RIDE','OFFER','PAYMENT','SAFETY','SERVICE'] as const;
const campaignTemplates={
 RIDE:{title:'RideFlow trip update',body:'Check your Trips for the latest ride status.'},
 OFFER:{title:'New RideFlow offer',body:'Open RideFlow to see the latest offers and eligibility.'},
 PAYMENT:{title:'RideFlow payment information',body:'Check your payment history in RideFlow for the latest details.'},
 SAFETY:{title:'RideFlow safety notice',body:'Please review the latest safety information in RideFlow.'},
 SERVICE:{title:'RideFlow service update',body:'Service information is available in the RideFlow app.'},
 GENERAL:{title:'RideFlow announcement',body:'You have a new update from RideFlow.'}
};
class CampaignDto {
 @IsIn(campaignCategories) category!:(typeof campaignCategories)[number];
 @IsOptional() @IsISO8601() scheduledAt?:string;
 @IsOptional() @IsString() @MinLength(12) @MaxLength(128) idempotencyKey?:string;
 @IsIn(['CUSTOMER','DRIVER']) audience!:'CUSTOMER'|'DRIVER';
 @IsString() @MinLength(3) @MaxLength(80) title!:string;
 @IsString() @MinLength(5) @MaxLength(400) body!:string;
 @IsOptional() @IsString() @MinLength(1) @MaxLength(128) targetAccountId?:string;
}
@Controller('admin/push') @UseGuards(JwtAuthGuard,RolesGuard) @Roles('ADMIN')
export class AdminPushController implements OnModuleInit,OnModuleDestroy {
 private scheduleTimer?:ReturnType<typeof setInterval>;
 onModuleInit(){this.scheduleTimer=setInterval(()=>{void this.processScheduled().catch(()=>{});},30000);}
 onModuleDestroy(){if(this.scheduleTimer)clearInterval(this.scheduleTimer);}
 @Get('templates') templates(){return campaignTemplates;}
 private parseSchedule(input?:string){
  if(!input)return null;
  const date=new Date(input);
  if(!Number.isFinite(date.getTime())||date.getTime()<Date.now()+60000||date.getTime()>Date.now()+90*86400000)
   throw new BadRequestException('Schedule must be between 1 minute and 90 days from now');
  return date;
 }
 private async processScheduled(){
  if(!this.push.messaging())return;
  await this.db.adminPushCampaign.updateMany({where:{status:'SENDING',claimedAt:{lt:new Date(Date.now()-15*60000)}},
   data:{status:'FAILED',completedAt:new Date()}});
  const due=await this.db.adminPushCampaign.findMany({where:{status:'SCHEDULED',scheduledAt:{lte:new Date()}},orderBy:{scheduledAt:'asc'},take:10});
  for(const campaign of due){
   const claimed=await this.db.adminPushCampaign.updateMany({where:{id:campaign.id,status:'SCHEDULED'},data:{status:'SENDING',claimedAt:new Date()}});
   if(claimed.count!==1)continue;
   await this.deliver(campaign.id);
  }
 }
 private async deliver(id:string){
  const campaign=await this.db.adminPushCampaign.findUnique({where:{id}});
  if(!campaign||campaign.status!=='SENDING')return;
  const messaging=this.push.messaging();
  if(!messaging){
   await this.db.adminPushCampaign.update({where:{id},data:{status:'FAILED',completedAt:new Date()}});
   return;
  }
  const where={role:campaign.audience as 'CUSTOMER'|'DRIVER',enabled:true,...(campaign.targetAccountId?{accountId:campaign.targetAccountId}:{})};
  let successes=0,failures=0;
  try{
   const marketing=campaign.category==='OFFER';
   const devices=await this.db.pushDevice.findMany({where,take:501,orderBy:{id:'asc'}});
   const eligible=[] as typeof devices;
   for(const device of devices){
    if(marketing){
     const pref=await this.db.pushPreference.findUnique({where:{accountId_role:{accountId:device.accountId,role:device.role}}});
     if(pref?.marketingEnabled!==true)continue;
    }
    eligible.push(device);
   }
   for(const device of eligible)await this.push.record(device.accountId,device.role,`campaign:${id}`,
    campaign.category,campaign.title,campaign.body);
   // Push is only attempted for opted-in eligible recipients.
   const recipients=eligible;
   if(devices.length>500)throw new Error('Recipient count exceeds 500');
   if(recipients.length){
    const result=await messaging.sendEachForMulticast({
     tokens:recipients.map(d=>d.token),notification:{title:campaign.title,body:campaign.body},
     data:{type:'admin_announcement',category:campaign.category,campaignId:id},
     android:{priority:'normal'},apns:{payload:{aps:{sound:'default'}}}
    });
    successes=result.successCount;failures=result.failureCount;
    for(let i=0;i<result.responses.length;i++){
     if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(result.responses[i].error?.code||'')){
      await this.db.pushDevice.deleteMany({where:{token:recipients[i].token}});
     }
    }
   }
   await this.db.adminPushCampaign.update({where:{id},data:{status:'COMPLETED',successfulDevices:successes,failedDevices:failures,completedAt:new Date()}});
  }catch{
   await this.db.adminPushCampaign.update({where:{id},data:{status:'FAILED',successfulDevices:successes,failedDevices:failures,completedAt:new Date()}});
  }
 }

 constructor(private db:Database,private push:PushService){}
 private async countMarketing(where:any){
  const devices=await this.db.pushDevice.findMany({where,take:501,select:{accountId:true,role:true}});
  let count=0;
  for(const d of devices){const pref=await this.db.pushPreference.findUnique({where:{accountId_role:{accountId:d.accountId,role:d.role}}});
   if(pref?.marketingEnabled===true)count++;}
  return count;
 }
 @Post('preview') async preview(@Body() dto:CampaignDto){
  const where={role:dto.audience,enabled:true,...(dto.targetAccountId?{accountId:dto.targetAccountId}:{})};
  const matchedDevices=dto.category==='OFFER'?await this.countMarketing(where):await this.db.pushDevice.count({where});
  return {matchedDevices,audience:dto.audience,targeted:!!dto.targetAccountId};
 }
 @Post('send') async send(@Req() req:any,@Body() dto:CampaignDto){
  if(!this.push.messaging())throw new BadRequestException('FCM is not configured or enabled');
  const schedule=this.parseSchedule(dto.scheduledAt);
  const where={role:dto.audience,enabled:true,...(dto.targetAccountId?{accountId:dto.targetAccountId}:{})};
  const matchedDevices=dto.category==='OFFER'?await this.countMarketing(where):await this.db.pushDevice.count({where});
  if(matchedDevices<1)throw new BadRequestException('No opted-in devices for this audience');
  if(matchedDevices>500)throw new BadRequestException('Campaign exceeds 500 devices; narrow the audience');
  if(dto.idempotencyKey){
   const previous=await this.db.adminPushCampaign.findUnique({where:{idempotencyKey:dto.idempotencyKey}});
   if(previous)return {campaignId:previous.id,status:previous.status,duplicate:true};
  }
  let campaign;
  try{
   campaign=await this.db.adminPushCampaign.create({data:{
    actorId:req.user.sub,audience:dto.audience,category:dto.category,title:dto.title.trim(),body:dto.body.trim(),
    targetAccountId:dto.targetAccountId||null,matchedDevices,scheduledAt:schedule,
    idempotencyKey:dto.idempotencyKey||null,status:schedule?'SCHEDULED':'SENDING',claimedAt:schedule?null:new Date()
   }});
  }catch(e){
   if(dto.idempotencyKey){
    const previous=await this.db.adminPushCampaign.findUnique({where:{idempotencyKey:dto.idempotencyKey}});
    if(previous)return {campaignId:previous.id,status:previous.status,duplicate:true};
   }
   throw e;
  }
  if(!schedule)await this.deliver(campaign.id);
  const result=await this.db.adminPushCampaign.findUnique({where:{id:campaign.id}});
  return {campaignId:campaign.id,status:result?.status,matchedDevices,
   successfulDevices:result?.successfulDevices||0,failedDevices:result?.failedDevices||0,scheduledAt:schedule};
 }
 @Get('delivery-diagnostics') async deliveryDiagnostics(){
  const counts=await this.db.notificationOutbox.groupBy({by:['status'],_count:{_all:true}});
  const recent=await this.db.notificationOutbox.findMany({orderBy:{createdAt:'desc'},take:30,
   select:{id:true,eventKey:true,category:true,status:true,attempts:true,createdAt:true,providerAcceptedAt:true,lastError:true}});
  return {counts,recent,note:'FCM acceptance is not confirmed device delivery'};
 }
 @Get('history') async history(){
  return this.db.adminPushCampaign.findMany({orderBy:{createdAt:'desc'},take:30,
   select:{id:true,actorId:true,audience:true,category:true,title:true,body:true,targetAccountId:true,scheduledAt:true,matchedDevices:true,successfulDevices:true,failedDevices:true,status:true,createdAt:true}});
 }
}
