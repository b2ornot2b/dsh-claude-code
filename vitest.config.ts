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
 * - `examples` — Stage 2's E2E acceptance spec for `examples/delegation-demo`.
 *   It imports no package from either plane at all: it spawns `run.mjs` as a
 *   real Node subprocess (which itself boots a `cordis.yml` through the
 *   Loader, same as `composition`) and asserts on its exit code and stdout.
 *   Unlike the other two, this project is NOT offline — every spec in it is
 *   gated `describe.skipIf(!LIVE)` behind `DSH_CC_LIVE=1`, exactly like the
 *   `tests/live/` suites under each package.
 *
 * `unit` and `composition` are offline: no Claude Code session is ever
 * opened. `examples` only runs anything when `DSH_CC_LIVE=1` is set.
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
      {
        test: {
          name: 'examples',
          environment: 'node',
          include: ['examples/**/*.spec.ts'],
          exclude: ['**/node_modules/**', 'spikes/**'],
        },
      },
    ],
  },
})
