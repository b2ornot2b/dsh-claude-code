import { Context } from '@deepseek-ai/cordis'
import {
  attachMirror, CcAskRouter, CcAskRules, CcSession, ClaudeCodeService, newCcSessionId,
  resolveClaudeCodeConfig,
} from '@deepseek-ai/dsh-claude-code'
import type {
  CcAskTarget, CcCloseReason, CcSessionDeps, CcSessionId,
} from '@deepseek-ai/dsh-claude-code'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session as DshSession } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

import { createFakeBackend, settle } from './fake-backend.ts'
import type { FakeQuery } from './fake-backend.ts'

/**
 * **The dead-subprocess suite** — the Phase 6 carry-forward, pinned from every
 * side it is observable from.
 *
 * The defect (api-contract correction 42): the seam's pump ended when the SDK's
 * message iterator completed, and NOTHING closed the session. A subprocess that
 * died therefore left `status: 'running'` forever, pending asks held, waiters
 * parked, the mirror's turn dangling, the service registry populated and a
 * background job unsettled — recoverable only by an explicit close somebody had
 * to know to issue.
 *
 * The fix routes pump completion through the SAME `close()` every explicit close
 * uses, tagged with a {@link CcCloseReason}. So the assertions here are
 * deliberately about the CONSUMERS, not just the status field: if the two paths
 * ever diverge, one of these fails.
 *
 * Two causes are distinguished and both are exercised:
 *
 * - iterator completes with a turn in flight, or throws → `crashed`
 * - iterator completes between turns → `exited`
 */

const CWD = '/tmp'

/** Sessions opened here, closed after every test. */
const opened: CcSession[] = []
/** Fibers mounted here, disposed after every test. */
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close()
  while (disposers.length > 0) await disposers.pop()?.()
})

/**
 * Open a bare session against a fake backend.
 * @param extraDeps - extra session dependencies (an ask channel, a logger).
 * @returns the session and its fake query.
 */
async function open(
  extraDeps: Partial<CcSessionDeps> = {},
): Promise<{ session: CcSession, query: FakeQuery }> {
  const fake = createFakeBackend()
  const session = new CcSession(
    { id: newCcSessionId(), cwd: CWD },
    { backend: fake.backend, config: resolveClaudeCodeConfig(), drainPollMs: 1, ...extraDeps })
  opened.push(session)
  await session.open()
  const query = fake.queries[0]
  if (query === undefined) throw new Error('fake backend built no query')
  return { session, query }
}

describe('the pump ending closes the session', () => {
  it('reports `crashed` when the iterator completes with a turn still in flight', async () => {
    const { session, query } = await open()
    session.send('do a long thing')
    expect(session.status).toBe('running')

    query.endStream()
    await settle()

    expect(session.status).toBe('closed')
    expect(session.closeReason).toBe('crashed')
    expect(session.snapshot()).toMatchObject({ status: 'closed', closeReason: 'crashed' })
  })

  it('reports `exited` when the iterator completes between turns', async () => {
    const { session, query } = await open()
    session.send('one')
    await query.emitResult()
    expect(session.status).toBe('idle')

    query.endStream()
    await settle()

    expect(session.closeReason).toBe('exited')
  })

  it('reports `crashed` when the iterator THROWS, whatever the status machine believed', async () => {
    const { session, query } = await open()
    // Idle, so an orderly end here would be `exited`. A throwing transport is
    // not orderly: nothing in flight or queued can still be answered.
    expect(session.status).toBe('idle')

    query.failStream(new Error('EPIPE: the subprocess is gone'))
    await settle()

    expect(session.status).toBe('closed')
    expect(session.closeReason).toBe('crashed')
  })

  it('closes exactly once, and never re-enters the close a caller already started', async () => {
    const { session, query } = await open()
    const reasons: CcCloseReason[] = []
    session.onClose((reason) => { reasons.push(reason) })

    // The explicit close ends the fake's stream, so the pump completes INSIDE
    // the close it belongs to — the exact re-entrancy the `#closing` guard
    // exists for. Awaiting the pump from a second close would deadlock.
    await session.close()
    await settle()
    query.endStream()
    await settle()

    expect(reasons).toEqual(['closed'])
    expect(session.closeReason).toBe('closed')
  })

  it('keeps `close()` idempotent and answerable after the session died on its own', async () => {
    const { session, query } = await open()
    query.endStream()
    await settle()
    expect(session.closeReason).toBe('exited')

    // An explicit close after the fact must not rewrite the cause: the reason
    // records what actually ended the session, not who noticed last.
    await expect(session.close()).resolves.toBeUndefined()
    expect(session.closeReason).toBe('exited')
  })

  it('does not deadlock: the close the pump triggers still resolves, promptly', async () => {
    const { session, query } = await open()
    session.send('go')

    query.endStream()
    // `runClose()` awaits the pump, so closing from INSIDE the pump body would
    // wait on the promise it is running inside. This is bounded on purpose:
    // that regression does not fail an assertion, it hangs forever.
    await Promise.race([
      session.close(),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('the close deadlocked')) }, 2_000)
        timer.unref?.()
      }),
    ])
    expect(session.status).toBe('closed')
  })

  it('survives an onClose listener that closes the session from inside its own notification', async () => {
    // Stage 3 found this by inspection and pinned it by mutation: `#closing` is
    // assigned only after `runClose()`'s synchronous prefix — which INCLUDES the
    // close-listener loop — so before the `#closed` guard, a listener calling
    // `close()` re-entered the whole sequence and re-notified itself. It is not
    // bounded by anything: `#closeListeners` is cleared after the loop, so the
    // unguarded version recursed until the stack ran out. The counter cap below
    // is what keeps the REGRESSION a failed assertion instead of a crashed
    // worker.
    const { session } = await open()
    let calls = 0
    session.onClose(() => {
      calls += 1
      if (calls > 5) return
      void session.close()
    })

    await session.close()
    await settle()

    expect(calls).toBe(1)
    expect(session.closeReason).toBe('closed')
  })

  it('survives the same re-entry when the close came from a dead subprocess', async () => {
    const { session, query } = await open()
    let calls = 0
    session.onClose(() => {
      calls += 1
      if (calls > 5) return
      void session.close()
    })

    query.endStream()
    await settle()

    expect(calls).toBe(1)
    // The re-entrant `close()` defaults to `'closed'`; the cause must stay the
    // one that actually ended the session.
    expect(session.closeReason).toBe('exited')
  })

  it('runs a late onClose subscriber immediately, with the reason it missed', async () => {
    const { session, query } = await open()
    session.send('go')
    query.endStream()
    await settle()

    let seen: CcCloseReason | undefined
    session.onClose((reason) => { seen = reason })
    expect(seen).toBe('crashed')
  })
})

describe('what a dead subprocess settles', () => {
  it('denies every pending ask instead of leaving the CLI holding a promise', async () => {
    let settled = 0
    const asks = {
      canUseTool: async () => await Promise.resolve({ behavior: 'deny' as const, message: 'no' }),
      pendingAsks: 3,
      pendingAskDetails: [],
      recentAsks: [],
      attachTarget: () => () => {},
      attachCallSite: () => () => {},
      settleAll: (): number => { settled += 1; return 3 },
      onError: () => () => {},
    }
    const { session, query } = await open({ asks })
    session.send('go')

    query.endStream()
    await settle()

    expect(settled).toBe(1)
  })

  it('fails a parked waitForResult with SESSION_CLOSED, naming the cause in the message', async () => {
    const { session, query } = await open()
    session.send('go')
    // Captured eagerly: the rejection lands during `settle()`, and an
    // unobserved rejection is a process-level warning, not a test detail.
    const waiting = session.waitForResult().catch((error: unknown) => error)

    query.endStream()
    await settle()

    await expect(waiting).resolves.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(waiting).resolves.toMatchObject({ message: expect.stringContaining('crashed') })
  })

  it('never resolves a waiter from cache, even with an older turn\'s result in hand', async () => {
    const { session, query } = await open()
    session.send('one')
    await query.emitResult('success', { result: 'stale answer' })
    // Turn two parks a waiter and then dies. Turn one's answer is still in
    // `lastResult`, and handing it over would attribute it to turn two.
    session.send('two')
    const waiting = session.waitForResult().catch((error: unknown) => error)

    query.failStream()
    await settle()

    await expect(waiting).resolves.toMatchObject({ code: 'SESSION_CLOSED' })
  })

  it('answers a wait from cache BEFORE it parks, which is why close never needs to', async () => {
    const { session, query } = await open()
    session.send('one')
    await query.emitResult('success', { result: 'the answer' })

    // Idle with a result in hand: this returns immediately and never becomes a
    // parked waiter, so the close path has nothing to resolve from cache.
    const envelope = await session.waitForResult()
    expect(envelope.message['result']).toBe('the answer')

    query.endStream()
    await settle()
    expect(session.closeReason).toBe('exited')
  })

  it('refuses every further send, exactly as an explicitly closed session does', async () => {
    const { session, query } = await open()
    query.endStream()
    await settle()

    expect(() => session.send('anyone there?')).toThrow(/is closed/)
    await expect(session.interrupt()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.setModel('x')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})

describe('the mirror, when the subprocess dies mid-turn', () => {
  /**
   * Mount a real in-memory session store and create one session in it.
   * @returns the dsh session.
   */
  async function dshSession(id: CcSessionId): Promise<DshSession> {
    const ctx = new Context()
    const fiber = await ctx.plugin(SessionStore)
    const store = ctx.get('sessions')
    if (store === undefined) throw new Error('session store did not mount')
    disposers.push(async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    })
    return store.create(id)
  }

  it('finalizes the dangling turn, so the log stays appendable', async () => {
    const id = newCcSessionId()
    const log = await dshSession(id)
    const fake = createFakeBackend()
    const session = new CcSession(
      { id, cwd: CWD },
      { backend: fake.backend, config: resolveClaudeCodeConfig() })
    opened.push(session)
    await session.open()
    const query = fake.queries[0]
    if (query === undefined) throw new Error('fake backend built no query')

    const handle = attachMirror(session, log)
    // The service owns this wiring in production; the point of doing it by hand
    // here is that `finalize()` must be driven by the CLOSE, whoever closed.
    session.onClose(() => {
      handle.mirror.finalize()
      handle.dispose()
    })
    session.send('go')
    await settle()
    expect(handle.mirror.hasOpenTurn).toBe(true)

    query.endStream()
    await settle()

    expect(handle.mirror.hasOpenTurn).toBe(false)
    const end = log.events.findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason : undefined)
      .toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })
    // A dangling `turn/start` makes a log permanently unappendable (dsh refuses
    // a second open turn), so this is the assertion that matters: it still takes writes.
    expect(() => log.append('turn/start', { turn: 99 })).not.toThrow()
  })
})

describe('the service registry, when a subprocess dies', () => {
  /**
   * Mount the seam service over a fake backend.
   * @returns the service, the fake backend, and a disposer.
   */
  async function mount(): Promise<{
    service: ClaudeCodeService
    fake: ReturnType<typeof createFakeBackend>
    ctx: Context
  }> {
    const ctx = new Context()
    const fake = createFakeBackend()
    const service = new ClaudeCodeService(ctx, { prewarm: false }, { backend: fake.backend })
    disposers.push(async () => { await ctx.fiber.dispose() })
    return await Promise.resolve({ service, fake, ctx })
  }

  it('drops the dead session from list() and from session(), with no explicit close', async () => {
    const { service, fake } = await mount()
    const snapshot = await service.open({ cwd: CWD, prompt: 'go' })
    expect(service.list()).toHaveLength(1)

    fake.queries[0]?.endStream()
    await settle()

    expect(service.list()).toEqual([])
    expect(service.session(snapshot.id)).toBeUndefined()
    // Nothing to close any more, and saying so is not an error.
    await expect(service.close(snapshot.id)).resolves.toBe(false)
  })

  it('still answers get() for it, with the cause, so a caller learns WHAT happened', async () => {
    const { service, fake } = await mount()
    const snapshot = await service.open({ cwd: CWD, prompt: 'go' })

    fake.queries[0]?.endStream()
    await settle()

    expect(service.get(snapshot.id)).toMatchObject({
      id: snapshot.id,
      status: 'closed',
      closeReason: 'crashed',
    })
  })

  it('never answers get() for an id this context never opened', async () => {
    const { service } = await mount()
    expect(service.get(SessionId('11111111-2222-4333-8444-555555555555'))).toBeUndefined()
  })

  it('bounds the tombstone table rather than growing one entry per session', async () => {
    const { service, fake } = await mount()
    const ids: CcSessionId[] = []
    // Two more than the cap, opened and killed one at a time.
    for (let index = 0; index < 34; index += 1) {
      const snapshot = await service.open({ cwd: CWD })
      ids.push(snapshot.id)
      fake.queries[index]?.endStream()
      await settle()
    }

    const first = ids[0]
    const last = ids[ids.length - 1]
    if (first === undefined || last === undefined) throw new Error('no sessions were opened')
    expect(service.get(first)).toBeUndefined()
    expect(service.get(last)).toMatchObject({ status: 'closed' })
  })

  it('frees the concurrency slot, so the limit is not consumed by corpses', async () => {
    const ctx = new Context()
    const fake = createFakeBackend()
    const service = new ClaudeCodeService(
      ctx, { prewarm: false, limits: { maxConcurrentSessions: 1 } }, { backend: fake.backend })
    disposers.push(async () => { await ctx.fiber.dispose() })

    await service.open({ cwd: CWD, prompt: 'go' })
    fake.queries[0]?.endStream()
    await settle()

    // Before the fix this threw SESSION_LIMIT: the dead session held its slot
    // until somebody closed it by hand.
    await expect(service.open({ cwd: CWD })).resolves.toMatchObject({ status: 'idle' })
  })
})

describe('the ask channel, when a subprocess dies mid-ask', () => {
  it('settles the in-flight approval as a deny rather than stranding the CLI', async () => {
    const id = newCcSessionId()
    const fake = createFakeBackend()
    let released: (() => void) | undefined
    const held = new Promise<void>((resolve) => { released = resolve })
    const router = new CcAskRouter({
      services: {
        // An approval seam that never answers — the human walked away, and then
        // the subprocess died underneath the question.
        approval: () => ({
          request: async () => {
            await held
            return 'allowed-once' as const
          },
        }),
        userQuestions: () => undefined,
      },
      config: resolveClaudeCodeConfig(),
      rules: CcAskRules.forSession(resolveClaudeCodeConfig(), CWD),
    })
    const session = new CcSession(
      { id, cwd: CWD },
      { backend: fake.backend, config: resolveClaudeCodeConfig(), asks: router })
    opened.push(session)
    await session.open()
    const query = fake.queries[0]
    if (query === undefined) throw new Error('fake backend built no query')
    const target: CcAskTarget = {
      agent: { id: SessionId(id), session: { id: SessionId(id) } } as never,
      delegated: false,
    }
    session.attachAskTarget(target)
    session.send('go')

    const decision = query.options.canUseTool?.(
      'Bash', { command: 'echo hi' }, { toolUseID: 'toolu_1', requestId: 'req_1' } as never)
    await settle()
    expect(router.pendingAsks).toBe(1)

    query.endStream()
    await settle()

    // The permission promise RESOLVES (a rejected `canUseTool` hangs the CLI
    // forever — gotcha 9) and it resolves to a deny.
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
    expect(router.pendingAsks).toBe(0)
    released?.()
  })
})
