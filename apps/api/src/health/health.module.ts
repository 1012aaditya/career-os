import { Module } from '@nestjs/common';

import { ObservabilityModule } from '../observability/observability.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [ObservabilityModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
