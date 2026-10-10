import { Database } from './database';
import { providerConfig } from './payment-credentials';

/** Independent, read-only provider evidence. Never changes local financial state. */
export async function checkTipGateway(db:Database, tip:{id:string;rideId:string;provider:string|null;providerPaymentId:string|null;amountPaise:number;currency:string}) {
 const base={provider:tip.provider||'NONE',reference:tip.providerPaymentId||null,verified:false,amountMatches:null as boolean|null,state:'NO_GATEWAY_REFERENCE',recommendation:'MANUAL_REVIEW'};
 if(!tip.providerPaymentId || !['STRIPE','RAZORPAY'].includes(tip.provider||''))return base;
 try {
  if(tip.provider==='STRIPE') {
   if(!/^pi_[a-zA-Z0-9]+$/.test(tip.providerPaymentId))return {...base,state:'INVALID_REFERENCE'};
   const cfg=await providerConfig(db,'STRIPE');if(!cfg.STRIPE_SECRET_KEY)return {...base,state:'NOT_CONFIGURED'};
   const r=await fetch('https://api.stripe.com/v1/payment_intents/'+encodeURIComponent(tip.providerPaymentId),{headers:{Authorization:'Bearer '+cfg.STRIPE_SECRET_KEY},signal:AbortSignal.timeout(8000)});
   if(!r.ok)return {...base,state:'FETCH_FAILED',httpStatus:r.status};
   const p=await r.json() as {id?:string;amount?:number;amount_received?:number;currency?:string;status?:string;metadata?:{rideId?:string;tipPaymentId?:string};latest_charge?:string};
   const valid=p.id===tip.providerPaymentId && p.currency===tip.currency.toLowerCase() && p.metadata?.rideId===tip.rideId && p.metadata?.tipPaymentId===tip.id && Number.isSafeInteger(p.amount);
   if(!valid)return {...base,state:'MISMATCH',amountMatches:false};
   const captured=p.status==='succeeded' && p.amount_received===tip.amountPaise && p.amount===tip.amountPaise;
   // Refund data is provider evidence, not authorization to mutate ledger state.
   let refunds:{id:string;amount:number;status:string}[]=[];
   if(typeof p.latest_charge==='string' && /^ch_[a-zA-Z0-9]+$/.test(p.latest_charge)) {
    const rr=await fetch('https://api.stripe.com/v1/refunds?charge='+encodeURIComponent(p.latest_charge)+'&limit=25',{headers:{Authorization:'Bearer '+cfg.STRIPE_SECRET_KEY},signal:AbortSignal.timeout(8000)});
    if(rr.ok){const data=await rr.json() as {data?:{id?:string;amount?:number;status?:string}[]};refunds=(data.data||[]).filter(x=>typeof x.id==='string'&&Number.isSafeInteger(x.amount)).map(x=>({id:x.id!,amount:x.amount!,status:String(x.status||'unknown')}));}
   }
   return {...base,verified:true,amountMatches:p.amount===tip.amountPaise,state:String(p.status||'UNKNOWN'),capturedPaymentMatched:captured,refunds,refundEvidenceComplete:typeof p.latest_charge==='string',recommendation:captured?'CAPTURE_MATCHED_REVIEW_REFUNDS':'MANUAL_REVIEW'};
  }
  if(!/^order_[a-zA-Z0-9]+$/.test(tip.providerPaymentId))return {...base,state:'INVALID_REFERENCE'};
  const cfg=await providerConfig(db,'RAZORPAY');if(!cfg.RAZORPAY_KEY_ID||!cfg.RAZORPAY_KEY_SECRET)return {...base,state:'NOT_CONFIGURED'};
  const auth=Buffer.from(cfg.RAZORPAY_KEY_ID+':'+cfg.RAZORPAY_KEY_SECRET).toString('base64');
  const r=await fetch('https://api.razorpay.com/v1/orders/'+encodeURIComponent(tip.providerPaymentId),{headers:{Authorization:'Basic '+auth},signal:AbortSignal.timeout(8000)});
  if(!r.ok)return {...base,state:'FETCH_FAILED',httpStatus:r.status};
  const p=await r.json() as {id?:string;amount?:number;currency?:string;status?:string;notes?:{rideId?:string;tipPaymentId?:string};amount_paid?:number};
  const valid=p.id===tip.providerPaymentId&&p.currency===tip.currency&&p.notes?.rideId===tip.rideId&&p.notes?.tipPaymentId===tip.id&&Number.isSafeInteger(p.amount);
  if(!valid)return {...base,state:'MISMATCH',amountMatches:false};
  // An order is not a captured payment: independently inspect individual payments.
  const pr=await fetch('https://api.razorpay.com/v1/orders/'+encodeURIComponent(tip.providerPaymentId)+'/payments',{headers:{Authorization:'Basic '+auth},signal:AbortSignal.timeout(8000)});
  if(!pr.ok)return {...base,verified:true,amountMatches:p.amount===tip.amountPaise,state:'PAYMENTS_LOOKUP_FAILED',capturedPaymentMatched:false};
  const data=await pr.json() as {items?:{id?:string;order_id?:string;amount?:number;currency?:string;status?:string;amount_refunded?:number}[]};
  const items=Array.isArray(data.items)?data.items:[];
  const captured=items.filter(x=>x.order_id===tip.providerPaymentId&&x.currency===tip.currency&&x.status==='captured'&&Number.isSafeInteger(x.amount));
  const exact=captured.length===1&&captured[0].amount===tip.amountPaise&&p.amount===tip.amountPaise;
  return {...base,verified:true,amountMatches:p.amount===tip.amountPaise,state:String(p.status||'UNKNOWN'),capturedPaymentMatched:exact,capturedPayments:captured.map(x=>({id:x.id,amount:x.amount,amountRefunded:x.amount_refunded||0})),recommendation:exact?'CAPTURE_MATCHED_REVIEW_REFUNDS':'MANUAL_REVIEW',orderAmountPaidPaise:Number.isSafeInteger(p.amount_paid)?p.amount_paid:null};
 } catch {return {...base,state:'UNAVAILABLE'};}
}
