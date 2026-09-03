import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
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
    const dns = await import('node:dns/promises');
    const net = await import('node:net');

    const host = 'aws-0-ap-southeast-2.pooler.supabase.com';
    const port = 5432;

    try {
      const addresses = await dns.lookup(host, { all: true });

      const connections = await Promise.all(
        addresses.map(
          (address) =>
            new Promise((resolve) => {
              const socket = net.createConnection({
                host: address.address,
                port,
                family: address.family,
              });

              socket.setTimeout(5000);

              const finish = (result: unknown) => {
                socket.destroy();
                resolve(result);
              };

              socket.on('connect', () =>
                finish({
                  status: 'connected',
                  address: address.address,
                  family: address.family,
                }),
              );

              socket.on('timeout', () =>
                finish({
                  status: 'timeout',
                  address: address.address,
                  family: address.family,
                }),
              );

              socket.on('error', (error: NodeJS.ErrnoException) =>
                finish({
                  status: 'error',
                  address: address.address,
                  family: address.family,
                  code: error.code,
                }),
              );
            }),
        ),
      );

      return { host, port, dns: addresses, connections };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  @Get('config')
  checkConfig() {
    const raw = process.env.DATABASE_URL;

    if (!raw) return { present: false };

    return {
      present: true,
      length: raw.length,
      startsWithPostgres: raw.startswith('postgresql://') if False else raw.startsWith('postgresql://'),
      hasSpaces: /\\s/.test(raw),
      hasQuotes: raw.includes('"') || raw.includes("'"),
      hasBrackets: raw.includes('[') || raw.includes(']'),
      hasBackticks: raw.includes('`'),
      first20: raw.slice(0, 20),
      last20: raw.slice(-20),
    };
  }

  @Get('pg')
  async checkPg() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      return { status: 'error', message: 'DATABASE_URL missing' };
    }

    const pool = new Pool({ connectionString });

    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'pg-connected' };
    } catch (error) {
      return {
        status: 'error',
        database: 'pg-unreachable',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      await pool.end();
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
