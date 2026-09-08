import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/*
 * The database tier.
 *
 * Split from the hermetic suite because these tests need a real Postgres,
 * and they need one for a reason that no double can substitute for: the
 * two things they prove - a purge's atomicity under RESTRICT and CASCADE,
 * and a five-table nested filter reproducing a signal's population - ARE
 * the database's semantics. An in-memory double would have to reimplement
 * foreign keys, cascade order and rollback faithfully to prove anything,
 * and its FK graph would be hand-transcribed from schema.prisma with
 * nothing checking the transcription. It would prove the double.
 *
 * The existing double (integrations/test-doubles.ts) makes the point
 * itself: its $transaction is a passthrough with no rollback, so "a failed
 * purge leaves no partial state" would pass against an implementation with
 * no transaction at all.
 *
 * Run with: pnpm test:db  (needs MARKET_TEST_DATABASE_URL)
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/market-graph/**/*.db.spec.ts'],
    /* One database, shared truncation - these must not interleave. */
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
