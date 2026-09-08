import { NestFactory } from '@nestjs/core';

import { MarketIngestionService } from './ingestion/market-ingestion.service.js';
import { MarketVocabularyService } from './ingestion/market-vocabulary.service.js';
import { MarketGraphCoreModule } from './market-graph-core.module.js';
import { MarketLegacySanitizerService } from './observations/market-legacy-sanitizer.service.js';
import { MarketNormalizationService } from './normalization/market-normalization.service.js';
import { MarketSignalService } from './signals/market-signal.service.js';
import { MarketDatasetRegistry } from './datasets/dataset-registry.js';
import { MarketDatasetService } from './datasets/market-dataset.service.js';
import { MarketSourcePurgeService } from './sources/market-source-purge.service.js';
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
 *   node dist/market-graph/market-graph.cli.js purge   <source> --reason=<code> [--confirm]
 *
 * `purge` is a DRY RUN unless --confirm is passed. It is the only
 * destructive verb here, and the only protection on it is shell access to
 * the machine holding DATABASE_URL - which is stated rather than implied,
 * because it is the whole of the control.
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

    if (command === 'sanitize-legacy') {
      const result = await app.get(MarketLegacySanitizerService).sanitize();

      console.log('[sanitize-legacy]', JSON.stringify(result));

      return;
    }

    if (command === 'normalize') {
      /*
       * Re-normalizes every stored version that has no normalization at
       * the CURRENT ruleset. Idempotent by construction: the selector is
       * "versions with none at this ruleset", so a second run finds
       * nothing and older ruleset rows are retained rather than rewritten
       * - which is what keeps already-published signals reproducible.
       */
      const normalizer = app.get(MarketNormalizationService);
      const running = { normalized: 0, mentions: 0, unresolvedRoles: 0 };

      for (;;) {
        const batch = await normalizer.normalizePending({ now: new Date() });

        running.normalized += batch.normalized;
        running.mentions += batch.mentions;
        running.unresolvedRoles += batch.unresolvedRoles;

        if (batch.normalized === 0) {
          break;
        }
      }

      console.log('[normalize]', JSON.stringify(running));

      return;
    }

    if (command === 'dataset') {
      const registry2 = app.get(MarketDatasetRegistry);
      const slugs =
        sourceSlug === undefined || sourceSlug === 'all'
          ? registry2.descriptors().map((d) => d.slug)
          : [sourceSlug];

      for (const slug of slugs) {
        const descriptor = registry2.get(slug);

        /*
         * The MarketSource row carries the licence position, so it is
         * written before any data lands rather than after.
         */
        await app.get(MarketVocabularyService).ensureDatasetSource(descriptor);

        const result = await app
          .get(MarketDatasetService)
          .import(descriptor.dataset, new Date());

        console.log('[dataset]', JSON.stringify(result));
      }

      return;
    }

    if (command === 'purge') {
      const reason = process.argv.find((arg) => arg.startsWith('--reason='));
      const confirm = process.argv.includes('--confirm');

      if (sourceSlug === undefined || reason === undefined) {
        console.error(
          'usage: market-graph.cli.js purge <source> --reason=<code> [--confirm]',
        );
        process.exitCode = 1;
        return;
      }

      /*
       * Routed through the registry, so a slug that exists in the database
       * but is no longer a source this build knows about is refused rather
       * than purged by a stale name.
       */
      registry.get(sourceSlug);

      const manifest = await app.get(MarketSourcePurgeService).purge({
        sourceSlug,
        reason: reason.slice('--reason='.length),
        confirm,
        now: new Date(),
      });

      console.log(
        confirm ? '[purge]' : '[purge-dry-run]',
        JSON.stringify(manifest),
      );

      return;
    }

    if (
      (command !== 'sync' && command !== 'signals') ||
      sourceSlug === undefined ||
      scopes.length === 0
    ) {
      console.error(
        'usage: market-graph.cli.js <sync|signals> <source> <scope>... | sources | purge <source> --reason=<code> [--confirm]',
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
