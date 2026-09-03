import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const databaseUrl = process.env.DATABASE_URL;

const prisma = databaseUrl
  ? new PrismaClient({
      adapter: new PrismaPg({
        connectionString: databaseUrl,
      }),
    })
  : null;

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'career-os-api',
    };
  }

  @Get('db')
  async checkDatabase() {
    if (!prisma) {
      return {
        status: 'error',
        database: 'DATABASE_URL missing',
      };
    }

    try {
      await prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ok',
        database: 'connected',
      };
    } catch (error) {
      return {
        status: 'error',
        database: 'unreachable',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
