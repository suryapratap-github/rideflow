import { PushService } from './push';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, SubscribeMessage, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { Database } from './database';

@Injectable()
@WebSocketGateway({namespace:'/live',cors:{origin:(process.env.DASHBOARD_ORIGIN||'http://localhost:3000').split(',')}})
export class LiveGateway implements OnGatewayConnection {
 @WebSocketServer() server!:Server;
 constructor(private jwt:JwtService,private db:Database,private push:PushService){}
 async handleConnection(socket:Socket){
  try {
   const token=socket.handshake.auth?.token;
   if(typeof token!=='string')throw new Error('missing token');
   const identity=await this.jwt.verifyAsync(token);
   if(identity.kind==='mobile' && identity.role==='CUSTOMER')socket.join('customer:'+identity.sub);
   else if(identity.kind==='mobile' && identity.role==='DRIVER')socket.join('driver:'+identity.sub);
   else if(['ADMIN','DISPATCH','FLEET_MANAGER'].includes(identity.role)){
    socket.join('staff:'+identity.role);
    if(identity.role==='FLEET_MANAGER'&&identity.fleetId)socket.join('fleet:'+identity.fleetId);
   } else throw new Error('invalid role');
   socket.data.identity=identity;
  } catch {socket.disconnect(true);}
 }
 async rideChanged(rideId:string){
  const ride=await this.db.ride.findUnique({where:{id:rideId},include:{driver:{select:{fleetId:true}}}});
  if(!ride)return;
  const payload={id:ride.id,reference:ride.reference,status:ride.status,driverId:ride.driverId,updatedAt:ride.updatedAt};
  this.server.to('customer:'+ride.customerId).emit('ride.updated',payload);
  if(ride.driverId)this.server.to('driver:'+ride.driverId).emit('ride.updated',payload);
  if(ride.driver?.fleetId)this.server.to('fleet:'+ride.driver.fleetId).emit('ride.updated',payload);
  this.server.to('staff:ADMIN').to('staff:DISPATCH').emit('ride.updated',payload);
  void this.push.sendRideUpdate(ride).catch(()=>{});
 }
 rideChatRead(customerId:string,driverId:string,rideId:string,readerRole:string){
  this.server.to('customer:'+customerId).to('driver:'+driverId).emit('ride.chat.read',{rideId,readerRole});
 }
 rideChatMessage(customerId:string,driverId:string,rideId:string,message:{id:string;role:string;text:string;createdAt:Date}){
  const payload={rideId,...message};
  this.server.to('customer:'+customerId).to('driver:'+driverId).emit('ride.chat.message',payload);
 }
 @SubscribeMessage('ride.chat.typing')
 async chatTyping(@ConnectedSocket() socket:Socket,@MessageBody() body:{rideId?:string;typing?:boolean}){
  const identity=socket.data.identity;
  if(identity?.kind!=='mobile'||!['CUSTOMER','DRIVER'].includes(identity.role))return;
  if(typeof body?.rideId!=='string'||body.rideId.length>128||typeof body.typing!=='boolean')return;
  const ride=await this.db.ride.findUnique({where:{id:body.rideId},select:{customerId:true,driverId:true,status:true}});
  if(!ride||!ride.driverId||!['ASSIGNED','ARRIVING','IN_PROGRESS'].includes(ride.status))return;
  if(identity.role==='CUSTOMER'&&ride.customerId!==identity.sub)return;
  if(identity.role==='DRIVER'&&ride.driverId!==identity.sub)return;
  const recipient=identity.role==='CUSTOMER'?'driver:'+ride.driverId:'customer:'+ride.customerId;
  socket.to(recipient).emit('ride.chat.typing',{rideId:body.rideId,role:identity.role,typing:body.typing});
 }
 async driverLocation(driverId:string,latitude:number,longitude:number){
  // A persisted fix is authoritative: never stream a client-supplied or stale coordinate.
  const fix=await this.db.driverLocation.findUnique({where:{driverId},select:{latitude:true,longitude:true,accuracyMeters:true,updatedAt:true}});
  if(!fix||!Number.isFinite(fix.latitude)||!Number.isFinite(fix.longitude)||
     (fix.accuracyMeters!=null&&fix.accuracyMeters>200)||
     Date.now()-fix.updatedAt.getTime()>30000||fix.updatedAt.getTime()>Date.now()+5000)return;
  const rides=await this.db.ride.findMany({where:{driverId,status:{in:['ASSIGNED','ARRIVING','IN_PROGRESS']}},select:{id:true,customerId:true}});
  if(!rides.length)return;
  // One driver's location may serve multiple legitimate active pooling rides.
  for(const ride of rides){
   this.server.to('customer:'+ride.customerId).emit('ride.location',{
    rideId:ride.id,latitude:fix.latitude,longitude:fix.longitude,
    accuracyMeters:fix.accuracyMeters,observedAt:fix.updatedAt.toISOString()
   });
  }
  this.server.to('staff:ADMIN').to('staff:DISPATCH').emit('driver.location',{
   driverId,latitude:fix.latitude,longitude:fix.longitude,observedAt:fix.updatedAt.toISOString()
  });
 }
}
