import { Controller, Get, Param, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { Database } from './database';
import { checkTipGateway } from './tip-gateway-check';
import { JwtAuthGuard, RolesGuard, Roles } from './security';

/** Read-only investigation. Never infer a refund or payout from a local webhook alone. */
@Controller('admin/tip-reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminTipReconciliationController {
 constructor(private readonly db: Database) {}
 @Get('queue') async queue(@Query('status') status?: string) {
  const allowed = ['PREPARED','AWAITING_PAYMENT','CAPTURE_REPORTED','REFUND_REPORTED'];
  if(status && !allowed.includes(status)) throw new BadRequestException('Invalid status');
  const payments = await this.db.rideTipPayment.findMany({where: status ? {status} : {status:{in:allowed}},orderBy:{updatedAt:'asc'},take:100,select:{id:true,rideId:true,amountPaise:true,currency:true,status:true,provider:true,providerPaymentId:true,preparedAt:true,verifiedAt:true,updatedAt:true}});
  return {payments,notice:'Investigation only. Provider dashboard reconciliation is required before settlement or refund confirmation.'};
 }
 @Get(':id/gateway-check') async gatewayCheck(@Param('id') id:string) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new BadRequestException('Invalid payment ID');
  const tip=await this.db.rideTipPayment.findUnique({where:{id},select:{id:true,rideId:true,provider:true,providerPaymentId:true,amountPaise:true,currency:true}});
  if(!tip)return {payment:null,check:null};
  return {paymentId:tip.id,check:await checkTipGateway(this.db,tip),notice:'Read-only provider lookup. Never use this result alone to release funds, confirm refunds, or change payment state.'};
 }
 @Get(':id') async detail(@Param('id') id:string) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new BadRequestException('Invalid payment ID');
  const payment = await this.db.rideTipPayment.findUnique({where:{id},select:{id:true,rideId:true,amountPaise:true,currency:true,status:true,provider:true,providerPaymentId:true,preparedAt:true,verifiedAt:true,updatedAt:true}});
  if(!payment) return {payment:null,events:[]};
  const events = payment.providerPaymentId ? await this.db.paymentWebhookEvent.findMany({where:{providerPaymentId:payment.providerPaymentId},orderBy:{receivedAt:'desc'},take:100}) : [];
  return {payment,events,notice:'Event history is informational; no automatic refunds or payouts.'};
 }
}
