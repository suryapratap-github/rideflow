import { compatiblePoolRides, PoolCandidate } from './pooling-matcher';
export const capacityForType=(type:string):number=>({MINI:3,SEDAN:3,SUV:5}[type]??0);
export type GroupableRide=PoolCandidate & {poolGroupId:string|null;poolSeats:number;driverId:string|null;vehicleId:string|null;scheduledAt:Date|null};
/** Conservative grouping; never substitutes for road routing, passenger consent or shared dispatch. */
export function validatePoolGroup(rides:GroupableRide[]):string|null {
 if(rides.length!==2)return 'Exactly two rides required';
 const [a,b]=rides;
 if(a.poolGroupId||b.poolGroupId)return 'A ride is already grouped';
 if(a.driverId||b.driverId||a.vehicleId||b.vehicleId)return 'Already dispatched rides cannot be grouped';
 if(a.scheduledAt||b.scheduledAt)return 'Scheduled rides cannot be grouped';
 const capacity=capacityForType(a.type);
 if(!capacity||!Number.isInteger(a.poolSeats)||!Number.isInteger(b.poolSeats)||a.poolSeats<1||b.poolSeats<1||a.poolSeats+b.poolSeats>capacity)return 'Insufficient passenger seat capacity';
 if(!compatiblePoolRides(a,b))return 'Rides are not compatible for pooling';
 return null;
}
