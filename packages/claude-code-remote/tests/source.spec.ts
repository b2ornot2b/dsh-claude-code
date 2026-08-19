import { describe, expect, it } from 'vitest'

import { createProbeSource } from '../src/source.ts'

/**
 * These three specs drive `createProbeSource` WITHOUT a fake `run`, so the
 * default `runArgv` really shells out to `node:child_process.execFile`. A
 * fake `run` cannot exercise the bug this branch guards against — the
 * duplication comes entirely from how Node's real `execFile` populates
 * `error.message`, which no fake reproduces. `sh -c` is not available on
 * Windows, so the block is skipped there rather than substituted with a
 * `cmd.exe` equivalent that would test a different code path.
 */

/** The probe runner: an argv, a deadline, and a parser. Never a thrown error. */

const REQUEST = {
  now: 1_787_128_000_000, includeResumable: true, recentWindowMs: 604_800_000,
  maxResumable: 50, includeTitles: true,
}

describe('createProbeSource', () => {
  it('passes request options through to the probe argv', async () => {
    const seen: string[][] = []
    const source = createProbeSource({
      id: 'mesh:b2umini', host: 'b2umini', timeoutMs: 6_000,
      argv: ['ssh', 'b2umini.local', '~/infra/scripts/claude-inventory'],
      run: async (argv) => {
        seen.push([...argv])
        return Promise.resolve({ stdout: JSON.stringify({
          schema: 1, host: 'b2umini', generatedAt: REQUEST.now, live: [], resumable: [],
        }), stderr: '' })
      },
    })

    await source.discover(REQUEST)

    expect(seen[0]).toContain('--max-resumable')
    expect(seen[0]).toContain('50')
    expect(seen[0]).toContain('--window-ms')
    expect(seen[0]).not.toContain('--no-titles')
  })

  it('adds --no-titles when titles are not wanted', async () => {
    const seen: string[][] = []
    const source = createProbeSource({
      id: 'mesh:b2umini', host: 'b2umini', timeoutMs: 6_000,
      argv: ['ssh', 'b2umini.local', '~/infra/scripts/claude-inventory'],
      run: async (argv) => {
        seen.push([...argv])
        return Promise.resolve({ stdout: JSON.stringify({
          schema: 1, host: 'b2umini', generatedAt: REQUEST.now, live: [], resumable: [],
        }), stderr: '' })
      },
    })

    await source.discover({ ...REQUEST, includeTitles: false })

    expect(seen[0]).toContain('--no-titles')
  })

  it('reports a failed run as a warning, not a rejection', async () => {
    const source = createProbeSource({
      id: 'mesh:b2hx', host: 'b2hx', timeoutMs: 100,
      argv: ['ssh', 'b2hx.local', '~/infra/scripts/claude-inventory'],
      run: async () => Promise.reject(new Error('ssh: connect to host b2hx.local port 22: Operation timed out')),
    })

    const result = await source.discover(REQUEST)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('b2hx')
    expect(result.warnings.join('\n')).toContain('Operation timed out')
  })

  describe.skipIf(process.platform === 'win32')('against the real execFile runner', () => {
    it('states a non-zero exit with stderr exactly once', async () => {
      const source = createProbeSource({
        id: 'mesh:real', host: 'real', timeoutMs: 5_000,
        // The marker is split across two printf args so it is NOT a
        // contiguous substring of the command line itself (which execFile
        // also folds into error.message) — only the concatenated stderr
        // output contains the full marker, so a single unambiguous
        // occurrence in the composed warning proves de-duplication and not
        // an accidental match against the echoed command.
        argv: ['sh', '-c', 'printf "%s%s\\n" "DSH_PROBE_MARKER" "_NONZERO" 1>&2; exit 7'],
      })

      const result = await source.discover(REQUEST)

      const warning = result.warnings.join('\n')
      const occurrences = warning.split('DSH_PROBE_MARKER_NONZERO').length - 1
      expect(occurrences).toBe(1)
      // No leftover ": " artifact from appending stderr that was already
      // embedded by execFile's own "Command failed: …\n<stderr>" message.
      expect(warning).not.toMatch(/:\s*\n/)
    })

    it('still produces a useful message when a timeout kill leaves stderr empty', async () => {
      const source = createProbeSource({
        id: 'mesh:real', host: 'real', timeoutMs: 100,
        argv: ['sh', '-c', 'sleep 5'],
      })

      const result = await source.discover(REQUEST)

      const warning = result.warnings.join('\n')
      expect(warning).toContain('real')
      // "real: " plus nothing would mean the kill produced no information.
      expect(warning.replace('real:', '').trim().length).toBeGreaterThan(0)
    })

    it('surfaces stderr that execFile does not fold into an abort error message', async () => {
      const controller = new AbortController()
      const source = createProbeSource({
        id: 'mesh:real', host: 'real', timeoutMs: 5_000,
        argv: ['sh', '-c', 'echo DSH_PROBE_MARKER_ABORT 1>&2; sleep 5'],
      })
      setTimeout(() => controller.abort(), 150)

      const result = await source.discover({ ...REQUEST, signal: controller.signal })

      const warning = result.warnings.join('\n')
      const occurrences = warning.split('DSH_PROBE_MARKER_ABORT').length - 1
      expect(occurrences).toBe(1)
    })
  })
})
