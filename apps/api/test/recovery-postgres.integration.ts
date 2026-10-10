/** Opt-in real PostgreSQL test. Run ONLY against a disposable database with migrations applied. */
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';

async function main() {
 if (process.env.RIDEFLOW_TEST_DATABASE_ISOLATED !== 'YES' || !process.env.DATABASE_URL || !/(_test|_ci)(\?|$)/.test(new URL(process.env.DATABASE_URL).pathname)) {
  throw new Error('Refusing to run: use an isolated *_test or *_ci database and RIDEFLOW_TEST_DATABASE_ISOLATED=YES');
 }
 const db = new PrismaClient();
 const suffix = `${Date.now()}_${process.pid}`;
 const ids = [`phase81_a_${suffix}`, `phase81_b_${suffix}`];
 const reference = `pi_phase81_${suffix}`;
 try {
  // Exercise actual unique index under simultaneous writes; no gateway requests or financial-state changes.
  const [a,b] = await Promise.allSettled(ids.map((id,i)=>db.rideTipPayment.create({data:{id,rideId:`phase81_ride_${i}_${suffix}`,tipIntentId:`phase81_intent_${i}_${suffix}`,customerId:`phase81_customer_${suffix}`,amountPaise:100,currency:'INR',idempotencyKey:`phase81_key_${i}_${suffix}`,provider:'STRIPE',providerPaymentId:reference}})));
  assert.equal([a,b].filter(x=>x.status==='fulfilled').length,1,'Exactly one concurrent claimant must succeed');
  assert.equal([a,b].filter(x=>x.status==='rejected').length,1,'Second claimant must fail unique constraint');
  const winner = await db.rideTipPayment.findFirst({where:{providerPaymentId:reference}});
  assert.ok(winner && ids.includes(winner.id));
  assert.equal(winner.status,'PREPARED');
  // Repeatable-read report sees one consistent snapshot despite a concurrent committed update.
  const proposalId=`phase81_proposal_${suffix}`;
  await db.tipRecoveryProposal.create({data:{id:proposalId,tipPaymentId:winner.id,proposedProvider:'STRIPE',proposedReference:reference,reason:'Isolated PostgreSQL concurrency test',proposedBy:'phase81_test'}});
  await db.$transaction(async tx=>{
   const before=await tx.tipRecoveryProposal.findUniqueOrThrow({where:{id:proposalId}});
   await db.tipRecoveryProposal.update({where:{id:proposalId},data:{status:'REJECTED'}});
   const after=await tx.tipRecoveryProposal.findUniqueOrThrow({where:{id:proposalId}});
   assert.equal(before.status,after.status,'Snapshot changed inside repeatable-read transaction');
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  console.log('PASS PostgreSQL unique reference race and repeatable-read snapshot');
 } finally {
  await db.tipRecoveryProposal.deleteMany({where:{id:{startsWith:`phase81_proposal_${suffix}`}}});
  await db.rideTipPayment.deleteMany({where:{id:{in:ids}}});
  await db.$disconnect();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
