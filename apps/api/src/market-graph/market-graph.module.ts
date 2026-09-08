import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { MarketGraphCoreModule } from './market-graph-core.module.js';
import { MarketGraphController } from './market-graph.controller.js';

/*
 * The HTTP surface of the Market Graph: one controller, and the auth it
 * needs.
 *
 * Everything that actually does anything lives in MarketGraphCoreModule,
 * which knows nothing about authentication or HTTP. The split keeps the
 * pipeline runnable from a script and makes it structurally true - not
 * merely intended - that ingestion and signal computation do not depend on
 * a user session.
 */
@Module({
  imports: [MarketGraphCoreModule, AuthModule],
  controllers: [MarketGraphController],
})
export class MarketGraphModule {}
