import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { Database } from './database';
import { JwtAuthGuard, Roles, RolesGuard } from './security';

class EarningDto { @IsString() @MinLength(3) rideId!:string; @IsInt() @Min(0) @Max(10000) commissionBasisPoints!:number; }
class BatchDto { @IsString() @MinLength(3) driverId!:string; }
class ReconcileDto { @IsString() @MinLength(6) bankReference!:string; }
const txOptions={isolationLevel:Prisma.TransactionIsolationLevel.Serializable} as const;
const fail=(message:string):never=>{throw new BadRequestException(message);};

@Controller('admin/driver-settlements') @UseGuards(JwtAuthGuard,RolesGuard) @Roles('ADMIN')
export class DriverSettlementController {
 constructor(private readonly db:Database){}
 @Get('earnings') earnings(){return this.db.driverEarning.findMany({orderBy:{createdAt:'desc'},take:100});}
 @Get('batches') batches(){return this.db.driverSettlementBatch.findMany({orderBy:{createdAt:'desc'},take:100});}
 @Get('batches/:id/audit') audit(@Param('id') id:string){return this.db.driverSettlementAudit.findMany({where:{batchId:id},orderBy:{createdAt:'asc'}});}

 // A completed ride and verified provider capture are prerequisites, not proof of bank settlement.
 @Post('earnings') async recognize(@Body() dto:EarningDto,@Req() req:any){
  return this.db.$transaction(async tx=>{
   const ride=await tx.ride.findUnique({where:{id:dto.rideId}});
   if(!ride||ride.status!=='COMPLETED'||!ride.driverId)fail('Completed ride with assigned driver required');
   const payment=await tx.ridePayment.findUnique({where:{rideId:dto.rideId}});
   if(!payment||payment.method!=='ONLINE'||payment.status!=='RECORDED'||!payment.providerCapturedAt||!payment.stripeIntentId||payment.refundedAt||payment.refundRequestedAt)fail('Verified, non-refunded Stripe capture required');
   if(payment.amountPaise<=0||payment.amountPaise!==ride.farePaise)fail('Payment and fare must match');
   const commissionPaise=Math.floor(payment.amountPaise*dto.commissionBasisPoints/10000);
   const existing=await tx.driverEarning.findUnique({where:{rideId:ride.id}});
   if(existing){if(existing.driverId!==ride.driverId||existing.paymentId!==payment.id||existing.grossPaise!==payment.amountPaise||existing.commissionPaise!==commissionPaise)fail('Existing earning differs; manual investigation required');return existing;}
   return tx.driverEarning.create({data:{rideId:ride.id,driverId:ride.driverId,paymentId:payment.id,grossPaise:payment.amountPaise,commissionPaise,netPaise:payment.amountPaise-commissionPaise}});
  },txOptions);
 }
 @Post('batches') async createBatch(@Body() dto:BatchDto,@Req() req:any){
  return this.db.$transaction(async tx=>{
   const earnings=await tx.driverEarning.findMany({where:{driverId:dto.driverId,status:'AVAILABLE',batchId:null}});
   if(!earnings.length)fail('No available driver earnings');
   const amountPaise=earnings.reduce((n,e)=>n+e.netPaise,0);
   if(amountPaise<=0)fail('Settlement amount must be positive');
   const batch=await tx.driverSettlementBatch.create({data:{driverId:dto.driverId,amountPaise,createdById:req.user.sub}});
   const updated=await tx.driverEarning.updateMany({where:{id:{in:earnings.map(e=>e.id)},status:'AVAILABLE',batchId:null},data:{status:'RESERVED',batchId:batch.id}});
   if(updated.count!==earnings.length)fail('Concurrent earnings reservation; retry');
   await tx.driverSettlementAudit.create({data:{batchId:batch.id,actorId:req.user.sub,action:'CREATED'}});
   return batch;
  },txOptions);
 }
 @Post('batches/:id/approve') async approve(@Param('id') id:string,@Req() req:any){
  return this.db.$transaction(async tx=>{
   const batch=await tx.driverSettlementBatch.findUnique({where:{id}});
   if(!batch||batch.status!=='DRAFT')fail('Draft batch required');
   if(batch.createdById===req.user.sub)fail('Creator cannot approve their own batch');
   const changed=await tx.driverSettlementBatch.updateMany({where:{id,status:'DRAFT'},data:{status:'APPROVED',approvedById:req.user.sub,approvedAt:new Date()}});
   if(changed.count!==1)fail('Concurrent approval; retry');
   await tx.driverSettlementAudit.create({data:{batchId:id,actorId:req.user.sub,action:'APPROVED'}});
   return {id,status:'APPROVED',notice:'Approval only; bank transfer not executed'};
  },txOptions);
 }
 @Post('batches/:id/record-transfer') async recordTransfer(@Param('id') id:string,@Body() dto:ReconcileDto,@Req() req:any){
  return this.db.$transaction(async tx=>{
   const batch=await tx.driverSettlementBatch.findUnique({where:{id}});
   if(!batch||batch.status!=='APPROVED')fail('Approved batch required');
   if(batch.approvedById===req.user.sub)fail('Approver cannot record transfer');
   const changed=await tx.driverSettlementBatch.updateMany({where:{id,status:'APPROVED'},data:{status:'TRANSFER_RECORDED',bankReference:dto.bankReference.trim(),transferredAt:new Date()}});
   if(changed.count!==1)fail('Concurrent transfer record; retry');
   await tx.driverSettlementAudit.create({data:{batchId:id,actorId:req.user.sub,action:'TRANSFER_RECORDED',evidence:dto.bankReference.trim()}});
   return {id,status:'TRANSFER_RECORDED',notice:'Operator-entered reference; independent bank confirmation still required'};
  },txOptions);
 }
 @Post('batches/:id/reconcile') async reconcile(@Param('id') id:string,@Req() req:any){
  return this.db.$transaction(async tx=>{
   const batch=await tx.driverSettlementBatch.findUnique({where:{id}});
   if(!batch||batch.status!=='TRANSFER_RECORDED'||!batch.bankReference)fail('Recorded transfer and independent bank verification required');
   if([batch.createdById,batch.approvedById].includes(req.user.sub))fail('Independent reconciler required');
   // Reconciler must confirm bank evidence externally before invoking this endpoint.
   const entries=await tx.driverEarning.findMany({where:{batchId:id,status:'RESERVED'}});
   if(!entries.length||entries.reduce((n,e)=>n+e.netPaise,0)!==batch.amountPaise)fail('Batch ledger mismatch');
   const changed=await tx.driverSettlementBatch.updateMany({where:{id,status:'TRANSFER_RECORDED'},data:{status:'RECONCILED',reconciledById:req.user.sub,reconciledAt:new Date()}});
   if(changed.count!==1)fail('Concurrent reconciliation; retry');
   const released=await tx.driverEarning.updateMany({where:{batchId:id,status:'RESERVED'},data:{status:'SETTLED'}});
   if(released.count!==entries.length)fail('Concurrent ledger update; retry');
   await tx.driverSettlementAudit.create({data:{batchId:id,actorId:req.user.sub,action:'RECONCILED',evidence:batch.bankReference}});
   return {id,status:'RECONCILED',notice:'Manual reconciliation attestation; no bank API verification performed'};
  },txOptions);
 }
}
