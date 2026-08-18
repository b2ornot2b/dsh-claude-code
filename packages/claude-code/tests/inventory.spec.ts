import {
  buildSessionInventory, buildSessionLimitInfo, isReapable, renderSessionLimit, selectReapable, sessionLimitError,
} from '@deepseek-ai/dsh-claude-code'
import type { CcPendingAsk, CcSessionId, CcSessionSnapshot, CcSessionStatus } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

/**
 * The concurrency inventory: what a `SESSION_LIMIT` refusal says, in what order,
 * and what it carries as data.
 *
 * These are pure-function specs on purpose — the clock is an argument — so the
 * ordering rule that decides which session a model will close can be stated
 * exactly, without a service, a timer or a subprocess anywhere near it.
 */

/** A fixed "now" every case measures against. */
const NOW = 1_700_000_000_000

/**
 * One snapshot, with only the fields the inventory reads spelled out.
 * @param id - the session id.
 * @param overrides - what this case is actually about.
 * @returns the snapshot.
 */
function snapshot(
  id: string,
  overrides: {
    status?: CcSessionStatus
    cwd?: string
    openedAgoMs?: number
    idleForMs?: number
    pendingAskDetails?: readonly CcPendingAsk[]
    model?: string
  } = {},
): CcSessionSnapshot {
  const pending = overrides.pendingAskDetails ?? []
  return {
    id: id as CcSessionId,
    status: overrides.status ?? 'idle',
    cwd: overrides.cwd ?? `/repo/${id}`,
    openedAt: NOW - (overrides.openedAgoMs ?? 60_000),
    lastActivityAt: NOW - (overrides.idleForMs ?? 0),
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    pendingAsks: pending.length,
    pendingAskDetails: pending,
  }
}

/**
 * One pending ask.
 * @param toolName - the tool a human is deciding.
 * @param reason - the sentence the human is reading.
 * @returns the pending ask.
 */
function ask(toolName: string, reason?: string): CcPendingAsk {
  return {
    requestId: `req-${toolName}`,
    kind: 'permission',
    toolName,
    ...(reason === undefined ? {} : { reason }),
    since: NOW - 5_000,
    startedAt: NOW - 5_000,
  }
}

describe('buildSessionInventory ordering', () => {
  it('sorts a session with a pending human ask LAST, however long it has been idle', () => {
    // The 1h32m session from the production trace: the oldest, the most idle,
    // and the one thing that must never be recommended for closure, because a
    // person may still be deciding on it.
    const sessions = [
      snapshot('parked', { idleForMs: 5_520_000, openedAgoMs: 5_520_000, pendingAskDetails: [ask('Write')] }),
      snapshot('stale', { idleForMs: 900_000 }),
      snapshot('fresh', { idleForMs: 1_000 }),
    ]

    expect(buildSessionInventory(sessions, NOW).map(entry => entry.id))
      .toEqual(['stale', 'fresh', 'parked'])
  })

  it('ranks idle before actively working, and longest-idle first within a rank', () => {
    const sessions = [
      snapshot('running-old', { status: 'running', idleForMs: 600_000 }),
      snapshot('idle-new', { idleForMs: 10_000 }),
      snapshot('idle-old', { idleForMs: 300_000 }),
      snapshot('starting', { status: 'starting', idleForMs: 900_000 }),
    ]

    expect(buildSessionInventory(sessions, NOW).map(entry => entry.id))
      .toEqual(['idle-old', 'idle-new', 'starting', 'running-old'])
  })

  it('subtracts the clock so the model never has to, and never reports a negative age', () => {
    const [entry] = buildSessionInventory(
      [snapshot('a', { openedAgoMs: 120_000, idleForMs: 45_000 })], NOW)

    expect(entry?.ageMs).toBe(120_000)
    expect(entry?.idleMs).toBe(45_000)

    // A clock that stepped backwards must not make a session look like it opens
    // in the future.
    const [rewound] = buildSessionInventory([snapshot('a')], NOW - 120_000)
    expect(rewound?.ageMs).toBe(0)
    expect(rewound?.idleMs).toBe(0)
  })

  it('is a total order, so the same registry always renders the same message', () => {
    const sessions = [snapshot('b', { idleForMs: 1_000 }), snapshot('a', { idleForMs: 1_000 })]

    expect(buildSessionInventory(sessions, NOW).map(entry => entry.id)).toEqual(['a', 'b'])
    expect(buildSessionInventory([...sessions].reverse(), NOW).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('returns an empty inventory for an empty registry', () => {
    expect(buildSessionInventory([], NOW)).toEqual([])
  })
})

describe('buildSessionLimitInfo', () => {
  it('recommends the longest-idle session with nothing pending on a human', () => {
    const info = buildSessionLimitInfo([
      snapshot('parked', { idleForMs: 5_520_000, pendingAskDetails: [ask('Write')] }),
      snapshot('stale', { idleForMs: 900_000 }),
      snapshot('busy', { status: 'running', idleForMs: 2_000 }),
    ], 4, NOW)

    expect(info.limit).toBe(4)
    expect(info.liveCount).toBe(3)
    expect(info.closeCandidate).toBe('stale')
  })

  it('recommends NOTHING when every live session is blocked on a human', () => {
    const info = buildSessionLimitInfo([
      snapshot('one', { pendingAskDetails: [ask('Bash')] }),
      snapshot('two', { pendingAskDetails: [ask('Edit')] }),
    ], 2, NOW)

    expect('closeCandidate' in info).toBe(false)
    // The first entry is still the least-bad one; it is simply not a
    // recommendation, because closing it denies a decision in progress.
    expect(info.sessions).toHaveLength(2)
  })
})

describe('the SESSION_LIMIT refusal', () => {
  it('names every live session, its cwd, its age and what is pending', () => {
    const message = renderSessionLimit(buildSessionLimitInfo([
      snapshot('parked', {
        cwd: '/repo/api',
        openedAgoMs: 5_520_000,
        idleForMs: 5_520_000,
        pendingAskDetails: [ask('Write', 'Write: /tmp/notes.txt')],
      }),
      snapshot('stale', { cwd: '/repo/web', openedAgoMs: 900_000, idleForMs: 900_000, model: 'claude-x' }),
    ], 2, NOW))

    expect(message).toContain('limits.maxConcurrentSessions (2)')
    expect(message).toContain('parked')
    expect(message).toContain('/repo/api')
    expect(message).toContain('/repo/web')
    expect(message).toContain('claude-x')
    // The ages, already subtracted.
    expect(message).toContain('1h 32m')
    expect(message).toContain('15m 00s')
    // What the human is looking at, verbatim.
    expect(message).toContain('Write: /tmp/notes.txt')
    // The fact the production agent could not deduce.
    expect(message).toContain('SERVICE-WIDE')
    expect(message).toContain('OTHER dsh sessions')
    // The one concrete next action.
    expect(message).toContain('Best candidate to close: stale')
    expect(message).toContain('claude_code_list')
  })

  it('tells the caller not to close the blocked one, and says so on the blocked line', () => {
    const message = renderSessionLimit(buildSessionLimitInfo([
      snapshot('parked', { pendingAskDetails: [ask('Write', 'Write: /tmp/notes.txt')] }),
    ], 1, NOW))

    expect(message).toContain('do NOT close this one')
    expect(message).toContain('EVERY live session is blocked')
    expect(message).not.toContain('Best candidate to close')
  })

  it('caps how many asks it names, so one blocked session cannot bury the advice', () => {
    const message = renderSessionLimit(buildSessionLimitInfo([
      snapshot('busy', { pendingAskDetails: [ask('A'), ask('B'), ask('C'), ask('D'), ask('E')] }),
    ], 1, NOW))

    expect(message).toContain('(+2 more)')
    expect(message).not.toContain('"E"')
  })

  it('carries the SAME inventory as structured data, so no tool layer has to parse prose', () => {
    const sessions = [
      snapshot('parked', { pendingAskDetails: [ask('Write', 'Write: /tmp/notes.txt')] }),
      snapshot('stale', { idleForMs: 900_000 }),
    ]
    const error = sessionLimitError(sessions, 2, NOW)
    const info = error.data?.sessionLimit

    expect(error.code).toBe('SESSION_LIMIT')
    expect(info).toBeDefined()
    expect(info?.limit).toBe(2)
    expect(info?.liveCount).toBe(2)
    expect(info?.closeCandidate).toBe('stale')
    expect(info?.sessions.map(entry => entry.id)).toEqual(['stale', 'parked'])
    // Prose and payload are built from ONE projection: rendering the payload
    // reproduces the message exactly.
    expect(error.message).toBe(renderSessionLimit(info!))
  })

  it('says the limit itself is the problem when nothing is registered', () => {
    const message = renderSessionLimit(buildSessionLimitInfo([], 0, NOW))

    expect(message).toContain('No sessions are registered')
    expect(message).toContain('raise limits.maxConcurrentSessions')
  })

  it('renders a session that closed between the snapshot and the render', () => {
    // `open()` takes the registry snapshot, then builds the message. A session
    // whose subprocess died in between is a CLOSED snapshot flowing through the
    // inventory — with a `closeReason` and, in the pump-close path, a pending-ask
    // count whose ask table has already been drained. Every one of those must
    // render; the refusal is the wrong place to raise a second failure.
    const dying: CcSessionSnapshot = {
      ...snapshot('dying', { idleForMs: 1_000 }),
      status: 'closed',
      closeReason: 'crashed',
      // Count without details: the table settled, the count was read before it did.
      pendingAsks: 1,
      pendingAskDetails: [],
    }

    const message = renderSessionLimit(buildSessionLimitInfo([dying, snapshot('live')], 2, NOW))

    expect(message).toContain('dying')
    expect(message).toContain('closed')
    expect(message).toContain('BLOCKED on 1 pending ask(s)')
    // …and it is not recommended for closure, because as far as the count goes a
    // human is still mid-decision on it.
    expect(message).toContain('Best candidate to close: live')
  })

  it('survives a snapshot from a seam older than these fields, rather than throwing mid-refusal', () => {
    // `@deepseek-ai/dsh-claude-code` and `@deepseek-ai/dsh-tool-claude-code` are
    // published and resolved separately, so a deployment can run a tool package
    // newer than the seam behind it. A missing `pendingAskDetails` used to throw
    // on `.slice` — while building the message that explains a refusal, which
    // would turn a diagnostic into an outage.
    const skewed = {
      id: 'skewed' as CcSessionId,
      status: 'idle' as const,
      pendingAsks: 0,
    } as unknown as CcSessionSnapshot

    const info = buildSessionLimitInfo([skewed], 1, NOW)

    expect(info.sessions[0]?.pendingAskDetails).toEqual([])
    // No `NaN` ages leaking into prose a model is expected to act on.
    expect(info.sessions[0]?.ageMs).toBe(0)
    expect(info.sessions[0]?.idleMs).toBe(0)
    expect(() => renderSessionLimit(info)).not.toThrow()
    expect(renderSessionLimit(info)).not.toContain('NaN')
  })

  it('names no filesystem path except the cwds and the sentences humans are reading', () => {
    // The inventory describes sessions that may belong to OTHER dsh sessions, so
    // what it prints is a deliberate list, not whatever the snapshot happened to
    // carry: the working directory (the one thing that says whose session this
    // is) and the CLI's own ask title (what the human is looking at). Nothing
    // about the host — no transcript file, no settings path, no home directory.
    const apiCwd = '/repo/api'
    const webCwd = '/repo/web'
    const reason = 'Write: /repo/api/notes.txt'
    const message = renderSessionLimit(buildSessionLimitInfo([
      snapshot('parked', { cwd: apiCwd, pendingAskDetails: [ask('Write', reason)] }),
      snapshot('stale', { cwd: webCwd, idleForMs: 900_000 }),
    ], 2, NOW))

    const allowed = [apiCwd, webCwd, reason]
    // Path-shaped runs only, so trailing prose punctuation is not mistaken for
    // part of a path.
    const paths = message.match(/(?:\/[\w.-]+)+/g) ?? []
    expect(paths.length).toBeGreaterThan(0)
    for (const found of paths) {
      expect(allowed.some(allow => allow.includes(found))).toBe(true)
    }
  })
})

describe('selectReapable', () => {
  it('selects a session that is idle, unblocked and past the ceiling', () => {
    expect(selectReapable([snapshot('a', { idleForMs: 60_001 })], 60_000, NOW)).toEqual(['a'])
  })

  it('NEVER selects a session with a pending ask, however long it has been idle', () => {
    // The exact state that produced the 1h32m session: a human may still be
    // deciding, and reaping it would deny their tool call for them.
    const parked = snapshot('parked', { idleForMs: 5_520_000, pendingAskDetails: [ask('Write')] })

    expect(selectReapable([parked], 60_000, NOW)).toEqual([])
  })

  it('never selects a session that is running or still starting', () => {
    const sessions = [
      snapshot('running', { status: 'running', idleForMs: 600_000 }),
      snapshot('starting', { status: 'starting', idleForMs: 600_000 }),
    ]

    expect(selectReapable(sessions, 60_000, NOW)).toEqual([])
  })

  it('leaves a session that has not yet crossed the ceiling alone', () => {
    expect(selectReapable([snapshot('a', { idleForMs: 59_999 })], 60_000, NOW)).toEqual([])
  })

  it('orders several reapable sessions longest-idle first', () => {
    const sessions = [
      snapshot('newer', { idleForMs: 70_000 }),
      snapshot('older', { idleForMs: 700_000 }),
    ]

    expect(selectReapable(sessions, 60_000, NOW)).toEqual(['older', 'newer'])
  })
})

describe('isReapable, the per-session re-check the sweep runs before each close', () => {
  it('agrees with selectReapable on every session, one at a time', () => {
    // The sweep selects once and then closes in a loop that awaits — so the
    // question has to be re-askable about ONE session without re-deriving the
    // whole selection. These two must never diverge.
    const sessions = [
      snapshot('reapable', { idleForMs: 70_000 }),
      snapshot('fresh', { idleForMs: 10_000 }),
      snapshot('running', { status: 'running', idleForMs: 700_000 }),
      snapshot('parked', { idleForMs: 700_000, pendingAskDetails: [ask('Write')] }),
    ]
    const selected = new Set(selectReapable(sessions, 60_000, NOW))

    for (const session of sessions) {
      expect(isReapable(session, 60_000, NOW)).toBe(selected.has(session.id))
    }
  })

  it('flips to false the instant an ask arrives on a session already selected', () => {
    // The race the re-check exists for: selected while idle and unblocked, then a
    // permission ask lands while an earlier session in the same sweep is closing.
    const idle = snapshot('a', { idleForMs: 700_000 })
    expect(isReapable(idle, 60_000, NOW)).toBe(true)

    const asked = snapshot('a', { idleForMs: 700_000, pendingAskDetails: [ask('Bash')] })
    expect(isReapable(asked, 60_000, NOW)).toBe(false)
  })

  it('flips to false the instant the session starts running again', () => {
    const busy = snapshot('a', { status: 'running', idleForMs: 700_000 })

    expect(isReapable(busy, 60_000, NOW)).toBe(false)
  })
})
