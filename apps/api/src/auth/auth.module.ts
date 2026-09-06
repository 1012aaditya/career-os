import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module.js';

import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { SupabaseClientService } from './supabase.client.js';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [SupabaseClientService, AuthService, AuthGuard],
  exports: [SupabaseClientService, AuthService, AuthGuard],
})
export class AuthModule {}