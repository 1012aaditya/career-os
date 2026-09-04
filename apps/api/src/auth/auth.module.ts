import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { SupabaseClientService } from './supabase.client.js';

@Module({
  imports: [ConfigModule],
  providers: [SupabaseClientService, AuthService, AuthGuard],
  exports: [SupabaseClientService, AuthService, AuthGuard],
})
export class AuthModule {}
