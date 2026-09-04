import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: `postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD ?? '')}@${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'postgres'}`,
  }),
});

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
