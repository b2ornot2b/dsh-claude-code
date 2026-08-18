/**
 * Stage 2's E2E acceptance spec: run `examples/delegation-demo/run.mjs` as a
 * real subprocess and assert it does what the README promises — exits `0`
 * and leaves behind the file it delegated Claude Code to create, with the
 * exact content asked for. Gated behind `DSH_CC_LIVE=1` like every other live
 * spec in this repo (the demo spawns a real Claude Code subprocess and
 * spends real tokens).
 *
 * Requires `pnpm run build` first — `run.mjs` boots `cordis.yml` through the
 * cordis Loader, which imports each package's BUILT entry point, exactly as
 * `tests/composition/composition.spec.ts` does (and `pnpm run test:live`
 * already builds first, for that reason).
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileP = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))

/** Matches every other live spec's gate in this repo. */
const LIVE = process.env['DSH_CC_LIVE'] === '1'
const LIVE_TIMEOUT_MS = 240_000

describe.skipIf(!LIVE)('examples/delegation-demo (DSH_CC_LIVE=1)', () => {
  it(
    'runs to completion (exit 0) and creates the file it delegated to Claude Code',
    async () => {
      const workDir = mkdtempSync(path.join(tmpdir(), 'dsh-cc-demo-live-'))
      try {
        const { stdout, stderr } = await execFileP(
          process.execPath,
          [path.join(here, 'run.mjs'), '--cwd', workDir],
          { timeout: LIVE_TIMEOUT_MS },
        )

        // The script prefixes every line it prints with `[demo]`; asserting
        // on the printed outcome (not just that execFile didn't throw) is
        // what catches a script that exits 0 having silently swallowed a
        // failure — `main()`'s own `.catch` sets a non-zero `exitCode`, which
        // execFile WOULD surface as a rejection, but this is the belt to that
        // braces.
        expect(stdout).toContain('[demo] done.')
        expect(stdout).not.toContain('done, with errors.')
        expect(stdout).toContain('mirrored session event-type timeline')
        expect(stdout).toContain('turn/end')
        if (stderr.trim() !== '') {
          // Not a hard failure by itself (Node may warn on stderr for
          // reasons unrelated to this script), but worth seeing if the test
          // ever does fail.
          console.warn('[run.live.spec.ts] demo stderr was non-empty:', stderr)
        }

        const targetPath = path.join(workDir, 'hello-from-claude-code.txt')
        expect(existsSync(targetPath)).toBe(true)
        expect(readFileSync(targetPath, 'utf8')).toBe(
          'Hello from Claude Code, delegated by a DeepSeek agent.\n')
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
