import { describe, expect, it } from 'vitest'

import { createProbeSource } from '../src/source.ts'

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
})
