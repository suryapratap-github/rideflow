import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Database } from './database';
import { configuredMaskedCallingProvider, maskedCallIdempotencyKey } from './masked-calling-provider';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtAuthGuard, RolesGuard, Roles } from './security';

/** Provider-neutral webhook contract for a future trusted telecom adapter.
 * This route is disabled unless MASKED_CALL_WEBHOOK_SECRET is set.
 * The upstream adapter must map its native payload into this signed JSON contract.
 */
@Controller('webhooks/masked-calls')
export class MaskedCallWebhookController {
 constructor(private db:Database){}
 @Post() @HttpCode(200)
 async callback(@Req() req:any,@Headers('x-rideflow-signature') signature:string){
  const secret=process.env.MASKED_CALL_WEBHOOK_SECRET;
  if(!secret || secret.length<32)throw new ForbiddenException('Masked call callbacks disabled');
  const raw=req.rawBody;
  if(!Buffer.isBuffer(raw) || typeof signature!=='string' || !/^sha256=[a-f0-9]{64}$/i.test(signature))throw new ForbiddenException('Invalid callback signature');
  const expected=createHmac('sha256',secret).update(raw).digest();
  const supplied=Buffer.from(signature.slice(7),'hex');
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new ForbiddenException('Invalid callback signature');
  let payload:any;
  try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new BadRequestException('Invalid callback JSON');}
  if(!payload||typeof payload.providerSessionId!=='string'||payload.providerSessionId.length>200||
     typeof payload.eventId!=='string'||! /^[a-zA-Z0-9_-]{8,128}$/.test(payload.eventId)||
     typeof payload.occurredAt!=='string'||!['ENDED','FAILED'].includes(payload.status))throw new BadRequestException('Invalid callback event');
  const occurredAt=new Date(payload.occurredAt);
  const now=Date.now();
  if(!Number.isFinite(occurredAt.getTime())||Math.abs(now-occurredAt.getTime())>5*60*1000)throw new ForbiddenException('Callback outside freshness window');
  // Unique event IDs and the transition are committed atomically. Duplicate deliveries are harmless.
  try{
   return await this.db.$transaction(async(tx:any)=>{
    await tx.maskedCallEvent.create({data:{eventId:payload.eventId,providerSessionId:payload.providerSessionId,status:payload.status,occurredAt}});
    const updated=await tx.maskedCallSession.updateMany({where:{providerSessionId:payload.providerSessionId,status:'ACTIVE'},data:{status:payload.status}});
    await tx.maskedCallEvent.update({where:{eventId:payload.eventId},data:{applied:updated.count>0}});
    return {accepted:true,duplicate:false,updated:updated.count};
   });
  }catch(error:any){
   if(error?.code==='P2002')return {accepted:true,duplicate:true,updated:0};
   throw error;
  }
 }
}

@Injectable()
export class MaskedCallExpiryWorker implements OnModuleInit,OnModuleDestroy {
 private timer?:ReturnType<typeof setInterval>;
 constructor(private db:Database){}
 onModuleInit(){
  this.timer=setInterval(()=>{void this.expire().catch(()=>{});},60000);
  this.timer.unref?.();
  void this.expire().catch(()=>{});
 }
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
 async expire(){
  // Database-backed lease prevents concurrent workers from repeatedly revoking a relay.
  // An unconfirmed provider response leaves the session ACTIVE and schedules another attempt.
  const now=new Date();
  const expired=await this.db.maskedCallSession.findMany({where:{status:'ACTIVE',expiresAt:{lte:now},OR:[{nextReconcileAt:null},{nextReconcileAt:{lte:now}}]},take:50,orderBy:{expiresAt:'asc'},select:{id:true,providerSessionId:true,reconciliationAttempts:true,nextReconcileAt:true}});
  let confirmed=0,unconfirmed=0,skipped=0;
  for(const session of expired){
   const delayMinutes=Math.min(60,Math.pow(2,Math.min(session.reconciliationAttempts,6)));
   const claimed=await this.db.maskedCallSession.updateMany({where:{id:session.id,status:'ACTIVE',nextReconcileAt:session.nextReconcileAt},data:{nextReconcileAt:new Date(Date.now()+delayMinutes*60000),lastReconcileAt:new Date(),reconciliationAttempts:{increment:1}}});
   if(claimed.count!==1){skipped++;continue;}
   try{
    await configuredMaskedCallingProvider().revoke(session.providerSessionId);
    const changed=await this.db.maskedCallSession.updateMany({where:{id:session.id,status:'ACTIVE'},data:{status:'EXPIRED',nextReconcileAt:null}});
    confirmed+=changed.count;
   }catch{unconfirmed++;}
  }
  return {confirmed,unconfirmed,skipped};
 }

}

@Controller('admin/communications/calls/lifecycle') @UseGuards(JwtAuthGuard,RolesGuard) @Roles('ADMIN')
export class AdminMaskedCallLifecycleController {
 constructor(private db:Database,private expiry:MaskedCallExpiryWorker){}
 @Post('expire') async expire(){return this.expiry.expire();}
 // Provider-side revocation unavailable without configured telecom bridge; fail closed.
 @Post(':id/revoke') async revoke(@Param('id') id:string){
  const session=await this.db.maskedCallSession.findUnique({where:{id}});
  if(!session||session.status!=='ACTIVE')throw new BadRequestException('Active call session not found');
  try{await configuredMaskedCallingProvider().revoke(session.providerSessionId);}
  catch{throw new BadRequestException('Provider revocation unconfirmed; session unchanged');}
  const result=await this.db.maskedCallSession.updateMany({where:{id,status:'ACTIVE'},data:{status:'REVOKED'}});
  return {revoked:result.count===1};
 }
 @Post(':rideId/provision') async provision(@Param('rideId') rideId:string){
  const ride=await this.db.ride.findUnique({where:{id:rideId},select:{id:true,status:true,customerId:true,driverId:true}});
  if(!ride||!ride.driverId||!['ASSIGNED','ARRIVING','IN_PROGRESS'].includes(ride.status))throw new BadRequestException('Active assigned trip required');
  const existing=await this.db.maskedCallSession.findFirst({where:{rideId,status:'ACTIVE',expiresAt:{gt:new Date()}},select:{id:true,expiresAt:true}});
  if(existing)return {sessionId:existing.id,expiresAt:existing.expiresAt,reused:true};
  const [customer,driver]=await Promise.all([this.db.customer.findUnique({where:{id:ride.customerId},select:{phone:true}}),this.db.driver.findUnique({where:{id:ride.driverId},select:{phone:true}})]);
  if(!customer?.phone||!driver?.phone)throw new BadRequestException('Participant contact unavailable');
  const expiresAt=new Date(Date.now()+15*60000);
  let idempotencyKey:string;
  try{idempotencyKey=maskedCallIdempotencyKey(rideId);}catch{throw new BadRequestException('Masked call idempotency not configured');}
  let provisioned:{providerSessionId:string;relayNumber:string};
  try{provisioned=await configuredMaskedCallingProvider().provision({rideId,customerPhone:customer.phone,driverPhone:driver.phone,expiresAt,idempotencyKey});}
  catch{throw new BadRequestException('Masked call provider unavailable; no session created');}
  try{
   const created=await this.db.maskedCallSession.create({data:{rideId,providerSessionId:provisioned.providerSessionId,relayNumber:provisioned.relayNumber,expiresAt},select:{id:true,expiresAt:true}});
   return {sessionId:created.id,expiresAt:created.expiresAt,reused:false};
  }catch{
   // Best effort compensation; never report an unpersisted session as usable.
   try{await configuredMaskedCallingProvider().revoke(provisioned.providerSessionId);}catch{}
   throw new BadRequestException('Could not persist masked call session');
  }
 }
}


@Controller('admin/communications/calls/events') @UseGuards(JwtAuthGuard,RolesGuard) @Roles('ADMIN')
export class AdminMaskedCallEventsController {
 constructor(private db:Database){}
 @Get() async list(){
  const [events,unresolved]=await Promise.all([
   this.db.maskedCallEvent.findMany({orderBy:{receivedAt:'desc'},take:100,select:{eventId:true,providerSessionId:true,status:true,occurredAt:true,receivedAt:true,applied:true}}),
   this.db.maskedCallSession.count({where:{status:'ACTIVE',expiresAt:{lte:new Date()}}})
  ]);
  return {events,unresolvedExpiredSessions:unresolved};
 }
 @Get('investigation') async investigation(){
  const now=new Date();
  const sessions=await this.db.maskedCallSession.findMany({
   where:{status:'ACTIVE',expiresAt:{lte:now}},
   orderBy:{expiresAt:'asc'},take:100,
   select:{id:true,rideId:true,status:true,expiresAt:true,createdAt:true,reconciliationAttempts:true,nextReconcileAt:true}
  });
  return {sessions,limit:100,truncated:sessions.length===100,generatedAt:now.toISOString(),note:'Active sessions past expiry require provider-confirmed revocation. No phone or relay numbers are returned.'};
 }
 @Get('health') async health(){
  const now=new Date();
  const stale=new Date(now.getTime()-30*60000);
  const [unresolved,overdue,repeatFailures,recentEvents]=await Promise.all([
   this.db.maskedCallSession.count({where:{status:'ACTIVE',expiresAt:{lte:now}}}),
   this.db.maskedCallSession.count({where:{status:'ACTIVE',expiresAt:{lte:stale}}}),
   this.db.maskedCallSession.count({where:{status:'ACTIVE',expiresAt:{lte:now},reconciliationAttempts:{gte:3}}}),
   this.db.maskedCallEvent.count({where:{receivedAt:{gte:new Date(now.getTime()-60*60000)}}})
  ]);
  return {unresolved,overdue30Minutes:overdue,repeatedFailures:repeatFailures,eventsLastHour:recentEvents,alert:overdue>0||repeatFailures>0,providerConnected:process.env.MASKED_CALL_PROVIDER_ENABLED==='true',note:'Provider configuration is not proof of carrier connectivity; unresolved sessions require investigation.'};
 }
}


/** Durable administrator incident queue. Incidents never revoke a relay themselves. */
@Controller('admin/communications/calls/incidents') @UseGuards(JwtAuthGuard,RolesGuard) @Roles('ADMIN')
export class AdminMaskedCallIncidentsController {
 constructor(private db:Database){}
 @Get() async list(){
  return {incidents:await this.db.maskedCallIncident.findMany({orderBy:{updatedAt:'desc'},take:100,select:{id:true,sessionId:true,status:true,severity:true,summary:true,createdAt:true,updatedAt:true,acknowledgedAt:true,resolvedAt:true}})};
 }
 @Post('scan') async scan(){
  const overdue=new Date(Date.now()-30*60000);
  const sessions=await this.db.maskedCallSession.findMany({where:{status:'ACTIVE',expiresAt:{lte:overdue}},take:100,select:{id:true,reconciliationAttempts:true}});
  let recorded=0;
  for(const session of sessions){
   const result=await this.db.maskedCallIncident.upsert({where:{sessionId:session.id},create:{sessionId:session.id,status:'OPEN',severity:session.reconciliationAttempts>=3?'HIGH':'MEDIUM',summary:'Expired relay requires provider-confirmed revocation'},update:{},select:{id:true,createdAt:true}});
   // Count is informational; upsert is safe under concurrent scans.
   if(result)recorded++;
  }
  return {scanned:sessions.length,recorded,limit:100,note:'Scanning records incidents; it does not disconnect relays.'};
 }
 @Post(':id/acknowledge') async acknowledge(@Param('id') id:string){
  const result=await this.db.maskedCallIncident.updateMany({where:{id,status:'OPEN'},data:{status:'ACKNOWLEDGED',acknowledgedAt:new Date()}});
  return {acknowledged:result.count===1};
 }
 @Post(':id/resolve') async resolve(@Param('id') id:string){
  const incident=await this.db.maskedCallIncident.findUnique({where:{id},select:{sessionId:true,status:true}});
  if(!incident||!['OPEN','ACKNOWLEDGED'].includes(incident.status))throw new BadRequestException('Open incident not found');
  const session=await this.db.maskedCallSession.findUnique({where:{id:incident.sessionId},select:{status:true}});
  if(!session||!['EXPIRED','REVOKED','ENDED','FAILED'].includes(session.status))throw new BadRequestException('Provider-confirmed terminal session required');
  const result=await this.db.maskedCallIncident.updateMany({where:{id,status:{in:['OPEN','ACKNOWLEDGED']}},data:{status:'RESOLVED',resolvedAt:new Date()}});
  return {resolved:result.count===1};
 }
}
