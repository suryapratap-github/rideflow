import { PrismaClient, VehicleType, RideStatus } from '@prisma/client';
import { hash } from 'bcryptjs';
const db = new PrismaClient();
async function main() {
 const passwordHash=await hash(process.env.DEMO_PASSWORD||'RideFlowDemo123!',12);
 await db.staffUser.upsert({where:{email:'admin@rideflow.local'},update:{passwordHash},create:{email:'admin@rideflow.local',passwordHash,role:'ADMIN'}});
 await db.staffUser.upsert({where:{email:'dispatch@rideflow.local'},update:{passwordHash},create:{email:'dispatch@rideflow.local',passwordHash,role:'DISPATCH'}});
 await db.staffUser.upsert({where:{email:'fleet@rideflow.local'},update:{passwordHash,fleetId:'demo-fleet'},create:{email:'fleet@rideflow.local',passwordHash,role:'FLEET_MANAGER',fleetId:'demo-fleet'}});
 const cityNames = [['Jaipur','Rajasthan'],['Delhi','Delhi'],['Mumbai','Maharashtra'],['Bengaluru','Karnataka'],['Hyderabad','Telangana'],['Pune','Maharashtra'],['Chennai','Tamil Nadu'],['Kolkata','West Bengal'],['Ahmedabad','Gujarat'],['Lucknow','Uttar Pradesh']];
 for (const [name,state] of cityNames) await db.city.upsert({where:{name},update:{},create:{name,state}});
 const city = await db.city.findUniqueOrThrow({where:{name:'Jaipur'}});
 const customer = await db.customer.upsert({where:{phone:'9000000001'},update:{},create:{name:'Aditi Sharma',phone:'9000000001'}});
 const fleet = await db.fleet.upsert({where:{id:'demo-fleet'},update:{},create:{id:'demo-fleet',name:'Pink City Mobility',city:'Jaipur'}});
 const driver = await db.driver.upsert({where:{phone:'9000000002'},update:{},create:{name:'Arjun Singh',phone:'9000000002',cityId:city.id,status:'APPROVED',online:true,fleetId:fleet.id}});
 const vehicle = await db.vehicle.upsert({where:{plate:'RJ14AB4582'},update:{},create:{plate:'RJ14AB4582',type:'MINI',cityId:city.id,driverId:driver.id,fleetId:fleet.id,documentExpiry:new Date('2027-01-01')}});
 for(let i=1;i<=12;i++) await db.ride.upsert({where:{reference:'RF-'+String(i).padStart(4,'0')},update:{},create:{reference:'RF-'+String(i).padStart(4,'0'),customerId:customer.id,driverId:i%3?driver.id:null,vehicleId:i%3?vehicle.id:null,cityId:city.id,pickup:'Civil Lines, Jaipur',dropoff:i%2?'Jaipur Railway Station':'Malviya Nagar',type:i%2?'MINI':'AUTO',status:([RideStatus.REQUESTED,RideStatus.ASSIGNED,RideStatus.IN_PROGRESS,RideStatus.COMPLETED] as RideStatus[])[i%4],farePaise:13800+i*700}});
 for(let i=1;i<=5;i++) await db.supportTicket.upsert({where:{reference:'SUP-'+i},update:{},create:{reference:'SUP-'+i,subject:['Payment issue','Driver no-show','Lost item','Ride cancellation','Promo issue'][i-1],priority:i===2?'HIGH':'NORMAL'}});
 for(let i=1;i<=3;i++) await db.safetyIncident.upsert({where:{reference:'SAFE-'+i},update:{},create:{reference:'SAFE-'+i,summary:'Incident review '+i,severity:i===1?'HIGH':'MEDIUM'}});
 for(const type of [VehicleType.BIKE,VehicleType.AUTO,VehicleType.MINI,VehicleType.SEDAN,VehicleType.SUV]) await db.pricingRule.upsert({where:{city_vehicleType:{city:'Jaipur',vehicleType:type}},update:{},create:{city:'Jaipur',vehicleType:type,basePaise:3500,perKmPaise:1200,perMinPaise:180}});
 await db.settlement.upsert({where:{reference:'SET-1001'},update:{},create:{reference:'SET-1001',beneficiary:'Pink City Mobility',amountPaise:420000,status:'PENDING'}});
 await db.auditLog.create({data:{actor:'seed',action:'INITIALIZE',resource:'demo'}});
}
main().finally(()=>db.$disconnect());
