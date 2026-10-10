import { JwtAuthGuard, RolesGuard, Roles } from './security';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Database } from './database';
import { MobileGuard } from './mobile-auth';
import { LiveGateway } from './realtime';
import { PushService } from './push';

class ChatMessageDto { @IsString() @MinLength(1) @MaxLength(1000) text!:string; }
const activeStatuses=['ASSIGNED','ARRIVING','IN_PROGRESS'];
@Controller('mobile/communications') @UseGuards(MobileGuard)
export class RideCommunicationSummaryController {
 constructor(private db:Database){}
 @Get('unread-summary') async unreadSummary(@Req() req:any){
  if(!['CUSTOMER','DRIVER'].includes(req.mobile.role))throw new ForbiddenException('Invalid role');
  const rides=await this.db.ride.findMany({where:{status:{in:activeStatuses},driverId:{not:null},
   ...(req.mobile.role==='CUSTOMER'?{customerId:req.mobile.sub}:{driverId:req.mobile.sub})},select:{id:true},take:100});
  const rideIds=rides.map(r=>r.id);
  if(!rideIds.length)return {counts:{},total:0};
  const rows=await this.db.rideChatMessage.groupBy({by:['rideId'],where:{rideId:{in:rideIds},role:{not:req.mobile.role},readAt:null},_count:{_all:true}});
  const counts=Object.fromEntries(rows.map(r=>[r.rideId,r._count._all]));
  return {counts,total:rows.reduce((n,r)=>n+r._count._all,0)};
 }
}

@Controller('mobile/rides/:id/communication') @UseGuards(MobileGuard)
export class RideCommunicationsController {
 constructor(private db:Database,private live:LiveGateway,private push:PushService){}
 private async permitted(req:any,id:string){
  const ride=await this.db.ride.findUnique({where:{id},select:{id:true,customerId:true,driverId:true,status:true,reference:true}});
  if(!ride||!ride.driverId||!activeStatuses.includes(ride.status))throw new ForbiddenException('Communication available only during an accepted active trip');
  const own=req.mobile.role==='CUSTOMER'?ride.customerId===req.mobile.sub:req.mobile.role==='DRIVER'&&ride.driverId===req.mobile.sub;
  if(!own)throw new ForbiddenException('Not a participant in this trip');
  return ride;
 }
 @Get('sync') async sync(@Req() req:any,@Param('id') id:string){
  await this.permitted(req,id);
  const [messages,unread]=await Promise.all([
   this.db.rideChatMessage.findMany({where:{rideId:id},orderBy:{createdAt:'desc'},take:100,
    select:{id:true,role:true,text:true,createdAt:true,readAt:true}}),
   this.db.rideChatMessage.count({where:{rideId:id,role:{not:req.mobile.role},readAt:null}})
  ]);
  return {messages:messages.reverse(),unread,serverTime:new Date().toISOString()};
 }
 @Get('messages') async messages(@Req() req:any,@Param('id') id:string){
  await this.permitted(req,id);
  return this.db.rideChatMessage.findMany({where:{rideId:id},orderBy:{createdAt:'desc'},take:100,
   select:{id:true,role:true,text:true,createdAt:true,readAt:true}}).then(rows=>rows.reverse());
 }
 @Get('unread') async unread(@Req() req:any,@Param('id') id:string){
  await this.permitted(req,id);
  return {count:await this.db.rideChatMessage.count({where:{rideId:id,role:{not:req.mobile.role},readAt:null}})};
 }
 @Post('read') async read(@Req() req:any,@Param('id') id:string){
  const ride=await this.permitted(req,id);
  const result=await this.db.rideChatMessage.updateMany({where:{rideId:id,role:{not:req.mobile.role},readAt:null},data:{readAt:new Date()}});
  if(result.count>0)this.live.rideChatRead(ride.customerId,ride.driverId!,id,req.mobile.role);
  return {markedRead:result.count};
 }
 @Post('messages') async send(@Req() req:any,@Param('id') id:string,@Body() dto:ChatMessageDto){
  const ride=await this.permitted(req,id);
  const text=dto.text.trim();if(!text)throw new BadRequestException('Message cannot be blank');
  const recent=await this.db.rideChatMessage.count({where:{rideId:id,senderId:req.mobile.sub,createdAt:{gt:new Date(Date.now()-60000)}}});
  if(recent>=12)throw new BadRequestException('Message limit reached; please wait');
  const message=await this.db.rideChatMessage.create({data:{rideId:id,senderId:req.mobile.sub,role:req.mobile.role,text},select:{id:true,role:true,text:true,createdAt:true,readAt:true}});
  this.live.rideChatMessage(ride.customerId,ride.driverId!,id,message);
  const recipient=req.mobile.role==='CUSTOMER'?{id:ride.driverId!,role:'DRIVER' as const}:{id:ride.customerId,role:'CUSTOMER' as const};
  void this.push.enqueue(recipient.id,recipient.role,`chat:${message.id}`,'CHAT','New trip message',`New message about ride ${ride.reference}`,id).catch(()=>{});
  return message;
 }
 @Get('call') async call(@Req() req:any,@Param('id') id:string){
  if(process.env.MASKED_CALL_PROVIDER_ENABLED!=='true')throw new ForbiddenException('Calling is disabled for this launch. Use trip chat.');
  const ride=await this.permitted(req,id);
  // Never disclose a participant's real phone number to the other party.
  const customer=req.mobile.role==='DRIVER';
  const person=customer?await this.db.customer.findUnique({where:{id:ride.customerId},select:{name:true}}):await this.db.driver.findUnique({where:{id:ride.driverId!},select:{name:true}});
  if(!person)throw new BadRequestException('Contact unavailable');
  // Only an approved server-side provider adapter may provision a relay. This
  // endpoint never returns participant numbers, even when the adapter is absent.
  const session=await this.db.maskedCallSession.findFirst({where:{rideId:id,status:'ACTIVE',expiresAt:{gt:new Date()}},orderBy:{createdAt:'desc'}});
  if(!session)throw new BadRequestException('Masked calling is not configured for this trip. Use trip chat.');
  if(!/^\+[1-9][0-9]{7,14}$/.test(session.relayNumber))throw new BadRequestException('Invalid masked relay');
  return {name:person.name,masked:true,relayNumber:session.relayNumber,expiresAt:session.expiresAt};
 }
}

// Operational visibility only. Provider callback validation and session provisioning
// must be supplied by a trusted telecom adapter, never by mobile callers.
@Controller('admin/communications/calls') @UseGuards(JwtAuthGuard,RolesGuard) @Roles('ADMIN')
export class AdminMaskedCallDiagnosticsController {
 constructor(private db:Database){}
 @Get('diagnostics') async diagnostics(){
  const now=new Date();
  const [active,expired,revoked,recent]=await Promise.all([
   this.db.maskedCallSession.count({where:{status:'ACTIVE',expiresAt:{gt:now}}}),
   this.db.maskedCallSession.count({where:{expiresAt:{lte:now}}}),
   this.db.maskedCallSession.count({where:{status:{not:'ACTIVE'}}}),
   this.db.maskedCallSession.findMany({orderBy:{createdAt:'desc'},take:30,
    select:{id:true,rideId:true,status:true,expiresAt:true,createdAt:true}})
  ]);
  return {active,expired,revoked,recent,providerConfigured:process.env.MASKED_CALL_PROVIDER_ENABLED==='true',note:'Relay numbers are never exposed in diagnostics. Provider configuration does not verify carrier connectivity.'};
 }
}
