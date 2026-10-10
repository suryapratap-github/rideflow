import { assertStripeConnectPayoutsDisabled } from './stripe-connect-policy';
import { allowedCorsOrigins } from './runtime-config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './module';
async function bootstrap(){assertStripeConnectPayoutsDisabled();const app=await NestFactory.create(AppModule,{rawBody:true});app.setGlobalPrefix('api');app.enableCors({origin:allowedCorsOrigins(process.env)});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(Number(process.env.PORT||4000),'0.0.0.0');}
bootstrap();
