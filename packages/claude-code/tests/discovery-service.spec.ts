import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { ClaudeCodeService } from '../src/service.ts'
import type { CcDiscoverySource, CcSessionId } from '../src/index.ts'
import { createFakeBackend } from './fake-backend.ts'

/**
 * The discovery coordinator.
 *
 * Three properties: the default scope stays free (it must not touch a source,
 * so today's callers pay nothing), a failing or slow source degrades to a
 * warning instead of an exception (a sleeping laptop must not break the list —
 * design P6), and results are cached for the configured TTL.
 */

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
})
