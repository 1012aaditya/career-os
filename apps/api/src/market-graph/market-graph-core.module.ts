import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module.js';
import { MarketIngestionRunService } from './ingestion/market-ingestion-run.service.js';
import { MarketIngestionService } from './ingestion/market-ingestion.service.js';
import { MarketVocabularyService } from './ingestion/market-vocabulary.service.js';
import { MarketGraphService } from './market-graph.service.js';
import { MarketNormalizationService } from './normalization/market-normalization.service.js';
import { MarketSignalService } from './signals/market-signal.service.js';
import { GreenhouseClient } from './sources/greenhouse/greenhouse.client.js';
import { JobTechClient } from './sources/jobtech/jobtech.client.js';
import { MarketSourcePurgeService } from './sources/market-source-purge.service.js';
import { MarketSourceRegistry } from './sources/source-registry.js';
import { TeachingVacanciesClient } from './sources/teaching-vacancies/teaching-vacancies.client.js';

/*
 * The Market Graph pipeline, with no HTTP surface and no authentication.
 *
 * Split out from MarketGraphModule so the operator CLI can run ingestion
 * and signal computation without booting the auth stack. That is not only
 * convenience: it means the pipeline provably does not depend on a user
 * session, which is the same claim the phase boundary makes - the market
 * is the same for everybody, and nothing here may become personalised
 * without that showing up as a new dependency.
 *
 * Registered in the order the pipeline runs, which is also the order the
 * layers may depend on each other. Nothing later is imported by anything
 * earlier.
 *
 * The source adapter is deliberately NOT a provider. It is a pure class
 * with no dependencies, constructed where it is used, so nothing in the
 * canonical layers can acquire one by injection - which is the seam that
 * keeps source-specific knowledge on one side of the boundary.
 */
@Module({
  imports: [
    /*
     * Imported here as well as in AppModule so the pipeline can boot on
     * its own from the CLI. PrismaService reads DATABASE_URL from the
     * environment directly, and without ConfigModule loading .env first
     * the script fails at construction with a message about configuration
     * rather than about what it was asked to do.
     */
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
  ],
  providers: [
    GreenhouseClient,
    JobTechClient,
    TeachingVacanciesClient,
    MarketSourceRegistry,
    MarketVocabularyService,
    MarketIngestionRunService,
    MarketIngestionService,
    MarketNormalizationService,
    MarketSignalService,
    MarketGraphService,
    MarketSourcePurgeService,
  ],
  exports: [
    MarketSourcePurgeService,
    MarketSourceRegistry,
    MarketVocabularyService,
    MarketIngestionService,
    MarketNormalizationService,
    MarketSignalService,
    MarketGraphService,
  ],
})
export class MarketGraphCoreModule {}
