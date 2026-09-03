import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { promises as dns } from 'node:dns';
import { createConnection } from 'node:net';

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
    } catch {
      return {
        status: 'error',
        database: 'unreachable',
        host: url.hostname,
        port: url.port,
      };
    }
  }

  @Get('tcp')
  async checkTcp() {
    const url = new URL(process.env.DATABASE_URL!);
    const port = Number(url.port || 5432);

    try {
      const addresses = await dns.lookup(url.hostname, { all: true });

      const results = await Promise.all(
        addresses.map(
          (address) =>
            new Promise((resolve) => {
              const socket = createConnection({
                host: address.address,
                port,
                family: address.family,
              });

              const finish = (result: unknown) => {
                socket.destroy();
                resolve(result);
              };

              socket.setTimeout(5000);

              socket.on('connect', () =>
                finish({
                  address: address.address,
                  family: address.family,
                  status: 'connected',
                }),
              );

              socket.on('timeout', () =>
                finish({
                  address: address.address,
                  family: address.family,
                  status: 'timeout',
                }),
              );

              socket.on('error', (error: NodeJS.ErrnoException) =>
                finish({
                  address: address.address,
                  family: address.family,
                  status: 'error',
                  code: error.code,
                }),
              );
            }),
        ),
      );

      return {
        host: url.hostname,
        port,
        dns: addresses,
        connections: results,
      };
    } catch (error) {
      return {
        status: 'diagnostic-error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
