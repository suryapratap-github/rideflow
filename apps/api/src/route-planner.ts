import { haversineKm } from './geo';

type Point={latitude:number;longitude:number};
export type PickupRoute={source:'road'|'straight_line';distanceKm:number;etaMinutes:number|null;coordinates:[number,number][];disclaimer:string};
/** OSRM URL is opt-in. Use your own managed routing service for production. */
export async function pickupRoute(driver:Point,pickup:Point):Promise<PickupRoute>{
 const straight=haversineKm(driver.latitude,driver.longitude,pickup.latitude,pickup.longitude);
 const fallback:PickupRoute={source:'straight_line',distanceKm:Number(straight.toFixed(2)),etaMinutes:null,coordinates:[[driver.latitude,driver.longitude],[pickup.latitude,pickup.longitude]],disclaimer:'Straight-line distance only; road distance and ETA unavailable'};
 const base=process.env.ROUTING_BASE_URL?.trim();
 if(!base)return fallback;
 try{
  const origin=`${driver.longitude},${driver.latitude}`;
  const destination=`${pickup.longitude},${pickup.latitude}`;
  const url=`${base.replace(/\/$/,'')}/route/v1/driving/${origin};${destination}?overview=full&geometries=geojson`;
  const response=await fetch(url,{signal:AbortSignal.timeout(3500),headers:{'Accept':'application/json'}});
  if(!response.ok)return fallback;
  const body:any=await response.json();const route=body?.routes?.[0];
  const coords=route?.geometry?.coordinates;
  if(!Number.isFinite(route?.distance)||!Number.isFinite(route?.duration)||!Array.isArray(coords)||coords.length<2||coords.length>15000)return fallback;
  const points:[number,number][]=coords.filter((p:any)=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])).map((p:number[])=>[p[1],p[0]]);
  if(points.length<2)return fallback;
  return {source:'road',distanceKm:Number((route.distance/1000).toFixed(2)),etaMinutes:Math.max(1,Math.ceil(route.duration/60)),coordinates:points,disclaimer:'Routing service estimate; traffic and actual arrival may differ'};
 }catch{return fallback;}
}
