import { describe, expect, it } from 'vitest'

import {
  groupByOrigin, mergeDiscovered, normalizeSourceClock, projectComposed,
} from '../src/discovery.ts'
import type { CcDiscoveredSession, CcDiscoveryResult, CcSessionId, CcSessionSnapshot } from '../src/index.ts'

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

describe('projectComposed', () => {
  it('projects three sessions in inventory order, preserving fields', () => {
    const sessions: readonly CcSessionSnapshot[] = [
      {
        id: 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx' as CcSessionId,
        status: 'idle',
        cwd: '/repo/x',
        openedAt: NOW - 120_000,
        lastActivityAt: NOW - 30_000,
        pendingAsks: 0,
        pendingAskDetails: [],
        recentAsks: [],
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as CcSessionId,
        status: 'idle',
        cwd: '/repo/a',
        openedAt: NOW - 90_000,
        lastActivityAt: NOW - 20_000,
        pendingAsks: 0,
        pendingAskDetails: [],
        recentAsks: [],
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as CcSessionId,
        status: 'idle',
        cwd: '/repo/b',
        openedAt: NOW - 60_000,
        lastActivityAt: NOW - 10_000,
        pendingAsks: 0,
        pendingAskDetails: [],
        recentAsks: [],
      },
    ]

    const result = projectComposed(sessions, 'b2studio', NOW)

    // Order matches buildSessionInventory: idle sessions sorted by idle time (longest first).
    expect(result.map(s => s.sessionId)).toEqual([
      'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ])
    // Check mandatory fields.
    expect(result[0]?.origin).toBe('composed')
    expect(result[0]?.host).toBe('b2studio')
    expect(result[0]?.sourceId).toBe('composition')
    expect(result[0]?.fidelity).toBe('sdk')
    expect(result[0]?.sendable).toBe(true)
    expect(result[0]?.composed).toBeDefined()
  })
})

describe('mergeDiscovered', () => {
  it('preserves composed order verbatim, dropping collisions from groups', () => {
    const xId = 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx' as CcSessionId
    const aId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as CcSessionId
    const bId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as CcSessionId

    const composed = [
      discovered({ sessionId: xId, origin: 'composed', sendable: true, fidelity: 'sdk' }),
      discovered({ sessionId: aId, origin: 'composed', sendable: true, fidelity: 'sdk' }),
      discovered({ sessionId: bId, origin: 'composed', sendable: true, fidelity: 'sdk' }),
    ]

    // A has also appeared in resumable (maybe from a transcript scan).
    const groups = [[
      discovered({ sessionId: aId, origin: 'resumable', sendable: false, fidelity: 'probe' }),
    ]]

    const merged = mergeDiscovered(composed, groups, NOW)

    expect(merged).toHaveLength(3)
    // Composed order: X, A, B.
    expect(merged.map(s => s.sessionId)).toEqual([xId, aId, bId])
    // A appears once, as composed (the version from the composed list won).
    const aEntry = merged.find(s => s.sessionId === aId)
    expect(aEntry?.origin).toBe('composed')
    expect(aEntry?.sendable).toBe(true)
  })

  it('dedupes within groups: live-external wins over resumable', () => {
    const xId = 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx' as CcSessionId
    const cId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as CcSessionId

    const composed = [
      discovered({ sessionId: xId, origin: 'composed', sendable: true, fidelity: 'sdk' }),
    ]

    // C appears twice: once as live-external, once as resumable.
    const groups = [[
      discovered({ sessionId: cId, origin: 'live-external', sendable: false, fidelity: 'sdk',
        live: { liveness: 'confirmed' } }),
      discovered({ sessionId: cId, origin: 'resumable', sendable: false, fidelity: 'probe' }),
    ]]

    const merged = mergeDiscovered(composed, groups, NOW)

    expect(merged).toHaveLength(2)
    const cEntry = merged.find(s => s.sessionId === cId)
    expect(cEntry?.origin).toBe('live-external')
    expect(cEntry?.live?.liveness).toBe('confirmed')
  })

  it('sorts non-composed sessions most-recently-active first', () => {
    const xId = 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx' as CcSessionId
    const cId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as CcSessionId
    const dId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as CcSessionId

    const composed = [
      discovered({ sessionId: xId, origin: 'composed', sendable: true, fidelity: 'sdk' }),
    ]

    const groups = [[
      discovered({ sessionId: cId, origin: 'resumable', lastActivityAt: NOW - 600_000 }),
      discovered({ sessionId: dId, origin: 'resumable', lastActivityAt: NOW - 1_000 }),
    ]]

    const merged = mergeDiscovered(composed, groups, NOW)

    // Composed first (X with default NOW-60_000), then non-composed sorted by recency.
    expect(merged.map(entry => entry.lastActivityAt))
      .toEqual([NOW - 60_000, NOW - 1_000, NOW - 600_000])
  })

  it('keeps one entry per session id at the highest-precedence origin (when no composed present)', () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as CcSessionId
    const merged = mergeDiscovered([], [
      [discovered({ sessionId: id, origin: 'resumable', fidelity: 'probe' })],
      [discovered({ sessionId: id, origin: 'live-external', fidelity: 'sdk',
        live: { liveness: 'confirmed' } })],
    ], NOW)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.origin).toBe('live-external')
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
