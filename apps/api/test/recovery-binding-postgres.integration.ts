/** Opt-in integration test of the SAME database commit used by the admin binding endpoint.
 * Does not contact payment providers: only transaction semantics are under test.
 */
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { commitRecoveryReferenceBinding } from '../src/tip-recovery-binding';

async function main() {
 const url=process.env.DATABASE_URL;
 if(process.env.RIDEFLOW_TEST_DATABASE_ISOLATED!=='YES'||!url)throw new Error('Refusing non-isolated PostgreSQL database');
 const parsed=new URL(url);
 if(!['postgresql:','postgres:'].includes(parsed.protocol)||!/(?:_test|_ci)$/.test(decodeURIComponent(parsed.pathname).replace(/^\//,'')))throw new Error('Database must be PostgreSQL and have a _test or _ci database name');
 const db=new PrismaClient();
 const suffix=`p82_${Date.now()}_${process.pid}`;
 const tips=[`${suffix}_tip_a`,`${suffix}_tip_b`,`${suffix}_tip_c`];
 const proposals=[`${suffix}_proposal_a`,`${suffix}_proposal_b`,`${suffix}_proposal_c`];
 const reference=`pi_${suffix}_shared`;
 const args=(i:number)=>({proposalId:proposals[i],proposal:{proposedProvider:'STRIPE',proposedReference:i===2?`pi_${suffix}_rollback`:reference,proposedBy:'admin_proposer',reviewedBy:'admin_reviewer'},tipPaymentId:tips[i],actor:'admin_binder',reason:'Isolated transaction integration test',providerState:'CAPTURED'});
 try {
  for(let i=0;i<3;i++){
   await db.rideTipPayment.create({data:{id:tips[i],rideId:`${suffix}_ride_${i}`,tipIntentId:`${suffix}_intent_${i}`,customerId:`${suffix}_customer`,amountPaise:100,currency:'INR',idempotencyKey:`${suffix}_key_${i}`,status:'PREPARED'}});
   await db.tipRecoveryProposal.create({data:{id:proposals[i],tipPaymentId:tips[i],proposedProvider:'STRIPE',proposedReference:i===2?`pi_${suffix}_rollback`:reference,reason:'Isolated database recovery test',proposedBy:'admin_proposer',reviewedBy:'admin_reviewer',status:'APPROVED_FOR_MANUAL_REVIEW'}});
  }
  // Both proposals claim the same provider reference; neither may bind while the other is active.
  const race=await Promise.allSettled([commitRecoveryReferenceBinding(db,args(0)),commitRecoveryReferenceBinding(db,args(1))]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,0,'Conflicting active proposals must block both binds');
  for(let i=0;i<2;i++)assert.equal((await db.rideTipPayment.findUniqueOrThrow({where:{id:tips[i]}})).providerPaymentId,null);
  await db.tipRecoveryProposal.update({where:{id:proposals[1]},data:{status:'REJECTED'}});
  // Two administrators racing to bind the SAME approved proposal: exactly one can commit.
  const same=await Promise.allSettled([commitRecoveryReferenceBinding(db,args(0)),commitRecoveryReferenceBinding(db,args(0))]);
  assert.equal(same.filter(r=>r.status==='fulfilled').length,1,'Exactly one binding must succeed');
  assert.equal((await db.rideTipPayment.findUniqueOrThrow({where:{id:tips[0]}})).status,'PREPARED');
  assert.equal((await db.tipRecoveryProposal.findUniqueOrThrow({where:{id:proposals[0]}})).status,'BOUND');
  assert.equal(await db.tipInvestigation.count({where:{tipPaymentId:tips[0],result:{contains:'RECOVERY_REFERENCE_BOUND'}}}),1);
  // Force an audit-write failure AFTER the payment and proposal updates; both must roll back.
  const auditFailureDb={ $transaction:(fn:any,opts:any)=>db.$transaction(async tx=>fn(new Proxy(tx,{get(target,prop){if(prop==='tipInvestigation')return {create:async()=>{throw new Error('INJECTED_AUDIT_FAILURE');}};return (target as any)[prop];}})),opts)};
  await assert.rejects(commitRecoveryReferenceBinding(auditFailureDb,args(2)),/INJECTED_AUDIT_FAILURE/);
  assert.equal((await db.rideTipPayment.findUniqueOrThrow({where:{id:tips[2]}})).providerPaymentId,null,'Tip binding must roll back');
  assert.equal((await db.tipRecoveryProposal.findUniqueOrThrow({where:{id:proposals[2]}})).status,'APPROVED_FOR_MANUAL_REVIEW','Proposal must roll back');
  assert.equal(await db.tipInvestigation.count({where:{tipPaymentId:tips[2]}}),0,'No partial audit');
  console.log('PASS PostgreSQL real binding transaction: duplicate claims, same-proposal race, audit rollback');
 }finally{
  await db.tipInvestigation.deleteMany({where:{tipPaymentId:{in:tips}}});
  await db.tipRecoveryProposal.deleteMany({where:{id:{in:proposals}}});
  await db.rideTipPayment.deleteMany({where:{id:{in:tips}}});
  await db.$disconnect();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
