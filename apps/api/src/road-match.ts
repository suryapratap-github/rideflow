/** Optional OSRM nearest-road adapter. Never treats a failed/uncertain match as verified. */
import {recentRoadObservations} from './road-history';
export type GpsFix={latitude:number;longitude:number;accuracyMeters?:number|null;updatedAt?:Date|string};
export type MatchResult={location:GpsFix;source:'gps'|'road';distanceMeters?:number};
export async function matchRoadFix(fix:GpsFix, options:{baseUrl?:string;fetcher?:typeof fetch;driverId?:string}={}):Promise<MatchResult>{
 const fallback:MatchResult={location:fix,source:'gps'};
 const configured=options.baseUrl??process.env.RIDEFLOW_OSRM_MATCH_URL;
 if(!configured||!Number.isFinite(fix.latitude)||!Number.isFinite(fix.longitude)||Math.abs(fix.latitude)>90||Math.abs(fix.longitude)>180||fix.accuracyMeters!=null&&fix.accuracyMeters>50)return fallback;
 let base:URL;
 try{base=new URL(configured);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')return fallback;}catch{return fallback;}
 const history=options.driverId&&fix.updatedAt?recentRoadObservations(options.driverId,{...fix,updatedAt:fix.updatedAt}):[];
 // OSRM match uses successive observations to disambiguate parallel roads and turns.
 const useTrace=history.length>=2;
 const coords=useTrace?history.map(p=>`${p.longitude},${p.latitude}`).join(';'):`${fix.longitude},${fix.latitude}`;
 const url=new URL(`/${useTrace?'match':'nearest'}/v1/driving/${coords}`,base);
 if(useTrace){url.searchParams.set('geometries','geojson');url.searchParams.set('overview','false');url.searchParams.set('timestamps',history.map(p=>Math.floor(new Date(p.updatedAt).getTime()/1000)).join(';'));}
 else url.searchParams.set('number','1');
 try{
  const response=await (options.fetcher??fetch)(url.toString(),{signal:AbortSignal.timeout(1200),headers:{accept:'application/json'},redirect:'error'});
  if(!response.ok)return fallback;
  const body=await response.json() as {code?:string;waypoints?:{location?:unknown;distance?:unknown}[];tracepoints?:({location?:unknown;distance?:unknown}|null)[];matchings?:{confidence?:number}[]};
  // A low-confidence or unmatched trace is not a verified road position.
  if(useTrace&&(body.matchings?.[0]?.confidence==null||body.matchings[0].confidence!<0.7))return fallback;
  const waypoint=useTrace?body.tracepoints?.at(-1):body.waypoints?.[0],point=waypoint?.location,distance=waypoint?.distance;
  if(body.code!=='Ok'||!Array.isArray(point)||point.length!==2||!point.every(v=>typeof v==='number'&&Number.isFinite(v))||typeof distance!=='number'||!Number.isFinite(distance)||distance<0||distance>35)return fallback;
  const [longitude,latitude]=point as number[];
  if(Math.abs(latitude)>90||Math.abs(longitude)>180)return fallback;
  return {location:{...fix,latitude,longitude},source:'road',distanceMeters:distance};
 }catch{return fallback;}
}
