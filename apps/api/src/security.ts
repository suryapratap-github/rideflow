import { Body, Controller, Post, UnauthorizedException, Injectable, CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Database } from './database';
import { compare } from 'bcryptjs';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { StaffRole } from '@prisma/client';
class LoginDto { @IsEmail() email!:string; @IsString() @MinLength(8) password!:string; }
export const Roles=(...roles:StaffRole[])=>SetMetadata('roles',roles);
@Injectable() export class JwtAuthGuard implements CanActivate {
 constructor(private readonly jwt:JwtService){}
 async canActivate(ctx:ExecutionContext){const req=ctx.switchToHttp().getRequest();const token=(req.headers.authorization||'').replace(/^Bearer /,'');try{req.user=await this.jwt.verifyAsync(token);if(req.user.kind!=='staff')throw new Error('Wrong token kind');return true;}catch{throw new UnauthorizedException('Valid bearer token required');}}
}
@Injectable() export class RolesGuard implements CanActivate {
 constructor(private readonly reflector:Reflector){}
 canActivate(ctx:ExecutionContext){const roles=this.reflector.getAllAndOverride<StaffRole[]>('roles',[ctx.getHandler(),ctx.getClass()]);if(!roles?.length)return true;const req=ctx.switchToHttp().getRequest();if(!roles.includes(req.user?.role))throw new UnauthorizedException('Insufficient role');return true;}
}
@Controller('auth') export class AuthController {
 constructor(private readonly db:Database,private readonly jwt:JwtService){}
 @Post('login') async login(@Body() dto:LoginDto){const user=await this.db.staffUser.findUnique({where:{email:dto.email.toLowerCase()}});if(!user||!await compare(dto.password,user.passwordHash))throw new UnauthorizedException('Invalid credentials');return {accessToken:await this.jwt.signAsync({sub:user.id,role:user.role,fleetId:user.fleetId,kind:'staff'}),role:user.role,fleetId:user.fleetId};}
}
