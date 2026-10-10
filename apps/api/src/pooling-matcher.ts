/** Conservative candidate screening, not a road-routing or dispatch decision. */
export type PoolPoint = {latitude:number;longitude:number};
export type PoolCandidate = {id:string;customerId:string;cityId:string;type:string;status:string;poolingRequested:boolean;pickupLatitude:number|null;pickupLongitude:number|null;dropoffLatitude:number|null;dropoffLongitude:number|null;createdAt:Date};
export function km(a:PoolPoint,b:PoolPoint):number {
 const r=Math.PI/180, dLat=(b.latitude-a.latitude)*r,dLon=(b.longitude-a.longitude)*r;
 const h=Math.sin(dLat/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin(dLon/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
function point(lat:number|null,lon:number|null):PoolPoint|null {
 return lat===null||lon===null||!Number.isFinite(lat)||!Number.isFinite(lon)?null:{latitude:lat,longitude:lon};
}
export function compatiblePoolRides(a:PoolCandidate,b:PoolCandidate,opts={pickupKm:2,dropoffKm:3,maxAgeMinutes:20}):{pickupGapKm:number;dropoffGapKm:number}|null {
 if(a.id===b.id||a.customerId===b.customerId||a.cityId!==b.cityId||a.type!==b.type||!a.poolingRequested||!b.poolingRequested)return null;
 if(!['REQUESTED','MATCHING'].includes(a.status)||!['REQUESTED','MATCHING'].includes(b.status))return null;
 if(Math.abs(a.createdAt.getTime()-b.createdAt.getTime())>opts.maxAgeMinutes*60000)return null;
 const ap=point(a.pickupLatitude,a.pickupLongitude),bp=point(b.pickupLatitude,b.pickupLongitude);
 const ad=point(a.dropoffLatitude,a.dropoffLongitude),bd=point(b.dropoffLatitude,b.dropoffLongitude);
 if(!ap||!bp||!ad||!bd)return null;
 const pickupGapKm=km(ap,bp),dropoffGapKm=km(ad,bd);
 if(pickupGapKm>opts.pickupKm||dropoffGapKm>opts.dropoffKm)return null;
 // Reject opposing journeys, even if endpoints happen to be close.
 const aDirection=[ad.latitude-ap.latitude,ad.longitude-ap.longitude];
 const bDirection=[bd.latitude-bp.latitude,bd.longitude-bp.longitude];
 if(aDirection[0]*bDirection[0]+aDirection[1]*bDirection[1]<=0)return null;
 return {pickupGapKm:Math.round(pickupGapKm*100)/100,dropoffGapKm:Math.round(dropoffGapKm*100)/100};
}
