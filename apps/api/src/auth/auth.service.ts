import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupabaseClientService } from './supabase.client.js';

export type AuthenticatedUser = {
  id: string;
  email?: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly supabase: SupabaseClientService,
    private readonly prisma: PrismaService,
  ) {}

  async verifyAccessToken(accessToken: string): Promise<AuthenticatedUser> {
    const {
      data: { user },
      error,
    } = await this.supabase.client.auth.getUser(accessToken);

    if (error || !user) {
      throw new UnauthorizedException('Invalid access token');
    }

    await this.prisma.user.upsert({
      where: {
        id: user.id,
      },
      update: {},
      create: {
        id: user.id,
      },
    });

    return {
      id: user.id,
      email: user.email,
    };
  }
}