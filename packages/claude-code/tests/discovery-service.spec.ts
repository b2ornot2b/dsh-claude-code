import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { ClaudeCodeService } from '../src/service.ts'
import type { CcDiscoverySource, CcSessionId } from '../src/index.ts'
import { createFakeBackend } from './fake-backend.ts'

/**
 * The discovery coordinator.
 *
 * Four properties: the default scope stays free (it must not touch a source,
 * so today's callers pay nothing), a rejecting OR a hanging source degrades to
 * a warning instead of blocking `discover()` forever (a sleeping laptop must
 * not break the list — design P6), results are cached for the configured TTL
 * with the composed group deduped on every read (cached or not), and scope
 * filtering only ever widens what is consulted, never what is returned.
 */

/** An absolute directory that certainly exists — `open()` validates `cwd` before anything spawns. */
const CWD = tmpdir()

/**
 * Mount a service with a fake backend and no real local source.
 * @param config - configuration overrides.
 * @returns the context and service.
 */
function mount(config: Record<string, unknown> = {}): {
  ctx: Context, service: ClaudeCodeService,
} {
  const ctx = new Context()
  const { backend } = createFakeBackend()
  const service = new ClaudeCodeService(
    ctx, { prewarm: false, hostLabel: 'b2studio', ...config },
    { backend, wireLocalSource: false },
  )
  return { ctx, service }
}

/**
 * A source that answers with one session.
 * @param id - the source id.
 * @param host - the host label.
 * @returns the source and its call counter.
 */
function countingSource(id: string, host: string): {
  source: CcDiscoverySource, calls: () => number,
} {
  let calls = 0
  return {
    calls: () => calls,
    source: {
      id,
      host,
      discover: async (request) => {
        calls += 1
        return Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          sessions: [{
            sessionId: `0000000${calls}-0000-4000-8000-000000000000` as CcSessionId,
            origin: 'live-external' as const,
            host,
            sourceId: id,
            cwd: '/tmp',
            lastActivityAt: request.now - 1_000,
            sendable: false,
            resumable: true,
            fidelity: 'probe' as const,
            live: { liveness: 'assumed' as const },
          }],
        })
      },
    },
  }
}

describe('ClaudeCodeService.discover', () => {
  it('does not touch any source at the default composition scope', async () => {
    const { service } = mount()
    const counting = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(counting.source)

    const result = await service.discover()

    expect(result.sessions).toEqual([])
    expect(counting.calls()).toBe(0)
  })

  it('queries sources at mesh scope and caches for the TTL', async () => {
    // The positive caching case round 2's keyed cache must not regress: the
    // SAME request shape (scope + includeResumable) called twice inside the
    // TTL consults the source once and reports `cached: true` the second
    // time — proving the key doesn't just disable caching altogether.
    const { service } = mount({ discovery: { cacheTtlMs: 60_000 } })
    const counting = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(counting.source)

    // Asserted between each call, not after all three: every `discover()`
    // below fully resolves before the next statement runs, so checking the
    // call count only at the end would observe the SAME final value twice —
    // it could never demonstrate that the second call was a cache hit and
    // the third was not.
    const first = await service.discover({ scope: 'mesh' })
    expect(first.sessions).toHaveLength(1)
    expect(counting.calls()).toBe(1)

    const second = await service.discover({ scope: 'mesh' })
    expect(second.cached).toBe(true)
    expect(counting.calls()).toBe(1)

    const forced = await service.discover({ scope: 'mesh', refresh: true })
    expect(forced.cached).toBe(false)
    expect(counting.calls()).toBe(2)
  })

  it('turns a rejecting source into a warning and still returns', async () => {
    const { service } = mount()
    service.registerDiscoverySource({
      id: 'mesh:b2hx',
      host: 'b2hx',
      discover: async () => Promise.reject(new Error('unreachable (ssh connect timeout)')),
    })
    const healthy = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(healthy.source)

    const result = await service.discover({ scope: 'mesh' })

    expect(result.warnings.join('\n')).toContain('b2hx')
    expect(result.warnings.join('\n')).toContain('unreachable')
    expect(result.sessions).toHaveLength(1)
  })

  it('stops consulting a source after its disposer runs', async () => {
    const { service } = mount({ discovery: { cacheTtlMs: 1 } })
    const counting = countingSource('mesh:b2umini', 'b2umini')
    const dispose = service.registerDiscoverySource(counting.source)

    await service.discover({ scope: 'mesh', refresh: true })
    dispose()
    const after = await service.discover({ scope: 'mesh', refresh: true })

    expect(counting.calls()).toBe(1)
    expect(after.sessions).toEqual([])
  })

  it('bounds a source that never settles at all, instead of hanging forever', async () => {
    // A rejection is already covered above. This is the failure mode that
    // does NOT cover: a source whose promise never resolves NOR rejects — a
    // stuck SSH connect, a wedged child process. `sourceTimeoutMs` is set
    // small (not the real 30s default) so this test proves the bound without
    // actually waiting anywhere near that long.
    const { service } = mount({ discovery: { sourceTimeoutMs: 20 } })
    service.registerDiscoverySource({
      id: 'mesh:b2hx',
      host: 'b2hx',
      discover: async () => new Promise(() => {}), // deliberately never settles
    })
    const healthy = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(healthy.source)

    const startedAt = Date.now()
    const result = await service.discover({ scope: 'mesh' })
    const elapsedMs = Date.now() - startedAt

    // Generous relative to the 20ms deadline, but nowhere near "it hung":
    // proves the coordinator returned instead of waiting out a real 30s+ hang.
    expect(elapsedMs).toBeLessThan(2_000)
    expect(result.warnings.join('\n')).toContain('b2hx')
    expect(result.warnings.join('\n')).toContain('20ms')
    // The other, healthy source still answered — one hung host must not
    // delay (or drop) anyone else's results.
    expect(result.sessions).toHaveLength(1)
    expect(healthy.calls()).toBe(1)
  })

  it('a stale disposer never removes a same-id registration that replaced it', async () => {
    const first = countingSource('mesh:b2umini', 'b2umini')
    const { service } = mount()
    const disposeFirst = service.registerDiscoverySource(first.source)

    // Same id, a second registration — the documented "duplicate id replaces
    // its predecessor" behavior.
    const second = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(second.source)

    // The FIRST registration's disposer, called after it was already
    // replaced. It must be a no-op: it does not know about — and must not
    // evict — the second registration now sitting at that id.
    disposeFirst()

    const result = await service.discover({ scope: 'mesh' })

    expect(first.calls()).toBe(0)
    expect(second.calls()).toBe(1)
    expect(result.sessions).toHaveLength(1)
  })

  it('dedupes a session that is both composed and externally reported, even on a cache hit', async () => {
    const { service } = mount({ discovery: { cacheTtlMs: 60_000 } })
    const opened = await service.open({ cwd: CWD })

    // A mesh source reports the SAME session id this composition already
    // opened — the real-world case: a session opened here also has an
    // on-disk registry file and transcript another source can see.
    const source: CcDiscoverySource = {
      id: 'mesh:b2umini',
      host: 'b2umini',
      discover: async request => Promise.resolve({
        generatedAt: request.now,
        cached: false,
        warnings: [],
        sessions: [{
          sessionId: opened.id,
          origin: 'live-external' as const,
          host: 'b2umini',
          sourceId: 'mesh:b2umini',
          cwd: opened.cwd,
          lastActivityAt: request.now - 1_000,
          sendable: false,
          resumable: true,
          fidelity: 'probe' as const,
          live: { liveness: 'assumed' as const },
        }],
      }),
    }
    service.registerDiscoverySource(source)

    const first = await service.discover({ scope: 'mesh' })
    const firstMatches = first.sessions.filter(session => session.sessionId === opened.id)
    expect(firstMatches).toHaveLength(1)
    expect(firstMatches[0]?.origin).toBe('composed')

    // Second call inside the TTL: a cache hit. Amendment 2's whole point —
    // the id must still appear exactly once, as the composed (higher
    // fidelity, sendable) copy, not twice.
    const second = await service.discover({ scope: 'mesh' })
    expect(second.cached).toBe(true)
    const secondMatches = second.sessions.filter(session => session.sessionId === opened.id)
    expect(secondMatches).toHaveLength(1)
    expect(secondMatches[0]?.origin).toBe('composed')
  })

  it('scope host consults only same-host sources; scope mesh consults every host', async () => {
    const { service } = mount()
    const same = countingSource('local:b2studio', 'b2studio')
    const other = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(same.source)
    service.registerDiscoverySource(other.source)

    // No `refresh: true` here (round 2): now that the cache is keyed by
    // `scope` + `includeResumable`, a `host` call followed by a `mesh` call
    // are different cache entries by construction, so this test proves scope
    // filtering AND incidentally exercises that the two scopes never collide
    // in the cache — see the dedicated regression test below for that
    // specifically.
    const hostResult = await service.discover({ scope: 'host' })
    expect(same.calls()).toBe(1)
    expect(other.calls()).toBe(0)
    expect(hostResult.sessions.map(session => session.host)).toEqual(['b2studio'])

    const meshResult = await service.discover({ scope: 'mesh' })
    expect(same.calls()).toBe(2)
    expect(other.calls()).toBe(1)
    expect(meshResult.sessions.map(session => session.host).sort()).toEqual(['b2studio', 'b2umini'])
  })

  it('never serves a scope: "host" cache entry to a scope: "mesh" call (round 2 regression)', async () => {
    // The bug: `discoveryCache` used to be a single slot shared across every
    // scope. A `scope: 'host'` result could be served back as a cache hit to
    // this SECOND, WIDER `scope: 'mesh'` call — reporting `cached: true` and
    // never consulting the mesh-only source, while the caller believes it
    // asked about (and got an answer for) the whole mesh. Both calls below
    // land well inside the TTL and neither passes `refresh: true`: against
    // the single-slot implementation this test fails (`meshResult.cached`
    // would read `true` and `other.calls()` would stay `0`).
    const { service } = mount({ discovery: { cacheTtlMs: 60_000 } })
    const same = countingSource('local:b2studio', 'b2studio')
    const other = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(same.source)
    service.registerDiscoverySource(other.source)

    const hostResult = await service.discover({ scope: 'host' })
    expect(hostResult.cached).toBe(false)
    expect(same.calls()).toBe(1)
    expect(other.calls()).toBe(0)

    const meshResult = await service.discover({ scope: 'mesh' })
    expect(meshResult.cached).toBe(false)
    expect(other.calls()).toBe(1)
    expect(meshResult.sessions.map(session => session.host).sort()).toEqual(['b2studio', 'b2umini'])
  })

  it('never serves an includeResumable: false cache entry to an includeResumable: true call', async () => {
    const { service } = mount({ discovery: { cacheTtlMs: 60_000 } })
    let calls = 0
    let lastIncludeResumable: boolean | undefined
    const source: CcDiscoverySource = {
      id: 'mesh:b2umini',
      host: 'b2umini',
      discover: async (request) => {
        calls += 1
        lastIncludeResumable = request.includeResumable
        return Promise.resolve({
          generatedAt: request.now,
          cached: false,
          warnings: [],
          // The fixture only ever reports a session when resumables were
          // actually asked for, so a suppressed-vs-included mixup is
          // observable in the result, not just in the request the fixture saw.
          sessions: request.includeResumable
            ? [{
                sessionId: 'aaaaaaaa-0000-4000-8000-000000000000' as CcSessionId,
                origin: 'resumable' as const,
                host: 'b2umini',
                sourceId: 'mesh:b2umini',
                cwd: '/tmp',
                lastActivityAt: request.now - 1_000,
                sendable: false,
                resumable: true,
                fidelity: 'probe' as const,
              }]
            : [],
        })
      },
    }
    service.registerDiscoverySource(source)

    const suppressed = await service.discover({ scope: 'mesh', includeResumable: false })
    expect(suppressed.cached).toBe(false)
    expect(calls).toBe(1)
    expect(lastIncludeResumable).toBe(false)
    expect(suppressed.sessions).toHaveLength(0)

    // Same TTL, same scope, DIFFERENT includeResumable — must not be served
    // the suppressed result from the call above.
    const withResumable = await service.discover({ scope: 'mesh', includeResumable: true })
    expect(withResumable.cached).toBe(false)
    expect(calls).toBe(2)
    expect(lastIncludeResumable).toBe(true)
    expect(withResumable.sessions).toHaveLength(1)
  })

  it('surfaces a RESOLVING source\'s own warnings, not just a thrown one\'s', async () => {
    // The bug this test exists to catch: a source never throws — it reports
    // failure by resolving with `{ sessions: [], warnings: [...] }`. The old
    // code kept only `result.sessions` and threw `result.warnings` away,
    // recording a warning only when a source REJECTED — the one path a
    // well-behaved source never takes. Against the unfixed code this
    // assertion fails with `result.warnings` empty.
    const { service } = mount()
    service.registerDiscoverySource({
      id: 'mesh:b2mini',
      host: 'b2mini',
      discover: async request => Promise.resolve({
        generatedAt: request.now,
        cached: false,
        warnings: ['b2mini: Command failed: ssh b2mini.local true (exit 255)'],
        sessions: [],
      }),
    })

    const result = await service.discover({ scope: 'mesh' })

    expect(result.warnings).toContain('b2mini: Command failed: ssh b2mini.local true (exit 255)')
    expect(result.sessions).toHaveLength(0)
  })

  it('mixes a healthy source, a warning-but-no-sessions source, and a rejecting source in one call', async () => {
    const { service } = mount()
    const healthy = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(healthy.source)
    service.registerDiscoverySource({
      id: 'mesh:b2mini',
      host: 'b2mini',
      discover: async request => Promise.resolve({
        generatedAt: request.now,
        cached: false,
        warnings: ['b2mini: never received the probe file'],
        sessions: [],
      }),
    })
    service.registerDiscoverySource({
      id: 'mesh:b2hx',
      host: 'b2hx',
      discover: async () => Promise.reject(new Error('powered off')),
    })

    const result = await service.discover({ scope: 'mesh' })

    expect(result.warnings).toHaveLength(2)
    expect(result.warnings).toContain('b2mini: never received the probe file')
    expect(result.warnings.some(warning => warning.includes('b2hx') && warning.includes('powered off')))
      .toBe(true)
    // The healthy source's sessions still come back — one degraded source
    // (thrown or resolved) must not cost the others their results.
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.host).toBe('b2umini')
  })

  it('orders the aggregate warnings by source registration order, not by settle order', async () => {
    // Deliberately settle OUT of registration order (b2hx first, b2umini
    // last) so this test would fail against a shared-array-push
    // implementation, where the aggregate order follows completion order
    // instead of `sources` iteration order.
    const { service } = mount()
    const delay = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    service.registerDiscoverySource({
      id: 'mesh:b2umini',
      host: 'b2umini',
      discover: async (request) => {
        await delay(30)
        return {
          generatedAt: request.now, cached: false, warnings: ['b2umini: slow to answer'], sessions: [],
        }
      },
    })
    service.registerDiscoverySource({
      id: 'mesh:b2mini',
      host: 'b2mini',
      discover: async (request) => {
        await delay(15)
        return {
          generatedAt: request.now, cached: false, warnings: ['b2mini: slower to answer'], sessions: [],
        }
      },
    })
    service.registerDiscoverySource({
      id: 'mesh:b2hx',
      host: 'b2hx',
      discover: async (request) => {
        await delay(0)
        return { generatedAt: request.now, cached: false, warnings: ['b2hx: fastest to answer'], sessions: [] }
      },
    })

    const result = await service.discover({ scope: 'mesh' })

    // Registration order above: b2umini, b2mini, b2hx — the OPPOSITE of
    // settle order (b2hx settles first, b2umini last).
    expect(result.warnings).toEqual([
      'b2umini: slow to answer',
      'b2mini: slower to answer',
      'b2hx: fastest to answer',
    ])
  })

  it('a cache hit replays the warnings from the call that populated it', async () => {
    const { service } = mount({ discovery: { cacheTtlMs: 60_000 } })
    service.registerDiscoverySource({
      id: 'mesh:b2mini',
      host: 'b2mini',
      discover: async request => Promise.resolve({
        generatedAt: request.now,
        cached: false,
        warnings: ['b2mini: Command failed: ssh …'],
        sessions: [],
      }),
    })

    const first = await service.discover({ scope: 'mesh' })
    expect(first.cached).toBe(false)
    expect(first.warnings).toEqual(['b2mini: Command failed: ssh …'])

    const second = await service.discover({ scope: 'mesh' })
    expect(second.cached).toBe(true)
    expect(second.warnings).toEqual(['b2mini: Command failed: ssh …'])
  })

  it('registering a new source invalidates the cache, even for an already-cached request shape', async () => {
    const { service } = mount({ discovery: { cacheTtlMs: 60_000 } })
    const first = countingSource('mesh:b2umini', 'b2umini')
    service.registerDiscoverySource(first.source)

    const cached = await service.discover({ scope: 'mesh' })
    expect(cached.cached).toBe(false)
    expect(first.calls()).toBe(1)

    // A DIFFERENT id, so both sources stay registered — this is about the
    // source SET changing, not a same-id replacement (covered elsewhere).
    const second = countingSource('mesh:b2hx', 'b2hx')
    service.registerDiscoverySource(second.source)

    // Still well inside the TTL. If registration only invalidated whatever
    // slot happened to be "current" (or nothing at all), this would read
    // `cached: true` and the new source would never be consulted.
    const afterRegister = await service.discover({ scope: 'mesh' })
    expect(afterRegister.cached).toBe(false)
    expect(second.calls()).toBe(1)
    expect(afterRegister.sessions).toHaveLength(2)
  })
})
