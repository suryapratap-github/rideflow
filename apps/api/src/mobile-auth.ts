import { Body, Controller, Post, Get, Req, UseGuards, Injectable, CanActivate, ExecutionContext, UnauthorizedException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsEnum, IsString, Matches } from 'class-validator';
import { MobileRole } from '@prisma/client';
import { randomInt, createHash, timingSafeEqual } from 'crypto';
import { Database } from './database';
import { sendSmsModeOtp } from './smsmode';
class RequestOtpDto { @Matches(/^\+91[6-9]\d{9}$/) phone!:string; @IsEnum(MobileRole) role!:MobileRole; }
class VerifyOtpDto extends RequestOtpDto { @IsString() @Matches(/^\d{6}$/) code!:string; }
const digest=(v:string)=>createHash('sha256').update(v).digest();
@Injectable() export class MobileGuard implements CanActivate {
 constructor(private jwt:JwtService){}
 async canActivate(ctx:ExecutionContext){const req=ctx.switchToHttp().getRequest();try{const t=(req.headers.authorization||'').replace(/^Bearer /,'');req.mobile=await this.jwt.verifyAsync(t);if(req.mobile.kind!=='mobile'||!['CUSTOMER','DRIVER'].includes(req.mobile.role))throw new Error();return true;}catch{throw new UnauthorizedException('Mobile login required');}}
}
@Controller('mobile/auth') export class MobileAuthController {
 constructor(private db:Database,private jwt:JwtService){}
 @Post('request-otp') async request(@Body() dto:RequestOtpDto){
  // Explicitly disabled outside local development until SMS delivery, Redis rate limits and abuse controls are installed.
  if(!((process.env.NODE_ENV==='development'&&process.env.DEV_OTP_ENABLED==='true')||process.env.SMSMODE_ENABLED==='true'))throw new ForbiddenException('OTP delivery is not configured');
  const recent=await this.db.otpChallenge.count({where:{phone:dto.phone,createdAt:{gte:new Date(Date.now()-60_000)}}});if(recent>=2)throw new BadRequestException('Please wait before requesting another code');
  const code=String(randomInt(0,1000000)).padStart(6,'0');const salt=process.env.OTP_HASH_SECRET;if(!salt||salt.length<24)throw new ForbiddenException('OTP hash secret is not configured');
  const challenge=await this.db.otpChallenge.create({data:{phone:dto.phone,role:dto.role,codeHash:digest(salt+':'+dto.phone+':'+code).toString('hex'),expiresAt:new Date(Date.now()+5*60_000)}});
  if(process.env.SMSMODE_ENABLED==='true'){
   try{await sendSmsModeOtp(dto.phone,code);}catch{await this.db.otpChallenge.delete({where:{id:challenge.id}});throw new ForbiddenException('OTP delivery unavailable. Please retry later');}
   return {expiresInSeconds:300};
  }
  // Local development only: never return codes from production.
  return {expiresInSeconds:300,developmentCode:code};
 }
 @Post('verify-otp') async verify(@Body() dto:VerifyOtpDto){
  if(!((process.env.NODE_ENV==='development'&&process.env.DEV_OTP_ENABLED==='true')||process.env.SMSMODE_ENABLED==='true'))throw new ForbiddenException('OTP delivery is not configured');
  const salt=process.env.OTP_HASH_SECRET;if(!salt)throw new ForbiddenException('OTP hash secret missing');
  const c=await this.db.otpChallenge.findFirst({where:{phone:dto.phone,role:dto.role,consumedAt:null},orderBy:{createdAt:'desc'}});
  if(!c||c.expiresAt<new Date()||c.attempts>=5)throw new UnauthorizedException('Code expired or invalid');
  await this.db.otpChallenge.update({where:{id:c.id},data:{attempts:{increment:1}}});
  const expected=Buffer.from(c.codeHash,'hex');const actual=digest(salt+':'+dto.phone+':'+dto.code);if(!timingSafeEqual(expected,actual))throw new UnauthorizedException('Code expired or invalid');
  const consumed=await this.db.otpChallenge.updateMany({where:{id:c.id,consumedAt:null},data:{consumedAt:new Date()}});if(consumed.count!==1)throw new UnauthorizedException('Code already used');
  const person=dto.role==='CUSTOMER'?await this.db.customer.findUnique({where:{phone:dto.phone}}):await this.db.driver.findUnique({where:{phone:dto.phone}});
  if(!person)throw new ForbiddenException('Account not registered. Contact support for onboarding');
  if(dto.role==='DRIVER'&&'status' in person&&person.status!=='APPROVED')throw new ForbiddenException('Driver approval required');
  return {accessToken:await this.jwt.signAsync({sub:person.id,kind:'mobile',role:dto.role},{expiresIn:'24h'}),role:dto.role};
 }
 @Get('me') @UseGuards(MobileGuard) async me(@Req() req:any){return req.mobile.role==='CUSTOMER'?this.db.customer.findUnique({where:{id:req.mobile.sub},select:{id:true,name:true,phone:true}}):this.db.driver.findUnique({where:{id:req.mobile.sub},select:{id:true,name:true,phone:true,status:true,online:true}});}
}
