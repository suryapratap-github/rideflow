import { encodeRecoveryCursor, decodeRecoveryCursor } from './recovery-report-cursor.mjs';
import { recoveryCsv } from './recovery-report-export.mjs';
import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Database } from './database';
import { Prisma } from '@prisma/client';
import { checkTipGateway } from './tip-gateway-check';
import { commitRecoveryReferenceBinding } from './tip-recovery-binding';
import { JwtAuthGuard, RolesGuard, Roles } from './security';

/** Admin investigation, recovery binding, and read-only audit exports. */
@Controller('admin/tip-investigations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminTipInvestigationController {
 constructor(private readonly db: Database) {}
 /** Bounded, admin-only recovery report. No raw gateway payloads or credential fields. */
 @Get('reports/recovery') async recoveryReport(@Query('limit') rawLimit?:string,@Query('cursor') cursor?:string,@Query('status') status?:string,@Query('provider') provider?:string,@Query('tipPaymentId') tipPaymentId?:string) {
  const limit=rawLimit===undefined?50:Number(rawLimit);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new BadRequestException('Limit must be 1–100');
  if(status && !['PENDING_REVIEW','APPROVED_FOR_MANUAL_REVIEW','REJECTED','BOUND'].includes(status))throw new BadRequestException('Invalid recovery status');
  if(provider && !['STRIPE','RAZORPAY'].includes(provider))throw new BadRequestException('Invalid provider');
  if(tipPaymentId && !/^[a-zA-Z0-9_-]{8,100}$/.test(tipPaymentId))throw new BadRequestException('Invalid payment ID');
  let position:{createdAt:Date;id:string}|undefined;
  try {if(cursor)position=decodeRecoveryCursor(cursor);}catch {throw new BadRequestException('Invalid recovery cursor');}
  const rows=await this.db.tipRecoveryProposal.findMany({
   where:{...(status?{status}:{}),...(provider?{proposedProvider:provider}:{}),...(tipPaymentId?{tipPaymentId}:{}),...(position?{OR:[{createdAt:{lt:position.createdAt}},{createdAt:position.createdAt,id:{lt:position.id}}]}:{})},
   orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit+1,
   select:{id:true,tipPaymentId:true,proposedProvider:true,proposedReference:true,status:true,proposedBy:true,reviewedBy:true,reviewedAt:true,createdAt:true}
  });
  const hasMore=rows.length>limit;
  const page=rows.slice(0,limit);
  return {rows:page,nextCursor:hasMore?encodeRecoveryCursor(page[page.length-1]):null,
   notice:'Administrative recovery audit only; no settlement, refund or payout evidence is implied.'};
 }

 /** Bounded export read in a PostgreSQL repeatable-read transaction; cutoff excludes newer proposals. */
 @Get('reports/recovery.csv') async recoveryExport(@Res({passthrough:true}) res:any,@Query('status') status?:string,@Query('provider') provider?:string,@Query('tipPaymentId') tipPaymentId?:string) {
  if(status&&!['PENDING_REVIEW','APPROVED_FOR_MANUAL_REVIEW','REJECTED','BOUND'].includes(status))throw new BadRequestException('Invalid recovery status');
  if(provider&&!['STRIPE','RAZORPAY'].includes(provider))throw new BadRequestException('Invalid provider');
  if(tipPaymentId&&!/^[a-zA-Z0-9_-]{8,100}$/.test(tipPaymentId))throw new BadRequestException('Invalid payment ID');
  const cutoff=new Date();
  const where={createdAt:{lte:cutoff},...(status?{status}:{}),...(provider?{proposedProvider:provider}:{}),...(tipPaymentId?{tipPaymentId}:{})};
  // Hard cap prevents unbounded memory consumption. Refuse truncation rather than silently omit audit rows.
  const rows=await this.db.$transaction(async tx=>tx.tipRecoveryProposal.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],take:10001,
   select:{id:true,tipPaymentId:true,proposedProvider:true,proposedReference:true,status:true,proposedBy:true,reviewedBy:true,reviewedAt:true,createdAt:true}}),{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  if(rows.length>10000)throw new BadRequestException('Export exceeds 10000 rows; narrow filters before exporting');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="rideflow-recovery-audit.csv"');
  res.setHeader('Cache-Control','no-store');
  return recoveryCsv(rows);
 }

 @Get(':id') async history(@Param('id') id:string) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw new BadRequestException('Invalid payment ID');
  const payment=await this.db.rideTipPayment.findUnique({where:{id},select:{id:true,rideId:true,status:true,provider:true,providerPaymentId:true}});
  if(!payment)return {payment:null,investigations:[]};
  const investigations=await this.db.tipInvestigation.findMany({where:{tipPaymentId:id},orderBy:{createdAt:'desc'},take:50,select:{id:true,actorId:true,reason:true,provider:true,reference:true,result:true,createdAt:true}});
  return {payment,investigations,notice:'Evidence only; no automatic binding, refund, settlement or payout'};
 }
 @Post(':id/check') async check(@Req() req:any,@Param('id') id:string,@Body() body:{reason?:string}) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw new BadRequestException('Invalid payment ID');
  const reason=typeof body?.reason==='string'?body.reason.trim():'';
  if(reason.length<12||reason.length>500)throw new BadRequestException('Investigation reason must be 12–500 characters');
  const payment=await this.db.rideTipPayment.findUnique({where:{id},select:{id:true,rideId:true,provider:true,providerPaymentId:true,amountPaise:true,currency:true,status:true}});
  if(!payment)throw new BadRequestException('Unknown tip payment');
  const evidence=await checkTipGateway(this.db,payment);
  // Only bounded, normalized evidence is persisted; never gateway credentials or raw provider payloads.
  const result=JSON.stringify({state:evidence.state,verified:evidence.verified,amountMatches:evidence.amountMatches,recommendation:evidence.recommendation,capturedPaymentMatched:'capturedPaymentMatched' in evidence?evidence.capturedPaymentMatched:null});
  const record=await this.db.tipInvestigation.create({data:{tipPaymentId:id,actorId:String(req.user?.sub||req.user?.id||'ADMIN'),reason,provider:payment.provider||'NONE',reference:payment.providerPaymentId,result}});
  return {investigationId:record.id,evidence,notice:'Recorded read-only evidence. Do not infer settlement or refund completion.'};
 }
 @Get(':id/proposals') async proposals(@Param('id') id:string) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw new BadRequestException('Invalid payment ID');
  return {proposals:await this.db.tipRecoveryProposal.findMany({where:{tipPaymentId:id},orderBy:{createdAt:'desc'},take:50}),notice:'Review-only proposals; no payment reference is changed'};
 }
 @Post(':id/proposals') async propose(@Req() req:any,@Param('id') id:string,@Body() body:{provider?:string;reference?:string;reason?:string}) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw new BadRequestException('Invalid payment ID');
  const reason=typeof body?.reason==='string'?body.reason.trim():'';
  const provider=body?.provider;
  const reference=typeof body?.reference==='string'?body.reference.trim():'';
  if(reason.length<12||reason.length>500)throw new BadRequestException('Reason must be 12–500 characters');
  if(!['STRIPE','RAZORPAY'].includes(provider||''))throw new BadRequestException('Unsupported provider');
  if(!/^[a-zA-Z0-9_-]{8,120}$/.test(reference))throw new BadRequestException('Invalid provider reference');
  const payment=await this.db.rideTipPayment.findUnique({where:{id}});
  if(!payment)throw new BadRequestException('Unknown tip payment');
  if(payment.providerPaymentId)throw new BadRequestException('Payment already has a gateway reference');
  const existing=await this.db.tipRecoveryProposal.findFirst({where:{tipPaymentId:id,status:'PENDING_REVIEW'}});
  if(existing)throw new BadRequestException('A proposal is already pending review');
  const proposal=await this.db.tipRecoveryProposal.create({data:{tipPaymentId:id,proposedProvider:provider!,proposedReference:reference,reason,proposedBy:String(req.user?.sub||req.user?.id||'ADMIN')}});
  return {proposal,notice:'Proposal recorded. No gateway reference was changed.'};
 }
 @Post('proposals/:proposalId/verify') async verifyProposal(@Req() req:any,@Param('proposalId') proposalId:string,@Body() body:{reason?:string}) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(proposalId))throw new BadRequestException('Invalid proposal ID');
  const reason=typeof body?.reason==='string'?body.reason.trim():'';
  if(reason.length<12||reason.length>500)throw new BadRequestException('Verification reason must be 12–500 characters');
  const proposal=await this.db.tipRecoveryProposal.findUnique({where:{id:proposalId}});
  if(!proposal||!['PENDING_REVIEW','APPROVED_FOR_MANUAL_REVIEW'].includes(proposal.status))throw new BadRequestException('Proposal cannot be verified');
  const payment=await this.db.rideTipPayment.findUnique({where:{id:proposal.tipPaymentId}});
  if(!payment||payment.providerPaymentId)throw new BadRequestException('Payment is missing or already bound');
  const conflict=await this.db.rideTipPayment.findFirst({where:{providerPaymentId:proposal.proposedReference},select:{id:true}});
  const otherProposal=await this.db.tipRecoveryProposal.findFirst({where:{proposedProvider:proposal.proposedProvider,proposedReference:proposal.proposedReference,status:{in:['PENDING_REVIEW','APPROVED_FOR_MANUAL_REVIEW']},NOT:{id:proposal.id}},select:{id:true}});
  // Provider-side lookup checks reference, ride metadata, amount and currency. Never trust a submitted reference alone.
  const evidence=conflict||otherProposal?null:await checkTipGateway(this.db,{id:payment.id,rideId:payment.rideId,provider:proposal.proposedProvider,providerPaymentId:proposal.proposedReference,amountPaise:payment.amountPaise,currency:payment.currency});
  const safe={verified:!!evidence?.verified,amountMatches:evidence?.amountMatches===true,capturedPaymentMatched:!!(evidence&&'capturedPaymentMatched' in evidence&&evidence.capturedPaymentMatched===true),state:conflict?'ALREADY_BOUND':otherProposal?'DUPLICATE_PROPOSAL':evidence?.state||'UNAVAILABLE',conflict:!!conflict,duplicateProposal:!!otherProposal};
  const record=await this.db.tipInvestigation.create({data:{tipPaymentId:payment.id,actorId:String(req.user?.sub||req.user?.id||'ADMIN'),reason,provider:proposal.proposedProvider,reference:proposal.proposedReference,result:JSON.stringify({kind:'RECOVERY_PROPOSAL_VERIFICATION',proposalId:proposal.id,...safe})}});
  return {investigationId:record.id,proposalId:proposal.id,evidence:safe,eligibleForFurtherReview:safe.verified&&safe.amountMatches&&safe.capturedPaymentMatched&&!safe.conflict&&!safe.duplicateProposal,notice:'Evidence only. No gateway reference, ledger status, refund or payout was changed.'};
 }
 @Post('proposals/:proposalId/review') async review(@Req() req:any,@Param('proposalId') proposalId:string,@Body() body:{decision?:string;reason?:string}) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(proposalId))throw new BadRequestException('Invalid proposal ID');
  if(!['APPROVED_FOR_MANUAL_REVIEW','REJECTED'].includes(body?.decision||''))throw new BadRequestException('Invalid decision');
  const reason=typeof body?.reason==='string'?body.reason.trim():'';
  if(reason.length<12||reason.length>500)throw new BadRequestException('Review reason must be 12–500 characters');
  const actor=String(req.user?.sub||req.user?.id||'ADMIN');
  const proposal=await this.db.tipRecoveryProposal.findUnique({where:{id:proposalId}});
  if(!proposal||proposal.status!=='PENDING_REVIEW')throw new BadRequestException('Proposal not pending');
  if(proposal.proposedBy===actor)throw new BadRequestException('Second administrator required');
  // Approval requires fresh independent evidence, not an earlier screenshot or cached audit entry.
  if(body.decision==='APPROVED_FOR_MANUAL_REVIEW') {
   const payment=await this.db.rideTipPayment.findUnique({where:{id:proposal.tipPaymentId}});
   if(!payment||payment.providerPaymentId)throw new BadRequestException('Payment is missing or already bound');
   const conflict=await this.db.rideTipPayment.findFirst({where:{providerPaymentId:proposal.proposedReference},select:{id:true}});
   const duplicate=await this.db.tipRecoveryProposal.findFirst({where:{proposedProvider:proposal.proposedProvider,proposedReference:proposal.proposedReference,status:{in:['PENDING_REVIEW','APPROVED_FOR_MANUAL_REVIEW']},NOT:{id:proposal.id}},select:{id:true}});
   if(conflict||duplicate)throw new BadRequestException('Reference conflict or duplicate proposal');
   const evidence=await checkTipGateway(this.db,{id:payment.id,rideId:payment.rideId,provider:proposal.proposedProvider,providerPaymentId:proposal.proposedReference,amountPaise:payment.amountPaise,currency:payment.currency});
   const eligible=evidence.verified===true&&evidence.amountMatches===true&&'capturedPaymentMatched' in evidence&&evidence.capturedPaymentMatched===true;
   await this.db.tipInvestigation.create({data:{tipPaymentId:payment.id,actorId:actor,reason,provider:proposal.proposedProvider,reference:proposal.proposedReference,result:JSON.stringify({kind:'APPROVAL_GATEWAY_RECHECK',proposalId:proposal.id,eligible,state:evidence.state})}});
   if(!eligible)throw new BadRequestException('Fresh provider evidence does not support approval');
  }
  const result=await this.db.tipRecoveryProposal.updateMany({where:{id:proposalId,status:'PENDING_REVIEW'},data:{status:body.decision,reviewReason:reason,reviewedBy:actor,reviewedAt:new Date()}});
  if(result.count!==1)throw new BadRequestException('Proposal already reviewed');
  return {status:body.decision,notice:'Review recorded only. Gateway reference remains unchanged.'};
 }


 /** Bind only the gateway reference, never the financial status. A third administrator executes an independently approved recovery. */
 @Post('proposals/:proposalId/bind') async bindApproved(@Req() req:any,@Param('proposalId') proposalId:string,@Body() body:{reason?:string}) {
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(proposalId))throw new BadRequestException('Invalid proposal ID');
  const reason=typeof body?.reason==='string'?body.reason.trim():'';
  if(reason.length<12||reason.length>500)throw new BadRequestException('Binding reason must be 12–500 characters');
  const actor=String(req.user?.sub||req.user?.id||'');
  if(!actor)throw new BadRequestException('Administrator identity required');
  const proposal=await this.db.tipRecoveryProposal.findUnique({where:{id:proposalId}});
  if(!proposal||proposal.status!=='APPROVED_FOR_MANUAL_REVIEW'||!proposal.reviewedBy||proposal.proposedBy===actor||proposal.reviewedBy===actor||proposal.reviewedBy===proposal.proposedBy)throw new BadRequestException('Independent approval and third administrator required');
  const payment=await this.db.rideTipPayment.findUnique({where:{id:proposal.tipPaymentId}});
  if(!payment||payment.providerPaymentId||payment.provider||payment.status!=='PREPARED')throw new BadRequestException('Tip is not eligible for reference recovery');
  const evidence=await checkTipGateway(this.db,{id:payment.id,rideId:payment.rideId,provider:proposal.proposedProvider,providerPaymentId:proposal.proposedReference,amountPaise:payment.amountPaise,currency:payment.currency});
  if(evidence.verified!==true||evidence.amountMatches!==true||!('capturedPaymentMatched' in evidence&&evidence.capturedPaymentMatched===true))throw new BadRequestException('Fresh captured-payment evidence is insufficient');
  try {
   return await commitRecoveryReferenceBinding(this.db,{proposalId,proposal,tipPaymentId:payment.id,actor,reason,providerState:evidence.state});
  }catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError && ['P2002','P2034'].includes(error.code))throw new BadRequestException('Concurrent or duplicate gateway reference; retry investigation');throw error;}
 }

}
