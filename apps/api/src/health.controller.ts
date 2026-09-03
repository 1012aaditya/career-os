
import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
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
    const url = new URL(process.env.DATABASE_URL!);

    try {
      await prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ok',
        database: 'connected',
        host: url.hostname,
        port: url.port,
      };
    } catch (error) {
      return {
        status: 'error',
        database: 'unreachable',
        host: url.hostname,
        port: url.port,
      };
    }
  }
}
