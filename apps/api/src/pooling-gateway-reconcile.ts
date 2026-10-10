import { Database } from './database';
import { providerConfig } from './payment-credentials';
/** Read-only provider checks. No local payment state is changed. */
export type GatewayCheck={rideId:string;provider:'STRIPE'|'RAZORPAY'|'NONE';state:string;verified:boolean;amountMatches:boolean|null;details?:string};
export async function checkPoolGateway(db:Database,p:{rideId:string;amountPaise:number;stripeIntentId:string|null;providerPaymentId:string|null;providerOrderId:string|null}):Promise<GatewayCheck>{
 const base={rideId:p.rideId,verified:false,amountMatches:null};
 try{
  if(p.stripeIntentId){
   const stripeConfig=await providerConfig(db,'STRIPE');if(!stripeConfig.STRIPE_SECRET_KEY)return {...base,provider:'STRIPE',state:'NOT_CONFIGURED'};
   const response=await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(p.stripeIntentId)}`,{headers:{Authorization:`Bearer ${stripeConfig.STRIPE_SECRET_KEY}`},signal:AbortSignal.timeout(8000)});
   if(!response.ok)return {...base,provider:'STRIPE',state:'FETCH_FAILED',details:`HTTP ${response.status}`};
   const intent=await response.json() as {id?:string;amount?:number;currency?:string;status?:string};
   const valid=intent.id===p.stripeIntentId&&intent.currency==='inr'&&Number.isInteger(intent.amount);
   return {...base,provider:'STRIPE',state:valid?String(intent.status||'UNKNOWN'):'INVALID_RESPONSE',verified:valid,amountMatches:valid?intent.amount===p.amountPaise:null};
  }
  if(p.providerPaymentId||p.providerOrderId){
   const razorConfig=await providerConfig(db,'RAZORPAY');if(!razorConfig.RAZORPAY_KEY_ID||!razorConfig.RAZORPAY_KEY_SECRET)return {...base,provider:'RAZORPAY',state:'NOT_CONFIGURED'};
   // Order lookup alone cannot establish that a payment was captured; require a payment ID.
   if(!p.providerPaymentId)return {...base,provider:'RAZORPAY',state:'PAYMENT_ID_MISSING'};
   const auth=Buffer.from(`${razorConfig.RAZORPAY_KEY_ID}:${razorConfig.RAZORPAY_KEY_SECRET}`).toString('base64');
   const response=await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(p.providerPaymentId)}`,{headers:{Authorization:`Basic ${auth}`},signal:AbortSignal.timeout(8000)});
   if(!response.ok)return {...base,provider:'RAZORPAY',state:'FETCH_FAILED',details:`HTTP ${response.status}`};
   const payment=await response.json() as {id?:string;order_id?:string;amount?:number;currency?:string;status?:string};
   const valid=payment.id===p.providerPaymentId&&payment.order_id===p.providerOrderId&&payment.currency==='INR'&&Number.isInteger(payment.amount);
   return {...base,provider:'RAZORPAY',state:valid?String(payment.status||'UNKNOWN'):'INVALID_RESPONSE',verified:valid,amountMatches:valid?payment.amount===p.amountPaise:null};
  }
  return {...base,provider:'NONE',state:'NO_GATEWAY_REFERENCE'};
 }catch{return {...base,provider:p.stripeIntentId?'STRIPE':'RAZORPAY',state:'UNAVAILABLE'};}
}
