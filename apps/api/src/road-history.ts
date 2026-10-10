/** Bounded, process-local GPS history. No persistence and no customer identifiers. */
export type RoadObservation={latitude:number;longitude:number;accuracyMeters?:number|null;updatedAt:Date|string};
const history=new Map<string,RoadObservation[]>();
const MAX_DRIVERS=10000;
export function recentRoadObservations(driverId:string,fix:RoadObservation,now=Date.now()):RoadObservation[]{
 const time=new Date(fix.updatedAt).getTime();
 if(!driverId||!Number.isFinite(time)||time>now+5000||now-time>30000||!Number.isFinite(fix.latitude)||!Number.isFinite(fix.longitude)||Math.abs(fix.latitude)>90||Math.abs(fix.longitude)>180||fix.accuracyMeters!=null&&(!Number.isFinite(fix.accuracyMeters)||fix.accuracyMeters>50||fix.accuracyMeters<0))return [];
 const old=(history.get(driverId)||[]).filter(p=>{const t=new Date(p.updatedAt).getTime();return t<time&&time-t<=20000;});
 const next=[...old.slice(-2),fix];
 history.delete(driverId);
 if(history.size>=MAX_DRIVERS)history.delete(history.keys().next().value!);
 history.set(driverId,next);
 return next;
}
