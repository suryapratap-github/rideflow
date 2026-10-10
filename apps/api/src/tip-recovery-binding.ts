import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Database-only commit, shared by the authenticated controller and isolated PostgreSQL tests.
 * Caller MUST verify live gateway evidence and enforce three distinct admins first.
 * Never expose this function as an endpoint or call it without provider verification.
 */
export async function commitRecoveryReferenceBinding(db:any,args:{proposalId:string;proposal:{proposedProvider:string;proposedReference:string;proposedBy:string;reviewedBy:string|null};tipPaymentId:string;actor:string;reason:string;providerState:string}) {
 const {proposalId,proposal,tipPaymentId,actor,reason,providerState}=args;
 if(!proposal.reviewedBy||new Set([actor,proposal.proposedBy,proposal.reviewedBy]).size!==3)throw new BadRequestException('Three independent administrators required');
 return db.$transaction(async (tx:any)=>{
  const current=await tx.tipRecoveryProposal.findUnique({where:{id:proposalId}});
  if(!current||current.status!=='APPROVED_FOR_MANUAL_REVIEW'||current.tipPaymentId!==tipPaymentId||current.proposedReference!==proposal.proposedReference||current.proposedProvider!==proposal.proposedProvider||current.proposedBy!==proposal.proposedBy||current.reviewedBy!==proposal.reviewedBy)throw new BadRequestException('Proposal changed');
  const conflict=await tx.rideTipPayment.findFirst({where:{providerPaymentId:proposal.proposedReference},select:{id:true}});
  const duplicate=await tx.tipRecoveryProposal.findFirst({where:{id:{not:proposalId},proposedProvider:proposal.proposedProvider,proposedReference:proposal.proposedReference,status:{in:['PENDING_REVIEW','APPROVED_FOR_MANUAL_REVIEW','BOUND']}},select:{id:true}});
  if(conflict||duplicate)throw new BadRequestException('Gateway reference already claimed');
  const updated=await tx.rideTipPayment.updateMany({where:{id:tipPaymentId,status:'PREPARED',provider:null,providerPaymentId:null},data:{provider:proposal.proposedProvider,providerPaymentId:proposal.proposedReference}});
  if(updated.count!==1)throw new BadRequestException('Tip changed during binding');
  const finalized=await tx.tipRecoveryProposal.updateMany({where:{id:proposalId,status:'APPROVED_FOR_MANUAL_REVIEW'},data:{status:'BOUND'}});
  if(finalized.count!==1)throw new BadRequestException('Proposal already processed');
  const audit=await tx.tipInvestigation.create({data:{tipPaymentId,actorId:actor,reason,provider:proposal.proposedProvider,reference:proposal.proposedReference,result:JSON.stringify({kind:'RECOVERY_REFERENCE_BOUND',proposalId,providerState,capturedPaymentMatched:true,financialStatusUnchanged:true})}});
  return {status:'BOUND',investigationId:audit.id,notice:'Gateway reference bound only. Financial status remains PREPARED; no settlement, refund or payout.'};
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
