import { Controller, Get, Put, Param, Body, Req, UseGuards, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Database } from './database';
import { PROVIDER_FIELDS, encryptCredentials, providerConfig } from './payment-credentials';
import { JwtAuthGuard, RolesGuard, Roles } from './security';

export const CHANNELS=['COD','UPI','ONLINE'] as const;
export type Channel=typeof CHANNELS[number];
export function channelName(method:string){return method==='CASH'?'COD':method;}
export async function channelEnabled(db:Database,method:string){
 const key=channelName(method);
 if(!CHANNELS.includes(key as Channel))return false;
 const row=await db.paymentChannelSetting.findUnique({where:{method:key}});
 // Development default: all channels enabled. Admin overrides persist in PostgreSQL.
 return row?row.enabled:true;
}
@Controller('mobile/payment-methods')
export class MobilePaymentChannelsController {
 constructor(private db:Database){}
 @Get() async list(){return {methods:await Promise.all(CHANNELS.map(async method=>({method,enabled:await channelEnabled(this.db,method)}))),notice:'COD does not support coupons or tips.'};}
}
@Controller('admin/payment-methods') @UseGuards(JwtAuthGuard,RolesGuard)
export class AdminPaymentChannelsController {
 constructor(private db:Database){}
 @Get() @Roles('ADMIN') async list(){return {methods:await Promise.all(CHANNELS.map(async method=>({method,enabled:await channelEnabled(this.db,method)})))};}
 @Get('providers') @Roles('ADMIN') async providers(){return {providers:await Promise.all((['STRIPE','RAZORPAY'] as const).map(async provider=>{const values=await providerConfig(this.db,provider);return {provider,fields:PROVIDER_FIELDS[provider].map(key=>({name:key,configured:Boolean(values[key])}))};}))};}
 @Put('providers/:provider') @Roles('ADMIN') async saveProvider(@Req() req:any,@Param('provider') provider:string,@Body() body:{credentials?:Record<string,string>}){
  if(provider!=='STRIPE'&&provider!=='RAZORPAY')throw new BadRequestException('Unknown provider');
  const fields=PROVIDER_FIELDS[provider],input=body?.credentials;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k as any)))throw new BadRequestException('Invalid credential fields');
  const supplied=Object.entries(input);if(!supplied.length||supplied.some(([k,v])=>typeof v!=='string'||v.trim().length<8||v.length>4096))throw new BadRequestException('Supply valid credential values');
  const current=await providerConfig(this.db,provider);const merged={...current,...input};const encryptedJson=encryptCredentials(merged);
  await this.db.$transaction(async tx=>{await tx.paymentProviderCredential.upsert({where:{provider},create:{provider,encryptedJson},update:{encryptedJson}});await tx.auditLog.create({data:{actor:req.user?.sub||'ADMIN',action:'PAYMENT_PROVIDER_CREDENTIALS_UPDATED',resource:provider}});});
  return {provider,saved:true,notice:'Secrets are write-only and encrypted at rest. Restart not required for new gateway requests.'};
 }
 @Put(':method') @Roles('ADMIN') async set(@Req() req:any,@Param('method') method:string,@Body() body:{enabled?:boolean}){
  if(!CHANNELS.includes(method as Channel)||typeof body?.enabled!=='boolean')throw new BadRequestException('Invalid method or enabled flag');
  return this.db.$transaction(async tx=>{
   const saved=await tx.paymentChannelSetting.upsert({where:{method},create:{method,enabled:body.enabled!},update:{enabled:body.enabled!}});
   await tx.auditLog.create({data:{actor:req.user?.sub||'ADMIN',action:'PAYMENT_CHANNEL_UPDATED',resource:`${method}:${saved.enabled}`}});
   return {method:saved.method,enabled:saved.enabled};
  });
 }
}
