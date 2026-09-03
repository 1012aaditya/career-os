import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { promises as dns } from 'node:dns';
import { createConnection } from 'node:net';

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


  @Get('tcp')
  async checkTcp() {
    const raw = process.env.DATABASE_URL;
    if (!raw) return { status: 'error', message: 'DATABASE_URL missing' };

    const url = new URL(raw);
    const port = Number(url.port || 5432);

    try {
      const addresses = await dns.lookup(url.hostname, { all: true });
      const connections = await Promise.all(
        addresses.map(
          (address) =>
            new Promise((resolve) => {
              const socket = createConnection({
                host: address.address,
                port,
                family: address.family,
              });
              socket.setTimeout(5000);
              const finish = (result: unknown) => {
                socket.destroy();
                resolve(result);
              };
              socket.on('connect', () => finish({ status: 'connected', address: address.address, family: address.family }));
              socket.on('timeout', () => finish({ status: 'timeout', address: address.address, family: address.family }));
              socket.on('error', (error: NodeJS.ErrnoException) => finish({ status: 'error', code: error.code }));
            }),
        ),
      );

      return { status: 'ok', host: url.hostname, port, dns: addresses, connections };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : 'Unknown error' };
    }
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
