import { PoolStop } from './pooling-route';

/** Fail-closed road-routing preview. No driver assignment or fare changes. */
export type RoadLeg = { distanceKm:number; durationMinutes:number };
export type RoadRoute = { distanceKm:number; durationMinutes:number };
export type RoadRouter = (stops:PoolStop[])=>Promise<RoadRoute>;
const finitePositive=(n:number)=>Number.isFinite(n)&&n>=0;
export function evaluatePoolDetours(stops:PoolStop[], pooled:RoadRoute, directByRide:Record<string,RoadRoute>, maxDetourPercent=25){
 if(stops.length!==4||new Set(stops.map(s=>s.rideId)).size!==2)throw new Error('Exactly two passenger journeys required');
 if(!finitePositive(pooled.distanceKm)||!finitePositive(pooled.durationMinutes))throw new Error('Invalid pooled route');
 if(!Number.isFinite(maxDetourPercent)||maxDetourPercent<0||maxDetourPercent>100)throw new Error('Invalid detour limit');
 const rides=[...new Set(stops.map(s=>s.rideId))];
 const results=rides.map(id=>{
  const pickup=stops.findIndex(s=>s.rideId===id&&s.kind==='PICKUP');
  const dropoff=stops.findIndex(s=>s.rideId===id&&s.kind==='DROPOFF');
  if(pickup<0||dropoff<=pickup)throw new Error('Invalid pickup/dropoff order');
  const direct=directByRide[id];
  if(!direct||!finitePositive(direct.durationMinutes)||direct.durationMinutes<=0)throw new Error('Invalid direct route');
  return {rideId:id,directMinutes:direct.durationMinutes,maximumAllowedMinutes:direct.durationMinutes*(1+maxDetourPercent/100)};
 });
 return {rides:results,maxDetourPercent};
}
export async function fetchOsrmRoute(stops:PoolStop[],baseUrl:string):Promise<RoadRoute>{
 const base=new URL(baseUrl);
 if(!['https:','http:'].includes(base.protocol)||base.username||base.password)throw new Error('Invalid routing server URL');
 if(stops.length<2||stops.some(s=>!Number.isFinite(s.latitude)||!Number.isFinite(s.longitude)||Math.abs(s.latitude)>90||Math.abs(s.longitude)>180))throw new Error('Invalid routing coordinates');
 const coordinates=stops.map(s=>`${s.longitude},${s.latitude}`).join(';');
 const url=new URL(`route/v1/driving/${coordinates}`,base.href.endsWith('/')?base.href:base.href+'/');
 url.searchParams.set('overview','false');
 const response=await fetch(url,{signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error('Road router unavailable');
 const body=await response.json() as {code?:string;routes?:{distance:number;duration:number;legs?:{duration:number}[]}[]};
 const route=body.routes?.[0];
 if(body.code!=='Ok'||!route||!finitePositive(route.distance)||!finitePositive(route.duration))throw new Error('Road route unavailable');
 return {distanceKm:route.distance/1000,durationMinutes:route.duration/60};
}
/** Compare in-vehicle travel time for each passenger with their own road-based direct route. */
export async function validateRoadPool(stops:PoolStop[],router:RoadRouter,maxDetourPercent=25){
 const ids=[...new Set(stops.map(s=>s.rideId))];
 if(stops.length!==4||ids.length!==2)throw new Error('Exactly two rides required');
 const directByRide:Record<string,RoadRoute>={};
 for(const id of ids){
  const pickup=stops.find(s=>s.rideId===id&&s.kind==='PICKUP');
  const dropoff=stops.find(s=>s.rideId===id&&s.kind==='DROPOFF');
  if(!pickup||!dropoff||stops.indexOf(dropoff)<=stops.indexOf(pickup))throw new Error('Pickup must precede drop-off');
  directByRide[id]=await router([pickup,dropoff]);
 }
 const pooled=await router(stops);
 const limits=evaluatePoolDetours(stops,pooled,directByRide,maxDetourPercent);
 const rides=[];
 for(const limit of limits.rides){
  const pickup=stops.findIndex(s=>s.rideId===limit.rideId&&s.kind==='PICKUP');
  const dropoff=stops.findIndex(s=>s.rideId===limit.rideId&&s.kind==='DROPOFF');
  const passengerRoute=await router(stops.slice(pickup,dropoff+1));
  const detourPercent=(passengerRoute.durationMinutes/limit.directMinutes-1)*100;
  rides.push({...limit,pooledMinutes:passengerRoute.durationMinutes,detourPercent,withinLimit:detourPercent<=maxDetourPercent+1e-6});
 }
 return {roadBased:true,dispatchReady:false,withinDetourLimits:rides.every(r=>r.withinLimit),maxDetourPercent,pooled,riders:rides};
}
