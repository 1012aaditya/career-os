import { NestFactory } from '@nestjs/core';

import { MarketIngestionService } from './ingestion/market-ingestion.service.js';
import { MarketVocabularyService } from './ingestion/market-vocabulary.service.js';
import { MarketGraphCoreModule } from './market-graph-core.module.js';
import { MarketNormalizationService } from './normalization/market-normalization.service.js';
import { MarketSignalService } from './signals/market-signal.service.js';
import { MarketSourceRegistry } from './sources/source-registry.js';

/*
 * The operator entry point for the Market Graph pipeline.
 *
 * A script rather than an HTTP route, deliberately. Ingestion is a
 * minutes-long network walk that holds an ingestion run open, and exposing
 * it as an endpoint would mean a phone could start one - and that a second
 * request would get a 409 it has no way to act on. The API stays read-only
 * and there is no write path on it to secure.
 *
 * Usage, from apps/api after `pnpm build`:
 *   node dist/market-graph/market-graph.cli.js sync    <source> <scope>...
 *   node dist/market-graph/market-graph.cli.js signals <source> <scope>...
 *   node dist/market-graph/market-graph.cli.js sources
 *
 * The source is an argument. It used to be baked in: the CLI called
 * `ensureGreenhouseSource()` and `ingestGreenhouse()` and hard-coded the
 * slug when computing signals.
 */

const DEFAULT_WINDOW_DAYS = 30;

/*
 * The publication floor.
 *
 * A prevalence is not written below thirty eligible postings, or where
 * either the eligible cohort or the postings that actually mention the
 * skill come from fewer than two employers. Both numbers are hypotheses to
 * be revised once the real distribution is visible, which is exactly why
 * they are recorded on the signal run rather than left implicit in code:
 * changing them produces a new, comparable snapshot instead of silently
 * changing what an existing number means.
 */
const MIN_DENOMINATOR = 30;
const MIN_DISTINCT_COMPANIES = 2;

async function main(): Promise<void> {
  const [command, sourceSlug, ...scopes] = process.argv.slice(2);

  const app = await NestFactory.createApplicationContext(
    MarketGraphCoreModule,
    { logger: ['error', 'warn'] },
  );

  try {
    const registry = app.get(MarketSourceRegistry);

    if (command === 'sources') {
      for (const descriptor of registry.descriptors()) {
        console.log(
          '[source]',
          JSON.stringify({
            slug: descriptor.slug,
            licenceBasis: descriptor.licenceBasis,
            mayRedistributeDerived: descriptor.mayRedistributeDerived,
            identityBasis: descriptor.adapter.identityBasis,
          }),
        );
      }

      return;
    }

    if (
      (command !== 'sync' && command !== 'signals') ||
      sourceSlug === undefined ||
      scopes.length === 0
    ) {
      console.error(
        'usage: market-graph.cli.js <sync|signals> <source> <scope>... | sources',
      );
      process.exitCode = 1;
      return;
    }

    const descriptor = registry.get(sourceSlug);
    const vocabulary = app.get(MarketVocabularyService);

    await vocabulary.ensureSource(descriptor);
    const synced = await vocabulary.syncVocabulary();
    console.log('[vocabulary]', JSON.stringify(synced));

    if (command === 'sync') {
      const ingestion = app.get(MarketIngestionService);
      const normalization = app.get(MarketNormalizationService);

      /*
       * The run clock is read ONCE, here, and passed down. Every layer
       * below takes it as a parameter and none reads a clock of its own,
       * which is what lets a test advance time deliberately and assert
       * that nothing except the fields allowed to move actually moved.
       */
      const now = new Date();

      const result = await ingestion.ingest({
        source: descriptor,
        scopes,
        now,
      });

      console.log(
        '[ingest]',
        JSON.stringify({
          source: descriptor.slug,
          runId: result.runId,
          status: result.status,
          scopesRequested: result.stats.scopesRequested,
          scopesRead: result.stats.scopesRead,
          scopesComplete: result.stats.scopesComplete,
          postingsAccepted: result.stats.postingsAccepted,
          postingsRejected: result.stats.postingsRejected,
          duplicatesDropped: result.stats.duplicatesDropped,
          postingsCreated: result.stats.postingsCreated,
          versionsCreated: result.stats.versionsCreated,
          sightingsCreated: result.stats.sightingsCreated,
        }),
      );

      for (const scope of result.stats.scopes) {
        console.log(
          '[scope]',
          JSON.stringify({
            scope: scope.sourceScope,
            read: scope.read,
            complete: scope.completeForScope,
            pages: scope.pagesFetched,
            accepted: scope.postingsAccepted,
            rejected: scope.postingsRejected,
            failure: scope.failureReason,
          }),
        );
      }

      let total = { normalized: 0, mentions: 0, unresolvedRoles: 0 };

      for (;;) {
        const batch = await normalization.normalizePending({ now: new Date() });

        total = {
          normalized: total.normalized + batch.normalized,
          mentions: total.mentions + batch.mentions,
          unresolvedRoles: total.unresolvedRoles + batch.unresolvedRoles,
        };

        if (batch.normalized === 0) {
          break;
        }
      }

      console.log('[normalize]', JSON.stringify(total));
      return;
    }

    const signals = app.get(MarketSignalService);
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 1000);
    const windowStart = new Date(
      windowEnd.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const computed = await signals.compute({
      sourceSlug: descriptor.slug,
      scopes,
      windowStart,
      windowEnd,
      minDenominator: MIN_DENOMINATOR,
      minDistinctCompanies: MIN_DISTINCT_COMPANIES,
      now,
      clock: () => new Date(),
    });

    console.log(
      '[signals]',
      JSON.stringify({
        source: descriptor.slug,
        runId: computed.runId,
        status: computed.status,
        signalCount: computed.signalCount,
        coverageComplete: computed.coverageComplete,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      }),
    );
  } finally {
    await app.close();
  }
}

await main();
