import { describe, expect, it } from 'vitest'

import { parseProbeOutput, PROBE_SCHEMA_MAJOR } from '../src/parse.ts'

/**
 * The probe-output parser.
 *
 * Schema versioning is not ceremony here: Syncthing propagates the probe to
 * every host in seconds, while the dsh profile's copy of this plugin only
 * changes when the installer runs. The two WILL disagree, and that must be a
 * named warning rather than a crash (spec §5.4).
 */

const CONTEXT = { sourceId: 'mesh:b2umini', host: 'b2umini', pathMap: [] }

describe('parseProbeOutput', () => {
  it('maps live and resumable rows onto discovered sessions', () => {
    const raw = JSON.stringify({
      schema: PROBE_SCHEMA_MAJOR,
      host: 'b2umini',
      generatedAt: 1_787_128_000_000,
      home: '/Users/b2',
      live: [{
        sessionId: '889cd0f8-30f5-4469-b63a-086d93cbb047',
        pid: 3796, cwd: '/Users/b2/Developer/mine/grigios',
        name: 'grigios-cb', kind: 'interactive', startedAt: 1_786_611_479_355,
        version: '2.1.220', liveness: 'assumed',
      }],
      resumable: [{
        sessionId: '43bc3d80-fb06-4f6e-805f-f3eeff272690',
        cwd: '/Users/b2/Developer/mine/grigios', title: 'fix the thing',
        gitBranch: 'main', lastModified: 1_787_000_000_000, sizeBytes: 1234,
      }],
      warnings: ['/Users/b2/.claude/projects/x: unreadable'],
    })

    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.generatedAt).toBe(1_787_128_000_000)
    const live = result.sessions.filter(entry => entry.origin === 'live-external')
    expect(live[0]?.live?.liveness).toBe('assumed')
    expect(live[0]?.sendable).toBe(false)
    expect(live[0]?.fidelity).toBe('probe')
    expect(live[0]?.host).toBe('b2umini')
    expect(result.sessions.filter(entry => entry.origin === 'resumable')).toHaveLength(1)
    // The probe's own warnings survive, prefixed with the host that raised them.
    expect(result.warnings.join('\n')).toContain('b2umini')
    expect(result.warnings.join('\n')).toContain('unreadable')
  })

  it('refuses an unknown schema major with a warning and no sessions', () => {
    const raw = JSON.stringify({ schema: 99, host: 'b2umini', generatedAt: 1, live: [], resumable: [] })

    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('schema 99')
    expect(result.warnings.join('\n')).toContain(String(PROBE_SCHEMA_MAJOR))
  })

  it('warns with a bounded excerpt when the output is not JSON', () => {
    const result = parseProbeOutput('bash: claude-inventory: No such file or directory', CONTEXT)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('No such file')
  })
})
