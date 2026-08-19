import { describe, expect, it } from 'vitest'

import {
  groupByOrigin, mergeDiscovered, normalizeSourceClock, projectComposed,
} from '../src/discovery.ts'
import type { CcDiscoveredSession, CcDiscoveryResult, CcSessionId } from '../src/index.ts'

/**
 * The discovery merge — pure, clock-injected, and the only place the three
 * origins meet. Two properties matter most: a session reported by several
 * sources appears once at its highest fidelity, and a source with a skewed
 * clock cannot produce a session that has been open for a negative time.
 */

const NOW = 1_787_128_000_000

/**
 * Build a discovered session.
 * @param over - fields to override.
 * @returns the session.
 */
function discovered(over: Partial<CcDiscoveredSession>): CcDiscoveredSession {
  return {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as CcSessionId,
    origin: 'resumable',
    host: 'b2umini',
    sourceId: 'mesh:b2umini',
    cwd: '/Users/b2/Developer/mine/b2infra',
    lastActivityAt: NOW - 60_000,
    sendable: false,
    resumable: true,
    fidelity: 'probe',
    ...over,
  }
}

describe('mergeDiscovered', () => {
  it('keeps one entry per session id at the highest-precedence origin', () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as CcSessionId
    const merged = mergeDiscovered([
      [discovered({ sessionId: id, origin: 'resumable', fidelity: 'probe' })],
      [discovered({ sessionId: id, origin: 'live-external', fidelity: 'sdk',
        live: { liveness: 'confirmed' } })],
      [discovered({ sessionId: id, origin: 'composed', sendable: true, fidelity: 'sdk' })],
    ], NOW)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.origin).toBe('composed')
    expect(merged[0]?.sendable).toBe(true)
  })

  it('sorts non-composed sessions most-recently-active first', () => {
    const merged = mergeDiscovered([[
      discovered({ sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as CcSessionId,
        lastActivityAt: NOW - 600_000 }),
      discovered({ sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as CcSessionId,
        lastActivityAt: NOW - 1_000 }),
    ]], NOW)

    expect(merged.map(entry => entry.lastActivityAt))
      .toEqual([NOW - 1_000, NOW - 600_000])
  })
})

describe('normalizeSourceClock', () => {
  it('shifts a fast source back and never reports a future activity time', () => {
    const skewMs = 3 * 60 * 60 * 1000
    const result: CcDiscoveryResult = {
      // The probe's clock is three hours ahead of ours.
      generatedAt: NOW + skewMs,
      cached: false,
      warnings: [],
      sessions: [discovered({ lastActivityAt: NOW + skewMs - 60_000 })],
    }

    const [entry] = normalizeSourceClock(result, NOW)

    expect(entry?.lastActivityAt).toBe(NOW - 60_000)
    expect(entry?.lastActivityAt).toBeLessThanOrEqual(NOW)
  })
})

describe('groupByOrigin', () => {
  it('splits the three origins and preserves input order within each', () => {
    const groups = groupByOrigin([
      discovered({ sessionId: '1' as CcSessionId, origin: 'composed', sendable: true }),
      discovered({ sessionId: '2' as CcSessionId, origin: 'resumable' }),
      discovered({ sessionId: '3' as CcSessionId, origin: 'live-external' }),
      discovered({ sessionId: '4' as CcSessionId, origin: 'resumable' }),
    ])

    expect(groups.composed.map(entry => entry.sessionId)).toEqual(['1'])
    expect(groups.liveExternal.map(entry => entry.sessionId)).toEqual(['3'])
    expect(groups.resumable.map(entry => entry.sessionId)).toEqual(['2', '4'])
  })
})
