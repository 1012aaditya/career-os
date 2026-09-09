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
    /*
     * Widened from test/market-graph/** in PR-2. The database tier is not
     * a market-graph tier - it is the tier for anything whose correctness
     * IS the database's behaviour, and a row lock serialising two
     * concurrent import creations is exactly that. A double has no rows
     * and no locks, so it can only prove the lock is requested; only a
     * real Postgres proves it works.
     */
    include: ['test/**/*.db.spec.ts'],
    /*
     * One database, shared truncation - these must not interleave.
     *
     * `fileParallelism: false` alone did not achieve that, and Phase 11
     * found out the way these things are always found out: adding a
     * fourth file made a fifth test fail, intermittently, in the middle
     * of a file whose own setup was fine. Tests 1-41 of the search tier
     * passed, test 42 saw a corpus with no skills in it, and tests 43-46
     * passed again - which is not a bug in any of them. It is another
     * file's `TRUNCATE ... CASCADE` landing mid-run.
     *
     * So the single fork is pinned explicitly rather than implied. The
     * tier is a few seconds long and shares one database; there is
     * nothing to gain from concurrency here and one whole class of
     * phantom failure to lose.
     */
    fileParallelism: false,
    pool: 'forks',
    /* Vitest 4 moved the fork options to the top level; `poolOptions` is
     * gone and passing it is a no-op that only prints a deprecation. */
    isolate: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
