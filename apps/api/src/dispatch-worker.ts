import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Database } from './database';
import { LiveGateway } from './realtime';
import { rankNearbyDrivers } from './geo';

/** Single-process development dispatcher. For multi-replica production use a distributed job/lock. */
@Injectable()
export class DispatchWorker implements OnModuleInit, OnModuleDestroy {
 private readonly log=new Logger(DispatchWorker.name);
 private timer?:ReturnType<typeof setInterval>;
 private running=false;
 constructor(private db:Database,private live:LiveGateway){}
 onModuleInit(){if(process.env.AUTO_DISPATCH==='false')return;this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref?.();void this.tick();}
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
 async tick(){if(this.running)return;this.running=true;try{
  const expired=await this.db.rideOffer.findMany({where:{status:'PENDING',expiresAt:{lte:new Date()}},take:100});
  for(const offer of expired){try{const changed=await this.db.$transaction(async tx=>{
   const result=await tx.rideOffer.updateMany({where:{id:offer.id,status:'PENDING',expiresAt:{lte:new Date()}},data:{status:'EXPIRED',respondedAt:new Date()}});
   if(result.count!==1)return false;
   await tx.rideOfferAttempt.updateMany({where:{rideId:offer.rideId,driverId:offer.driverId,outcome:'PENDING'},data:{outcome:'EXPIRED'}});
   await tx.ride.updateMany({where:{id:offer.rideId,status:'ASSIGNED',driverId:offer.driverId},data:{status:'MATCHING',driverId:null,vehicleId:null}});
   return true;
  });if(changed)await this.live.rideChanged(offer.rideId);}catch(e){this.log.warn('Expiry failed: '+String(e));}}
  const queue=await this.db.ride.findMany({where:{status:{in:['REQUESTED','MATCHING']},scheduledAt:null,poolGroupId:null},orderBy:{createdAt:'asc'},take:30});
  for(const ride of queue){try{const driver=await this.db.$transaction(async tx=>{
   const current=await tx.ride.findUnique({where:{id:ride.id}});
   if(!current||!['REQUESTED','MATCHING'].includes(current.status)||current.driverId)return null;
   const attempted=await tx.rideOfferAttempt.findMany({where:{rideId:ride.id},select:{driverId:true}});
   const excluded=attempted.map(a=>a.driverId);
   const candidates=await tx.driver.findMany({where:{cityId:ride.cityId,status:'APPROVED',online:true,id:{notIn:excluded},vehicle:{is:{active:true,type:ride.type}}},include:{vehicle:true},orderBy:{id:'asc'},take:100});
   const locations=await tx.driverLocation.findMany({where:{driverId:{in:candidates.map(c=>c.id)},updatedAt:{gte:new Date(Date.now()-120000)}}});
   const ranked=rankNearbyDrivers(candidates,locations,ride.pickupLatitude,ride.pickupLongitude);
   for(const candidate of ranked){
    const busy=await tx.ride.count({where:{driverId:candidate.id,status:{in:['ASSIGNED','ARRIVING','IN_PROGRESS']}}});
    if(busy)continue;
    const result=await tx.ride.updateMany({where:{id:ride.id,status:current.status,driverId:null},data:{driverId:candidate.id,vehicleId:candidate.vehicle!.id,status:'ASSIGNED'}});
    if(result.count!==1)return null;
    const expiresAt=new Date(Date.now()+45000);
    await tx.rideOffer.upsert({where:{rideId:ride.id},create:{rideId:ride.id,driverId:candidate.id,status:'PENDING',expiresAt},update:{driverId:candidate.id,status:'PENDING',expiresAt,respondedAt:null}});
    await tx.rideOfferAttempt.create({data:{rideId:ride.id,driverId:candidate.id}});
    return candidate.id;
   }
   return null;
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  if(driver)await this.live.rideChanged(ride.id);
  }catch(e:any){if(e?.code!=='P2034'&&e?.code!=='P2002')this.log.warn('Match failed: '+String(e));}}
 }catch(e){this.log.error('Dispatch tick failed: '+String(e));}finally{this.running=false;}}
}
