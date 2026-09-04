import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseClientService } from './supabase.client.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly supabase: SupabaseClientService,
  ) {}

  async verifyAccessToken(accessToken: string) {
    const { data, error } = await this.supabase.client.auth.getUser(
      accessToken,
    );

    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    return data.user;
  }
}
