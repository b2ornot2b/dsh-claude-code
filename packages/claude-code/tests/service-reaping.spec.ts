import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import { ClaudeCodeService, sweepIntervalMs } from '@deepseek-ai/dsh-claude-code'
import type {
  CcAskTarget, ClaudeCodeConfig, ClaudeCodeError, CcSession, CcSessionId,
} from '@deepseek-ai/dsh-claude-code'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeApproval, fakeAgent, makeRequest } from './ask-helpers.ts'
import { createFakeBackend, settle } from './fake-backend.ts'
import type { FakeBackend } from './fake-backend.ts'

/**
 * The service's two answers to a service-wide session cap: a refusal that says
 * WHO is holding the slots, and an opt-in sweep that reclaims the abandoned ones.
 *
 * Timer discipline: only `setInterval`/`clearInterval`/`Date` are faked. The
 * fake backend's `settle()` (and the session's own drain loop) run on
 * `setTimeout`, which stays real — so a spec can advance the sweep clock by an
 * hour without the session machinery deadlocking, and `getTimerCount()` counts
 * exactly the sweep interval and nothing else.
 */

/** An absolute directory that certainly exists — `open()` validates `cwd` up front. */
const CWD = tmpdir()

/** The mounted service, plus the fake SDK behind it. */
interface Mounted {
  readonly service: ClaudeCodeService
  readonly fake: FakeBackend
  /** Every diagnostic line the service wrote, so "logged loudly" is an assertion. */
  readonly lines: string[]
  /** A real dsh session log, for the mirror-teardown specs. */
  newSession(id: string): Session
  dispose(): Promise<void>
}

/**
 * Mount the service with a fake backend inside a real plugin fiber, alongside a
 * real dsh session store (the mirror needs one; nothing else touches it).
 * @param config - surface configuration.
 * @returns the service, the fake backend, the captured log and a disposer.
 */
async function mount(config: ClaudeCodeConfig = {}): Promise<Mounted> {
  const fake = createFakeBackend()
  const ctx = new Context()
  const lines: string[] = []
  // Captured before the service reads `ctx.logger` into its own closure.
  ctx.logger.debug = (message: unknown) => { lines.push(String(message)) }
  let service: ClaudeCodeService | undefined
  function claudeCodeReapingMount(inner: Context): void {
    service = new ClaudeCodeService(
      inner, { prewarm: false, ...config }, { backend: fake.backend, drainPollMs: 1 })
  }
  const fiber = await ctx.plugin(claudeCodeReapingMount)
  const storeFiber = await ctx.plugin(SessionStore)
  const store = ctx.get('sessions')
  if (service === undefined || store === undefined) throw new Error('mount did not complete')
  return {
    service,
    fake,
    lines,
    newSession: (id: string) => store.create(SessionId(id)),
    dispose: async () => {
      await storeFiber.dispose()
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * An ask target whose approval NEVER answers — the production shape: a human
 * looking at a permission prompt, and a session that will sit on it forever.
 * @returns the target and its gated approval seam.
 */
function unanswerableAsk(): { target: CcAskTarget, approval: FakeApproval } {
  const approval = new FakeApproval()
  approval.gate = new Promise<void>(() => {})
  return { target: { agent: fakeAgent(), delegated: false, approval }, approval }
}

/**
 * Let the (real) microtask and macrotask queues drain several times, so an
 * asynchronous close armed by a timer callback has actually completed.
 * @param times - how many turns to allow.
 * @returns nothing.
 */
async function drain(times = 6): Promise<void> {
  for (let turn = 0; turn < times; turn += 1) await settle()
}

/** Reach the private session registry, to plant a record no public API can produce. */
interface WhiteBoxRecord {
  id: CcSessionId
  cwd: string
  openedAt: number
  status: string
  pendingAsks: number
  session?: CcSession
  close(reason?: string): Promise<void>
}

/**
 * @param service - the raw service instance.
 * @returns its live session map.
 */
function registryOf(service: ClaudeCodeService): Map<CcSessionId, WhiteBoxRecord> {
  return (service as unknown as { sessions: Map<CcSessionId, WhiteBoxRecord> }).sessions
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the SESSION_LIMIT refusal, through the real service', () => {
  it('inventories the live sessions in prose AND as structured data on the error', async () => {
    const { service, dispose } = await mount({ limits: { maxConcurrentSessions: 2 } })
    try {
      const first = await service.open({ cwd: CWD })
      // The second session is the busy one: it must not be the recommendation.
      const second = await service.open({ cwd: CWD, prompt: 'go' })
      await drain()

      const error = await service.open({ cwd: CWD }).then(
        () => undefined,
        (reason: unknown) => reason as ClaudeCodeError)

      expect(error?.code).toBe('SESSION_LIMIT')
      // Prose: both sessions, both working directories, the service-wide caveat.
      expect(error?.message).toContain(first.id)
      expect(error?.message).toContain(second.id)
      expect(error?.message).toContain(CWD)
      expect(error?.message).toContain('SERVICE-WIDE')
      expect(error?.message).toContain('OTHER dsh sessions')
      expect(error?.message).toContain(`Best candidate to close: ${first.id}`)

      // Data: the same inventory, unparsed.
      const info = error?.data?.sessionLimit
      expect(info?.limit).toBe(2)
      expect(info?.liveCount).toBe(2)
      expect(info?.closeCandidate).toBe(first.id)
      // Idle before running: the session with a turn in flight sorts last.
      expect(info?.sessions.map(entry => entry.id)).toEqual([first.id, second.id])
      expect(info?.sessions.every(entry => entry.cwd === CWD)).toBe(true)

      // Nothing was opened by the refusal.
      expect(service.list()).toHaveLength(2)
    } finally {
      await dispose()
    }
  })
})

describe('opt-in idle reaping', () => {
  it('installs NO timer when limits.idleTimeoutMs is absent', async () => {
    const { service, dispose } = await mount()
    try {
      // The whole safety property in one assertion: an operator who did not ask
      // for reaping gets no sweep, not a disabled one.
      expect(vi.getTimerCount()).toBe(0)
      await service.open({ cwd: CWD })
      await drain()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await dispose()
    }
  })

  it('installs exactly ONE service-wide timer when it is set, and clears it on disposal', async () => {
    const { service, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    expect(vi.getTimerCount()).toBe(1)
    // Still one timer with three sessions open: the sweep is per SERVICE.
    await service.open({ cwd: CWD })
    await service.open({ cwd: CWD })
    await service.open({ cwd: CWD })
    await drain()
    expect(vi.getTimerCount()).toBe(1)

    await dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes an idle, unblocked session that crossed the ceiling, tagged "reaped"', async () => {
    const { service, fake, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    try {
      const opened = await service.open({ cwd: CWD })
      await drain()
      expect(service.get(opened.id)?.status).toBe('idle')

      vi.advanceTimersByTime(60_000 + sweepIntervalMs(60_000))
      await drain()

      // Gone from the live registry, subprocess closed…
      expect(service.list()).toEqual([])
      expect(fake.queries[0]?.closed).toBe(true)
      // …and the tombstone says WHY, which is the whole point of a session that
      // vanished without anybody asking.
      expect(service.get(opened.id)).toMatchObject({ status: 'closed', closeReason: 'reaped' })
    } finally {
      await dispose()
    }
  })

  it('leaves a session alone until it has actually been idle that long', async () => {
    const { service, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    try {
      const opened = await service.open({ cwd: CWD })
      await drain()

      vi.advanceTimersByTime(45_000)
      await drain()
      expect(service.get(opened.id)?.status).toBe('idle')

      // Activity resets the clock: a session being driven is never abandoned.
      service.session(opened.id)?.send('still here')
      await drain()
      vi.advanceTimersByTime(45_000)
      await drain()
      expect(service.list().map(entry => entry.id)).toEqual([opened.id])
    } finally {
      await dispose()
    }
  })

  it('never reaps a session with a turn in flight', async () => {
    const { service, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    try {
      const opened = await service.open({ cwd: CWD, prompt: 'a long job' })
      await drain()
      expect(service.get(opened.id)?.status).toBe('running')

      vi.advanceTimersByTime(600_000)
      await drain()

      expect(service.list().map(entry => entry.id)).toEqual([opened.id])
    } finally {
      await dispose()
    }
  })

  it('NEVER reaps a session with a pending ask, however long it has waited', async () => {
    // The 1h32m session, reproduced end to end rather than planted: idle,
    // ancient, and blocked on a permission prompt whose approval seam never
    // answers. Reaping it would deny that person's decision for them, so the
    // sweep must skip it forever — which is also why `limits.idleTimeoutMs`
    // alone could not have reclaimed the session from the production trace.
    const { service, fake, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    try {
      const opened = await service.open({ cwd: CWD, ask: unanswerableAsk().target })
      await drain()
      const query = fake.queries[0]
      if (query === undefined) throw new Error('fake backend built no query')

      // A real permission request, routed through the real ask table, that a
      // human never answers. `canUseTool` is called outside a turn, so the
      // session stays IDLE — exactly the shape the sweep would otherwise reap.
      void query.options.canUseTool?.('Write', { file_path: '/tmp/notes.txt' }, makeRequest())
      await drain()
      expect(service.get(opened.id)?.pendingAsks).toBe(1)
      expect(service.get(opened.id)?.status).toBe('idle')

      vi.advanceTimersByTime(3_600_000)
      await drain()

      expect(service.list().map(entry => entry.id)).toEqual([opened.id])
      expect(service.get(opened.id)?.pendingAsks).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('does NOT reap a session that gained a pending ask after the sweep selected it', async () => {
    // The race. `reapIdle` selects once and then closes in a loop that AWAITS,
    // so every session after the first is acted on across at least one turn of
    // the event loop — and a permission ask lands in exactly that gap. Here the
    // first close is what triggers the ask on the second session, which makes
    // the interleaving deterministic instead of hopeful.
    const { service, fake, lines, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    try {
      const survivor = await service.open({ cwd: CWD, ask: unanswerableAsk().target })
      await drain()
      const query = fake.queries[0]
      if (query === undefined) throw new Error('fake backend built no query')

      // Age the survivor to just UNDER the ceiling, so the sweeps that run on
      // the way here select nothing…
      vi.advanceTimersByTime(55_000)
      await drain()

      // …then plant a second, OLDER registry entry, so that the very next sweep
      // — a single tick — selects both, oldest first. Its close is what raises
      // the ask on `survivor`, which puts the ask squarely inside the window
      // between the selection and the second close.
      const first = 'older-session' as CcSessionId
      let closed = false
      registryOf(service).set(first, {
        id: first,
        cwd: CWD,
        openedAt: Date.now() - 10_000_000,
        status: 'idle',
        pendingAsks: 0,
        close: async () => {
          closed = true
          void query.options.canUseTool?.('Write', { file_path: '/tmp/notes.txt' }, makeRequest())
          await settle()
        },
      })

      vi.advanceTimersByTime(sweepIntervalMs(60_000))
      await drain()

      // The older one went, as it should have.
      expect(closed).toBe(true)
      // The younger one gained a human decision mid-sweep and was spared.
      expect(service.list().map(entry => entry.id)).toEqual([survivor.id])
      expect(service.get(survivor.id)?.pendingAsks).toBe(1)
      expect(service.get(survivor.id)?.status).toBe('idle')
      // A session the sweep decided against must say so: a spared session is as
      // much a diagnostic as a reaped one.
      expect(lines.some(line => line.includes('idle sweep skipped'))).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('does NOT reap a session that started running after the sweep selected it', async () => {
    const { service, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    try {
      const survivor = await service.open({ cwd: CWD })
      await drain()
      // Just under the ceiling, so exactly one sweep does the work (see above).
      vi.advanceTimersByTime(55_000)
      await drain()

      const first = 'older-session' as CcSessionId
      registryOf(service).set(first, {
        id: first,
        cwd: CWD,
        openedAt: Date.now() - 10_000_000,
        status: 'idle',
        pendingAsks: 0,
        close: async () => {
          // A tool call sends to the session while the sweep is between closes.
          service.session(survivor.id)?.send('one more thing')
          await settle()
        },
      })

      vi.advanceTimersByTime(sweepIntervalMs(60_000))
      await drain()

      expect(service.list().map(entry => entry.id)).toEqual([survivor.id])
      expect(service.get(survivor.id)?.status).toBe('running')
    } finally {
      await dispose()
    }
  })

  it('tears a reaped session down through the SAME close path as an explicit close', async () => {
    // "No half-torn-down session": the sweep must not have its own teardown. The
    // two paths are run over identical sessions and compared — mirror finalized
    // and detached, subprocess query closed, tombstone recorded — with the close
    // REASON as the only permitted difference.
    const { service, fake, newSession, dispose } = await mount({ limits: { idleTimeoutMs: 60_000 } })
    try {
      const reapedLog = newSession('11111111-2222-4333-8444-555555555555')
      const closedLog = newSession('22222222-3333-4444-8555-666666666666')
      const toReap = await service.open({ cwd: CWD, mirror: { session: reapedLog } })
      const toClose = await service.open({ cwd: CWD, mirror: { session: closedLog } })
      const reapedHandle = service.session(toReap.id)
      const closedHandle = service.session(toClose.id)
      service.session(toReap.id)?.send('hello there')
      service.session(toClose.id)?.send('hello there')
      await drain()
      // Both turns finish, so both sessions are idle — a session with a turn in
      // flight is never reapable, and the two paths must start from one state.
      await fake.queries[0]?.emitResult('success')
      await fake.queries[1]?.emitResult('success')
      await drain()

      // One path: somebody asked. The other: the sweep did.
      await service.close(toClose.id)
      vi.advanceTimersByTime(60_000 + sweepIntervalMs(60_000))
      await drain()

      // Identical logs, turn framing included.
      expect(reapedLog.events.map(event => event.type))
        .toEqual(closedLog.events.map(event => event.type))
      expect(reapedLog.events.map(event => event.type)).toContain('turn/end')

      // Identical actor teardown.
      expect(reapedHandle?.status).toBe('closed')
      expect(closedHandle?.status).toBe('closed')
      expect(fake.queries.every(query => query.closed)).toBe(true)

      // Identical tombstones, apart from the one field that says which path ran.
      const reapedTomb = service.get(toReap.id)
      const closedTomb = service.get(toClose.id)
      expect(reapedTomb?.closeReason).toBe('reaped')
      expect(closedTomb?.closeReason).toBe('closed')
      const shape = (snapshot: typeof reapedTomb): unknown => ({
        ...snapshot, id: '<id>', cwd: '<cwd>', openedAt: 0, lastActivityAt: 0, closeReason: '<reason>',
      })
      expect(shape(reapedTomb)).toEqual(shape(closedTomb))

      // And the mirror is DETACHED, not merely finalized: a late message from a
      // dead subprocess must not append to a log nobody owns any more.
      const before = reapedLog.events.length
      await fake.queries[0]?.emitResult('success')
      await drain()
      expect(reapedLog.events).toHaveLength(before)
    } finally {
      await dispose()
    }
  })

  it('logs which session it reaped and why', async () => {
    const lines: string[] = []
    const fake = createFakeBackend()
    const ctx = new Context()
    // cordis's logger is what the service writes diagnostics through; capture it
    // before the service reads it into its own closure.
    ctx.logger.debug = (message: unknown) => { lines.push(String(message)) }
    let service: ClaudeCodeService | undefined
    function reapLoggingMount(inner: Context): void {
      service = new ClaudeCodeService(
        inner,
        { prewarm: false, limits: { idleTimeoutMs: 60_000 } },
        { backend: fake.backend, drainPollMs: 1 })
    }
    const fiber = await ctx.plugin(reapLoggingMount)
    try {
      const opened = await service?.open({ cwd: CWD })
      await drain()
      vi.advanceTimersByTime(120_000)
      await drain()

      const reapLine = lines.find(line => line.includes('reaped session'))
      expect(reapLine).toBeDefined()
      expect(reapLine).toContain(String(opened?.id))
      expect(reapLine).toContain('no pending asks')
      expect(reapLine).toContain('limits.idleTimeoutMs')
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('sweepIntervalMs', () => {
  it('sweeps at a quarter of the ceiling, clamped at both ends', () => {
    expect(sweepIntervalMs(60_000)).toBe(15_000)
    // A tiny ceiling must not turn the sweep into a busy loop…
    expect(sweepIntervalMs(100)).toBe(250)
    // …and a huge one must not wake the process every few seconds for nothing.
    expect(sweepIntervalMs(86_400_000)).toBe(60_000)
  })
})
