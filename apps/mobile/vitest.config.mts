import { defineConfig } from 'vitest/config';

/*
 * Tests for the Career Graph projection modules.
 *
 * Deliberately scoped to src/career. Those seven modules are pure
 * TypeScript — they import each other and, from the API client, only
 * `import type`, which is erased before it reaches the runtime. So they run
 * in plain Node with no React Native transform, no jest-expo preset and no
 * native mocking, and the suite stays fast enough to run on every change.
 *
 * Screens are out of scope here for the same reason: rendering one would
 * pull in React Native and require a whole harness to test what is mostly
 * layout. What the screens depend on for correctness — ordering,
 * provenance, career state — lives in these modules and is tested directly.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/career/**/*.test.ts',
      'src/github/**/*.test.ts',
      /*
       * Market Search's presentation logic. Pure for the same reason the
       * others are: it decides what a result SAYS - what a missing
       * employer renders as, what an UNAVAILABLE freshness verdict is
       * allowed to be called - and those are claims, not layout.
       */
      'src/market/**/*.test.ts',
      /*
       * Session persistence. Pure for the same reason the others are: it
       * decides how a value is split, reassembled and cleared, and each of
       * those is a claim about correctness rather than about layout. Its
       * one native dependency, expo-secure-store, is mocked - what is
       * under test is the chunking, not the Keychain.
       */
      'src/lib/**/*.test.ts',
      /*
       * PR-4. The request policy, the 401 latch, the deletion flows and
       * the resume list are pure for the same reason everything else here
       * is: they decide what happens, and the screens only render it. That
       * split is what makes "a second press must not send a second DELETE"
       * a testable claim rather than something you check by tapping fast.
       */
      'src/api/**/*.test.ts',
      'src/account/**/*.test.ts',
      'src/resume/**/*.test.ts',
      'src/screens/**/*.test.ts',
    ],
  },
});
