import { Global, Module } from '@nestjs/common';

import { StructuredLogger } from './structured-logger.js';

/*
 * Global, so any service can log without its module declaring a
 * dependency on observability. That is the one thing worth making
 * ambient: the alternative is editing a dozen frozen modules to add an
 * import whose only purpose is diagnostics.
 *
 * Only the LOGGER is global. The filter, the interceptor and the
 * middleware are wired once in AppModule and main.ts, where a reader can
 * see the whole request pipeline in one place.
 */
@Global()
@Module({
  providers: [StructuredLogger],
  exports: [StructuredLogger],
})
export class ObservabilityModule {}
