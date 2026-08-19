/**
 * The discovery merge: pure, clock-injected, and the only place the three
 * session origins meet.
 *
 * Everything here is a total function of its arguments — the clock arrives as
 * `now`, exactly as `inventory.ts` takes it — so a merge can be replayed and a
 * spec can pin it.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { buildSessionInventory } from './inventory.ts'
import type {
  CcDiscoveredSession, CcDiscoveryResult, CcSessionOrigin, CcSessionSnapshot,
} from './types.ts'

/**
 * Highest fidelity first. A session reported by several sources is kept once, at
 * the origin that knows the most about it: `composed` carries a live snapshot
 * and a control channel, `live-external` knows a process exists, `resumable`
 * only knows a file.
 */
export const ORIGIN_PRECEDENCE: readonly CcSessionOrigin[]
  = ['composed', 'live-external', 'resumable']

/**
 * Project this composition's own sessions into discovery's shape.
 *
 * Order comes from {@link buildSessionInventory}, unchanged: the composed group
 * keeps the close-candidate ordering the `SESSION_LIMIT` path promises.
 *
 * @param sessions - snapshots from `ClaudeCode.list()`.
 * @param host - this host's label.
 * @param now - the clock reading ages are measured against.
 * @returns the composed sessions, best close candidate first.
 */
export function projectComposed(
  sessions: readonly CcSessionSnapshot[],
  host: string,
  now: number,
): CcDiscoveredSession[] {
  const byId = new Map(sessions.map(session => [session.id, session]))
  return buildSessionInventory(sessions, now).map((entry) => {
    const snapshot = byId.get(entry.id)
    return {
      sessionId: entry.id,
      origin: 'composed' as const,
      host,
      sourceId: 'composition',
      cwd: entry.cwd,
      lastActivityAt: now - entry.idleMs,
      sendable: true,
      resumable: true,
      fidelity: 'sdk' as const,
      ...(snapshot === undefined ? {} : { composed: snapshot }),
    }
  })
}

/**
 * Re-base one source's timestamps onto our clock.
 *
 * A mesh host's clock can differ from ours, and an unnormalized timestamp
 * produces a session that has been open for a negative time and sorts to the
 * wrong end of the list.
 *
 * @param result - one source's result, carrying the clock it used.
 * @param now - our clock.
 * @returns the source's sessions with timestamps shifted onto our clock.
 */
export function normalizeSourceClock(
  result: CcDiscoveryResult,
  now: number,
): CcDiscoveredSession[] {
  const offset = Number.isFinite(result.generatedAt) ? now - result.generatedAt : 0
  if (offset === 0) return [...result.sessions]
  return result.sessions.map(session => ({
    ...session,
    lastActivityAt: Math.min(now, session.lastActivityAt + offset),
    ...(session.createdAt === undefined
      ? {}
      : { createdAt: Math.min(now, session.createdAt + offset) }),
  }))
}

/**
 * Merge every source's sessions into one deduped list.
 *
 * @param groups - one array per source, already clock-normalized.
 * @param now - our clock, used only as the ceiling for a bad timestamp.
 * @returns composed sessions in inventory order, then everything else
 *   most-recently-active first.
 */
export function mergeDiscovered(
  groups: readonly CcDiscoveredSession[][],
  now: number,
): CcDiscoveredSession[] {
  const best = new Map<string, CcDiscoveredSession>()
  const order = new Map<string, number>()
  let index = 0
  for (const group of groups) {
    for (const session of group) {
      const previous = best.get(session.sessionId)
      if (previous === undefined) {
        best.set(session.sessionId, session)
        order.set(session.sessionId, index)
        index += 1
        continue
      }
      const kept = ORIGIN_PRECEDENCE.indexOf(previous.origin)
      const candidate = ORIGIN_PRECEDENCE.indexOf(session.origin)
      if (candidate < kept) best.set(session.sessionId, session)
    }
  }
  const merged = [...best.values()]
  const composed = merged.filter(session => session.origin === 'composed')
  const rest = merged
    .filter(session => session.origin !== 'composed')
    .sort((left, right) => {
      const activity = Math.min(now, right.lastActivityAt) - Math.min(now, left.lastActivityAt)
      // A total order, so the same inputs always render identically.
      return activity !== 0 ? activity : left.sessionId.localeCompare(right.sessionId)
    })
  // Composed order is NOT re-sorted: it is the close-candidate promise.
  composed.sort((left, right) =>
    (order.get(left.sessionId) ?? 0) - (order.get(right.sessionId) ?? 0))
  return [...composed, ...rest]
}

/**
 * Split a merged list into its three origins, preserving order within each.
 *
 * @param sessions - the merged list.
 * @returns the three groups a wide-scope listing renders as sections.
 */
export function groupByOrigin(sessions: readonly CcDiscoveredSession[]): {
  composed: CcDiscoveredSession[]
  liveExternal: CcDiscoveredSession[]
  resumable: CcDiscoveredSession[]
} {
  return {
    composed: sessions.filter(session => session.origin === 'composed'),
    liveExternal: sessions.filter(session => session.origin === 'live-external'),
    resumable: sessions.filter(session => session.origin === 'resumable'),
  }
}
