import { createHmac } from 'node:crypto';

/** Provider-neutral adapter. The HTTPS bridge must be operated by a vetted telecom partner. */
export interface MaskedCallingProvider {
 provision(input:{rideId:string;customerPhone:string;driverPhone:string;expiresAt:Date;idempotencyKey:string}):Promise<{providerSessionId:string;relayNumber:string}>;
 revoke(providerSessionId:string):Promise<void>;
 verifyCallback(rawBody:Buffer,signature:string):Promise<{providerSessionId:string;status:'ACTIVE'|'ENDED'|'FAILED'}>;
}
export class UnconfiguredMaskedCallingProvider implements MaskedCallingProvider {
 async provision():Promise<never>{throw new Error('Masked calling provider not configured');}
 async revoke():Promise<never>{throw new Error('Masked calling provider not configured');}
 async verifyCallback():Promise<never>{throw new Error('Masked calling provider not configured');}
}
/** Explicit opt-in, HTTPS-only bridge with short timeouts and bounded responses. */
export class HttpsMaskedCallingProvider implements MaskedCallingProvider {
 private readonly endpoint:string;
 private readonly key:string;
 constructor(){
  const url=new URL(process.env.MASKED_CALL_PROVIDER_URL||'');
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Masked call bridge must use HTTPS');
  this.endpoint=url.toString().replace(/\/$/,'');
  this.key=process.env.MASKED_CALL_PROVIDER_KEY||'';
  if(this.key.length<32)throw new Error('Masked call bridge key missing');
 }
 private async request(path:string,payload:unknown):Promise<any>{
  const response=await fetch(this.endpoint+path,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+this.key},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Masked call bridge rejected request');
  if(Number(response.headers.get('content-length')||0)>8192)throw new Error('Masked call bridge response too large');
  const body=await response.text();
  if(body.length>8192)throw new Error('Masked call bridge response too large');
  return JSON.parse(body);
 }
 async verifyCallback():Promise<never>{throw new Error('Bridge callbacks require normalized HMAC webhook verification');}
 async provision(input:{rideId:string;customerPhone:string;driverPhone:string;expiresAt:Date;idempotencyKey:string}){
  const result=await this.request('/sessions',{...input,expiresAt:input.expiresAt.toISOString()});
  if(typeof result?.providerSessionId!=='string'||result.providerSessionId.length<3||result.providerSessionId.length>200||
   typeof result?.relayNumber!=='string'||!/^\+[1-9][0-9]{7,14}$/.test(result.relayNumber))throw new Error('Invalid relay provision response');
  return {providerSessionId:result.providerSessionId,relayNumber:result.relayNumber};
 }
 async revoke(providerSessionId:string):Promise<void>{
  const result=await this.request('/sessions/revoke',{providerSessionId});
  if(result?.revoked!==true)throw new Error('Provider did not confirm revocation');
 }
}
/** Stable across retries, opaque to the bridge, and scoped to one ride. */
export function maskedCallIdempotencyKey(rideId:string):string {
 const secret=process.env.MASKED_CALL_IDEMPOTENCY_SECRET||'';
 if(secret.length<32)throw new Error('Masked calling idempotency secret must be 32+ characters');
 return createHmac('sha256',secret).update('rideflow:masked-call:v1:'+rideId).digest('hex');
}
export function configuredMaskedCallingProvider():MaskedCallingProvider{
 return process.env.MASKED_CALL_PROVIDER_ENABLED==='true'?new HttpsMaskedCallingProvider():new UnconfiguredMaskedCallingProvider();
}
