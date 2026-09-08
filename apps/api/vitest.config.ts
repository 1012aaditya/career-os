import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    /*
     * The database tier runs under vitest.config.db.ts. Excluded here so
     * `pnpm test` stays hermetic and needs no Postgres, and so a missing
     * test database cannot turn into a silently skipped guarantee.
     */
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.spec.ts'],
  },
});
