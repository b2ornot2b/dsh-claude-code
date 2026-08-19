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

  it('warns and skips a row missing sessionId, instead of silently dropping it', () => {
    // A silently-dropped row is indistinguishable from "nothing was there" —
    // exactly the ambiguity this whole branch exists to eliminate (an empty
    // list with zero warnings must never happen when the probe actually saw
    // something it could not parse).
    const raw = JSON.stringify({
      schema: PROBE_SCHEMA_MAJOR,
      host: 'b2umini',
      generatedAt: 1,
      live: [{ cwd: '/tmp', liveness: 'assumed' }],
      resumable: [{ cwd: '/tmp', lastModified: 1 }],
    })

    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('b2umini')
    expect(result.warnings.join('\n')).toContain('live row missing sessionId')
    expect(result.warnings.join('\n')).toContain('resumable row missing sessionId')
  })

  it('refuses an unknown schema major with a warning and no sessions', () => {
    const raw = JSON.stringify({ schema: 99, host: 'b2umini', generatedAt: 1, live: [], resumable: [] })

    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.sessions).toEqual([])
    expect(result.warnings.join('\n')).toContain('schema 99')
    expect(result.warnings.join('\n')).toContain(String(PROBE_SCHEMA_MAJOR))
  })

  it('warns with a bounded excerpt when the output is not JSON', () => {
    // Comfortably longer than the 200-character excerpt bound, so truncation
    // is actually exercised — a build with no truncation at all would fail
    // this, where a short fixture would not have caught it.
    const raw = `bash: claude-inventory: No such file or directory\n${'z'.repeat(300)}`
    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.sessions).toEqual([])
    const warning = result.warnings.join('\n')
    expect(warning).toContain('No such file')
    // The excerpt ends EXACTLY at the 200-character boundary: the 200-char
    // prefix is present, the 201-char prefix (and therefore the full
    // 351-character raw stream) is not.
    expect(warning).toContain(raw.trim().slice(0, 200))
    expect(warning).not.toContain(raw.trim().slice(0, 201))
  })

  it('reports no title for a live row that carries no name', () => {
    // Mirrors the probe's --no-titles behaviour: when the probe withholds
    // `name` (design §12's includeTitles control), the parser must not
    // invent a title from anywhere else.
    const raw = JSON.stringify({
      schema: PROBE_SCHEMA_MAJOR,
      host: 'b2umini',
      generatedAt: 1,
      live: [{
        sessionId: '889cd0f8-30f5-4469-b63a-086d93cbb047',
        pid: 3796, cwd: '/Users/b2/Developer/mine/grigios',
        kind: 'interactive', liveness: 'assumed',
      }],
      resumable: [],
    })

    const result = parseProbeOutput(raw, CONTEXT)

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.title).toBeUndefined()
  })

  it('translates a live cwd through the path map, preserving the original as remoteCwd', () => {
    // Every other case in this file uses an empty pathMap, which exercises
    // parseProbeOutput only in the "nothing to translate" branch. This case
    // proves translation is actually WIRED IN, not just correct in isolation
    // (translatePath has its own full coverage in paths.spec.ts).
    const context = {
      sourceId: 'mesh:b2umini',
      host: 'b2umini',
      pathMap: [{ from: '/System/Volumes/Data/mnt/b2', to: '/Users/b2' }],
    }
    const raw = JSON.stringify({
      schema: PROBE_SCHEMA_MAJOR,
      host: 'b2umini',
      generatedAt: 1,
      live: [{
        sessionId: '889cd0f8-30f5-4469-b63a-086d93cbb047',
        pid: 3796, cwd: '/System/Volumes/Data/mnt/b2/Developer/mine/grigios',
        liveness: 'assumed',
      }],
      resumable: [],
    })

    const result = parseProbeOutput(raw, context)

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.cwd).toBe('/Users/b2/Developer/mine/grigios')
    expect(result.sessions[0]?.remoteCwd).toBe('/System/Volumes/Data/mnt/b2/Developer/mine/grigios')
  })
})
