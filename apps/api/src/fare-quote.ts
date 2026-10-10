import { VehicleType } from '@prisma/client';
import { pickupRoute } from './route-planner';
type QuoteInput={type:VehicleType;pickupLatitude:number;pickupLongitude:number;dropoffLatitude:number;dropoffLongitude:number};
// Illustrative fixed tariffs, NOT regulatory/commercial approved pricing.
const tariff:Record<VehicleType,{base:number;perKm:number}>={BIKE:{base:2000,perKm:900},AUTO:{base:3500,perKm:1400},MINI:{base:5500,perKm:1800},SEDAN:{base:7500,perKm:2300},SUV:{base:11000,perKm:3100}};
export async function calculateFareQuote(input:QuoteInput){
 const route=await pickupRoute({latitude:input.pickupLatitude,longitude:input.pickupLongitude},{latitude:input.dropoffLatitude,longitude:input.dropoffLongitude});
 const t=tariff[input.type];
 if(route.source!=='road')return {available:false,reason:'Road routing unavailable. Cannot provide a reliable fare quote.',route};
 const farePaise=t.base+Math.ceil(route.distanceKm*t.perKm);
 return {available:true,estimatedFarePaise:farePaise,currency:'INR',distanceKm:route.distanceKm,estimatedMinutes:route.etaMinutes,route,disclaimer:'Illustrative pre-booking estimate, not a final or guaranteed fare; excludes tolls, taxes and surge.'};
}
