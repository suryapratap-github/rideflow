import { Body, Controller, Get, Param, Patch, Post, BadRequestException, UseGuards, Req } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MinLength, IsBoolean } from 'class-validator';
import { RideStatus, VehicleType } from '@prisma/client';
import { Database } from './database';
import { JwtAuthGuard, RolesGuard, Roles } from './security';
import { StaffRole, Prisma } from '@prisma/client';
import { LiveGateway } from './realtime';
class CreateRideDto { @IsString() @MinLength(3) customerId!:string; @IsString() @MinLength(3) cityId!:string; @IsString() @MinLength(3) pickup!:string; @IsString() @MinLength(3) dropoff!:string; @IsEnum(VehicleType) type!:VehicleType; @IsOptional() @IsString() scheduledAt?:string; }
class AssignRideDto { @IsString() @MinLength(3) driverId!:string; }
class DriverAvailabilityDto { @IsBoolean() online!:boolean; }
class UpdateRideDto { @IsEnum(RideStatus) status!:RideStatus; }
const transitions:Record<RideStatus,RideStatus[]>={REQUESTED:['MATCHING','CANCELLED'],MATCHING:['ASSIGNED','CANCELLED'],ASSIGNED:['ARRIVING','CANCELLED'],ARRIVING:['IN_PROGRESS','CANCELLED'],IN_PROGRESS:['COMPLETED'],COMPLETED:[],CANCELLED:[]};
@Controller() @UseGuards(JwtAuthGuard,RolesGuard) export class AppController {
 constructor(private readonly db:Database,private readonly live:LiveGateway){}
 @Get('health') health(){return {status:'ok',service:'rideflow-api'};}
 @Get('dashboard/overview') @Roles('ADMIN','DISPATCH') async overview(){const [rides,drivers,customers,vehicles,activeRides,openTickets,incidents]=await Promise.all([this.db.ride.count(),this.db.driver.count(),this.db.customer.count(),this.db.vehicle.count(),this.db.ride.count({where:{status:{in:['MATCHING','ASSIGNED','ARRIVING','IN_PROGRESS']}}}),this.db.supportTicket.count({where:{status:{not:'RESOLVED'}}}),this.db.safetyIncident.count({where:{status:'OPEN'}})]);return {rides,drivers,customers,vehicles,activeRides,openTickets,incidents};}
 @Get('fleet/overview') async fleetOverview(@Req() req:any){const scope=req.user.role==='FLEET_MANAGER'?{fleetId:req.user.fleetId}:{ };const [vehicles,drivers,activeTrips,expiringDocuments]=await Promise.all([this.db.vehicle.count({where:scope}),this.db.driver.count({where:scope}),this.db.ride.count({where:{status:'IN_PROGRESS',...(req.user.role==='FLEET_MANAGER'?{driver:{fleetId:req.user.fleetId}}:{})}}),this.db.vehicle.count({where:{...scope,documentExpiry:{lt:new Date(Date.now()+30*86400000)}}})]);return {vehicles,drivers,activeTrips,expiringDocuments};}
 @Get('rides') rides(@Req() req:any){return this.db.ride.findMany({where:req.user.role==='FLEET_MANAGER'?{driver:{fleetId:req.user.fleetId}}:{},include:{customer:true,driver:true,city:true,vehicle:true},orderBy:{createdAt:'desc'},take:100});}
 @Get('drivers') drivers(@Req() req:any){return this.db.driver.findMany({where:req.user.role==='FLEET_MANAGER'?{fleetId:req.user.fleetId}:{},include:{city:true,fleet:true,vehicle:true},take:100});}
 @Get('customers') @Roles('ADMIN','DISPATCH') customers(){return this.db.customer.findMany({take:100});}
 @Get('vehicles') vehicles(@Req() req:any){return this.db.vehicle.findMany({where:req.user.role==='FLEET_MANAGER'?{fleetId:req.user.fleetId}:{},include:{city:true,fleet:true,driver:true},take:100});}
 @Get('cities') @Roles('ADMIN','DISPATCH') cities(){return this.db.city.findMany({orderBy:{name:'asc'}});}
 @Get('fleets') @Roles('ADMIN','DISPATCH') fleets(){return this.db.fleet.findMany({include:{_count:{select:{drivers:true,vehicles:true}}}});}
 @Get('pricing') @Roles('ADMIN','DISPATCH') pricing(){return this.db.pricingRule.findMany();}
 @Get('payments') @Roles('ADMIN','DISPATCH') payments(){return this.db.ridePayment.findMany({orderBy:{createdAt:'desc'},take:100});}
 @Get('payments/reconciliation') @Roles('ADMIN','DISPATCH') async paymentReconciliation(){
  const payments=await this.db.ridePayment.findMany({where:{method:'UPI'},orderBy:{createdAt:'desc'},take:100,select:{rideId:true,method:true,status:true,amountPaise:true,upiReference:true,upiInitiatedAt:true,createdAt:true}});
  const summary=payments.reduce((a,p)=>{a.total++;a.pending+=p.status==='PENDING'?1:0;a.recorded+=p.status==='RECORDED'?1:0;return a;},{total:0,pending:0,recorded:0});
  return {summary,records:payments,notice:'Read-only audit view; not a bank settlement reconciliation. Only verified provider events may confirm online payment.'};
 }
 @Get('settlements') @Roles('ADMIN','DISPATCH') settlements(){return this.db.settlement.findMany({orderBy:{createdAt:'desc'}});}
 @Get('support') @Roles('ADMIN','DISPATCH') support(){return this.db.supportTicket.findMany({orderBy:{createdAt:'desc'}});}
 @Get('safety') @Roles('ADMIN','DISPATCH') safety(){return this.db.safetyIncident.findMany({orderBy:{createdAt:'desc'}});}
 @Get('shifts') @Roles('ADMIN','DISPATCH') shifts(){return this.db.shift.findMany();}
 @Get('audit') @Roles('ADMIN','DISPATCH') audit(){return this.db.auditLog.findMany({orderBy:{createdAt:'desc'},take:100});}
 @Post('rides') @Roles('ADMIN','DISPATCH') async createRide(@Body() dto:CreateRideDto){const reference='RF-'+Date.now().toString(36).toUpperCase();return this.db.ride.create({data:{reference,customerId:dto.customerId,cityId:dto.cityId,pickup:dto.pickup,dropoff:dto.dropoff,type:dto.type,scheduledAt:dto.scheduledAt?new Date(dto.scheduledAt):undefined,status:'REQUESTED'}});}
 @Patch('rides/:id/status') @Roles('ADMIN','DISPATCH') async updateRide(@Param('id') id:string,@Body() dto:UpdateRideDto){const ride=await this.db.ride.findUnique({where:{id}});if(!ride)throw new BadRequestException('Ride not found');if(!transitions[ride.status].includes(dto.status))throw new BadRequestException('Invalid ride status transition');const changed=await this.db.ride.updateMany({where:{id,status:ride.status},data:{status:dto.status}});if(changed.count!==1)throw new BadRequestException('Ride changed; retry');await this.live.rideChanged(id);return this.db.ride.findUnique({where:{id}});}
 @Patch('rides/:id/assign') @Roles('ADMIN','DISPATCH') async assignRide(@Param('id') id:string,@Body() dto:AssignRideDto){
  // SERIALIZABLE prevents two dispatchers from assigning the same driver concurrently.
  let assigned:any;
  try {assigned=await this.db.$transaction(async tx=>{
   const ride=await tx.ride.findUnique({where:{id}});
   if(!ride||!['REQUESTED','MATCHING'].includes(ride.status))throw new BadRequestException('Ride not assignable');
   const driver=await tx.driver.findUnique({where:{id:dto.driverId},include:{vehicle:true}});
   if(!driver||driver.status!=='APPROVED'||!driver.online||driver.cityId!==ride.cityId||!driver.vehicle?.active||driver.vehicle.type!==ride.type)throw new BadRequestException('Driver unavailable or vehicle mismatch');
   const busy=await tx.ride.count({where:{driverId:driver.id,status:{in:['ASSIGNED','ARRIVING','IN_PROGRESS']}}});
   if(busy)throw new BadRequestException('Driver already assigned');
   const changed=await tx.ride.updateMany({where:{id,status:ride.status,driverId:null},data:{driverId:driver.id,vehicleId:driver.vehicle.id,status:'ASSIGNED'}});
   if(changed.count!==1)throw new BadRequestException('Ride already assigned');
   await tx.rideOffer.upsert({where:{rideId:id},create:{rideId:id,driverId:driver.id,status:'PENDING',expiresAt:new Date(Date.now()+45000)},update:{driverId:driver.id,status:'PENDING',expiresAt:new Date(Date.now()+45000),respondedAt:null}});
   await tx.rideOfferAttempt.upsert({where:{rideId_driverId:{rideId:id,driverId:driver.id}},create:{rideId:id,driverId:driver.id},update:{outcome:'PENDING'}});
   return tx.ride.findUnique({where:{id}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
  catch(e:any){if(e?.code==='P2034')throw new BadRequestException('Concurrent dispatch conflict; retry');throw e;}
  await this.live.rideChanged(id);return assigned;
 }
 @Patch('drivers/:id/availability') @Roles('ADMIN','DISPATCH') async availability(@Param('id') id:string,@Body() dto:DriverAvailabilityDto){
  if(typeof dto.online!=='boolean')throw new BadRequestException('online must be boolean');
  const driver=await this.db.driver.findUnique({where:{id}});if(!driver||driver.status!=='APPROVED')throw new BadRequestException('Driver is not approved');
  return this.db.driver.update({where:{id},data:{online:dto.online}});
 }
 @Get('dispatch/queue') @Roles('ADMIN','DISPATCH') async queue(){return this.db.ride.findMany({where:{status:{in:['REQUESTED','MATCHING']}},include:{city:true,customer:true},orderBy:{createdAt:'asc'},take:100});}
 @Get('dispatch/available-drivers') @Roles('ADMIN','DISPATCH') async availableDrivers(){const drivers=await this.db.driver.findMany({where:{status:'APPROVED',online:true,vehicle:{is:{active:true}}},include:{vehicle:true,city:true}});const busy=await this.db.ride.findMany({where:{status:{in:['ASSIGNED','ARRIVING','IN_PROGRESS']},driverId:{not:null}},select:{driverId:true}});const taken=new Set(busy.map(r=>r.driverId));return drivers.filter(d=>!taken.has(d.id));}

}
