import { NestFactory } from '@nestjs/core';

import { MarketGraphCoreModule } from './market-graph-core.module.js';
import { MarketIngestionService } from './ingestion/market-ingestion.service.js';
import { MarketVocabularyService } from './ingestion/market-vocabulary.service.js';
import { MarketNormalizationService } from './normalization/market-normalization.service.js';
import { MarketSignalService } from './signals/market-signal.service.js';

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
 *   node dist/market-graph/market-graph.cli.js sync <board> [<board>...]
 *   node dist/market-graph/market-graph.cli.js signals <board> [<board>...]
 */

const DEFAULT_WINDOW_DAYS = 30;

/*
 * The publication floor.
 *
 * A prevalence is not written below thirty eligible postings or two
 * distinct employers. Both numbers are hypotheses to be revised once the
 * real distribution is visible, which is exactly why they are recorded on
 * the signal run rather than left implicit in code: changing them produces
 * a new, comparable snapshot instead of silently changing what an existing
 * number means.
 *
 * The company floor matters more than it looks. It is what stops one
 * employer's board being published as "the market".
 */
const MIN_DENOMINATOR = 30;
const MIN_DISTINCT_COMPANIES = 2;

async function main(): Promise<void> {
  const [command, ...boards] = process.argv.slice(2);

  if (command !== 'sync' && command !== 'signals') {
    console.error('usage: market-graph.cli.js <sync|signals> <board>...');
    process.exitCode = 1;
    return;
  }

  if (boards.length === 0) {
    console.error('at least one board token is required');
    process.exitCode = 1;
    return;
  }

  /*
   * The core module, not AppModule. The pipeline has no business booting
   * the auth stack, and requiring Supabase credentials to run an ingest
   * would be a dependency that exists only because of how the modules were
   * arranged.
   */
  const app = await NestFactory.createApplicationContext(
    MarketGraphCoreModule,
    { logger: ['error', 'warn'] },
  );

  try {
    const vocabulary = app.get(MarketVocabularyService);

    await vocabulary.ensureGreenhouseSource();
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

      const result = await ingestion.ingestGreenhouse({
        boardTokens: boards,
        now,
      });

      console.log(
        '[ingest]',
        JSON.stringify({
          runId: result.runId,
          status: result.status,
          boardsRequested: result.stats.boardsRequested,
          boardsFetched: result.stats.boardsFetched,
          postingsAccepted: result.stats.postingsAccepted,
          postingsRejected: result.stats.postingsRejected,
          duplicatesDropped: result.stats.duplicatesDropped,
          postingsCreated: result.stats.postingsCreated,
          versionsCreated: result.stats.versionsCreated,
          sightingsCreated: result.stats.sightingsCreated,
        }),
      );

      let total = { normalized: 0, mentions: 0, unresolvedRoles: 0 };

      /*
       * Batched to a ceiling and looped, rather than one unbounded query.
       */
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
      sourceSlug: 'greenhouse',
      scopes: boards,
      windowStart,
      windowEnd,
      minDenominator: MIN_DENOMINATOR,
      minDistinctCompanies: MIN_DISTINCT_COMPANIES,
      now,
    });

    console.log(
      '[signals]',
      JSON.stringify({
        runId: computed.runId,
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
