/** Distance-based ordering, with stale GPS excluded when pickup coordinates are known. */
export function haversineKm(aLat:number,aLon:number,bLat:number,bLon:number):number {
 const rad=Math.PI/180; const dLat=(bLat-aLat)*rad,dLon=(bLon-aLon)*rad;
 const a=Math.sin(dLat/2)**2+Math.cos(aLat*rad)*Math.cos(bLat*rad)*Math.sin(dLon/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
export function rankNearbyDrivers<T extends {id:string}>(drivers:T[],locations:{driverId:string;latitude:number;longitude:number}[],lat?:number|null,lon?:number|null):T[]{
 if(lat==null||lon==null)return drivers;
 const positions=new Map(locations.map(p=>[p.driverId,p]));
 return drivers.filter(d=>positions.has(d.id)).sort((a,b)=>{
  const x=positions.get(a.id)!,y=positions.get(b.id)!;
  return haversineKm(lat,lon,x.latitude,x.longitude)-haversineKm(lat,lon,y.latitude,y.longitude)||a.id.localeCompare(b.id);
 });
}
