import { km } from './pooling-matcher';
export type PoolStopRide={id:string;pickup:string;dropoff:string;pickupLatitude:number|null;pickupLongitude:number|null;dropoffLatitude:number|null;dropoffLongitude:number|null;poolSeats:number;poolConsentAt:Date|null};
export type PoolStop={rideId:string;kind:'PICKUP'|'DROPOFF';address:string;latitude:number;longitude:number};
/** Planning preview only. Actual dispatch requires road-based routing, driver allocation and individual OTP checks. */
export function buildPoolStopPreview(rides:PoolStopRide[]):PoolStop[]{
 if(rides.length!==2||rides.some(r=>!r.poolConsentAt||!Number.isInteger(r.poolSeats)||r.poolSeats<1))throw new Error('Two consenting rides required');
 const stops:PoolStop[]=rides.flatMap(r=>[
  {rideId:r.id,kind:'PICKUP' as const,address:r.pickup,latitude:r.pickupLatitude!,longitude:r.pickupLongitude!},
  {rideId:r.id,kind:'DROPOFF' as const,address:r.dropoff,latitude:r.dropoffLatitude!,longitude:r.dropoffLongitude!}
 ]);
 if(stops.some(s=>!Number.isFinite(s.latitude)||!Number.isFinite(s.longitude)||Math.abs(s.latitude)>90||Math.abs(s.longitude)>180))throw new Error('Valid coordinates required');
 // Pick a deterministic first pickup, then minimize straight-line travel while respecting pickup-before-dropoff.
 const first=stops.filter(s=>s.kind==='PICKUP').sort((a,b)=>a.rideId.localeCompare(b.rideId))[0];
 const ordered=[first];const remaining=stops.filter(s=>s!==first);
 while(remaining.length){
  const current=ordered[ordered.length-1];
  const available=remaining.filter(s=>s.kind==='PICKUP'||ordered.some(x=>x.rideId===s.rideId&&x.kind==='PICKUP'));
  available.sort((a,b)=>km(current,a)-km(current,b)||a.rideId.localeCompare(b.rideId));
  const next=available[0];ordered.push(next);remaining.splice(remaining.indexOf(next),1);
 }
 return ordered;
}
