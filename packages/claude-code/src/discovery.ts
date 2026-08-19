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
 * Merge discovered sessions into one deduped, sorted list.
 *
 * The composed group is passed separately because its order is **structural**:
 * it comes from {@link buildSessionInventory} and is the exact order the
 * `SESSION_LIMIT` path promises as the close-candidate ranking. That order
 * must be preserved verbatim — never re-sorted, never re-indexed by a
 * collision with an earlier group.
 *
 * Every id present in `composed` wins outright; a matching entry in `groups`
 * is dropped because `composed` carries both the live snapshot and the control
 * channel. Entries within `groups` themselves dedupe by {@link ORIGIN_PRECEDENCE}
 * (`live-external` over `resumable`), then sort most-recently-active first.
 *
 * @param composed - sessions from this composition, already in inventory order.
 * @param groups - sessions from external sources, one array per source.
 * @param now - our clock, used as the ceiling for a bad timestamp and as the
 *   recency sort key.
 * @returns composed sessions in inventory order, then everything else
 *   most-recently-active first, all deduped by id.
 */
export function mergeDiscovered(
  composed: readonly CcDiscoveredSession[],
  groups: readonly CcDiscoveredSession[][],
  now: number,
): CcDiscoveredSession[] {
  const composedIds = new Set(composed.map(s => s.sessionId))
  const best = new Map<string, CcDiscoveredSession>()
  for (const group of groups) {
    for (const session of group) {
      // Skip entries whose id is already present in composed: they lose.
      if (composedIds.has(session.sessionId)) continue
      const previous = best.get(session.sessionId)
      if (previous === undefined) {
        best.set(session.sessionId, session)
        continue
      }
      const kept = ORIGIN_PRECEDENCE.indexOf(previous.origin)
      const candidate = ORIGIN_PRECEDENCE.indexOf(session.origin)
      if (candidate < kept) best.set(session.sessionId, session)
    }
  }
  const rest = [...best.values()]
    .sort((left, right) => {
      const activity = Math.min(now, right.lastActivityAt) - Math.min(now, left.lastActivityAt)
      // A total order, so the same inputs always render identically.
      return activity !== 0 ? activity : left.sessionId.localeCompare(right.sessionId)
    })
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
