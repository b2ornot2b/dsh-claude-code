import { defineConfig } from 'vitest/config'

/**
 * Root test configuration, split into two projects because they deliberately
 * resolve this repo's packages on DIFFERENT planes:
 *
 * - `unit` — every package's own specs under `packages/<pkg>/tests`, run
 *   against TypeScript SOURCES. `tsconfig.base.json` maps every
 *   `@deepseek-ai/dsh-claude-code*` specifier to that package's `src/index.ts`
 *   and Vite's built-in `resolve.tsconfigPaths` honors it, so a stale `lib/`
 *   can never shadow the code under test (harness testing policy, "test
 *   resolution: source plane only" — a second copy of a module singleton there
 *   breaks cordis service resolution).
 *
 * - `composition` — the Phase 1 acceptance test under `tests/composition`,
 *   which boots a real `cordis.yml` through the cordis Loader. The Loader lives
 *   in `node_modules` (vitest externalizes it), so its dynamic `import()` of
 *   each row's package specifier resolves natively, to the packages' BUILT
 *   `lib/index.js`. That is the point: it exercises the published entry points,
 *   `exports` maps, `inject` lists and `Config` schemas. `pnpm run test` builds
 *   first for exactly this reason, and the spec imports no package VALUE from
 *   either plane so the two never meet in one process.
 *
 * Both projects are offline: no Claude Code session is ever opened.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { tsconfigPaths: true },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/tests/**/*.spec.ts'],
          // spikes/ is an independent npm project with its own node_modules:
          // Phase 0 probe scripts, not tests.
          exclude: ['**/node_modules/**', 'spikes/**'],
        },
      },
      {
        test: {
          name: 'composition',
          environment: 'node',
          include: ['tests/composition/**/*.spec.ts'],
          exclude: ['**/node_modules/**', 'spikes/**'],
        },
      },
    ],
  },
})
