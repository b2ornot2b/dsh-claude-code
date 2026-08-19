import { tmpdir } from 'node:os'

import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { newCcSessionId } from '@deepseek-ai/dsh-claude-code'
import type { CcSessionId } from '@deepseek-ai/dsh-claude-code'
import { SessionStore } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClaudeCodeAgent, createClaudeCodeAgent } from '@deepseek-ai/dsh-claude-code-agent'

import { blockMessage, deferred, FakeCcSession, mountSeam, settle, userMessage } from './fake-seam.ts'
import type { MountedSeam } from './fake-seam.ts'

/**
 * The ADVERSARIAL orderings probe: the interleavings a happy-path suite does not
 * reach — an abort-and-refold window, a maintenance phase racing a followup, an
 * outbox that cannot account for a pending message, a spawn that fails after the
 * subprocess is already live, and every disposal entry called twice or at once.
 *
 * Every case here is a decision the adapter makes about ORDER, which is exactly
 * what a live test cannot pin down deterministically.
 */

let mounted: MountedSeam | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await mounted?.dispose()
  mounted = undefined
})

/** One agent over a scripted seam actor, with a real dsh session behind it. */
interface Harness {
  readonly agent: ClaudeCodeAgent
  readonly cc: FakeCcSession
  readonly session: Session
  /** Every `agent/status` transition observed, in order. */
  readonly statuses: string[]
}

/**
 * Build one agent over a fresh fake session.
 * @returns the harness.
 */
async function build(): Promise<Harness> {
  mounted = await mountSeam()
  const ctx = mounted.ctx
  const id = newCcSessionId()
  const cc = new FakeCcSession(id)
  const session = ctx.sessions.create(id)
  const statuses: string[] = []
  ctx.on('agent/status', ({ status }) => { statuses.push(status) })
  const agent = new ClaudeCodeAgent({ ctx, session, cc, disposeDrainMs: 20 })
  return { agent, cc, session, statuses }
}

describe('steer: the abort-and-refold window', () => {
  it('never reports idle between the aborted turn\'s artifact and the refold', async () => {
    const { agent, cc, statuses } = await build()
    agent.followup(userMessage('long task'))
    expect(agent.status).toBe('running')

    agent.steer(userMessage('actually, BANANA'))
    // The abort artifact arrives. The real actor suppresses it from its turn
    // machine, so the session is STILL running — and the adapter must not
    // publish a phantom idle a UI would render as "done".
    cc.emitSteerArtifact()
    await settle()

    expect(agent.status).toBe('running')
    expect(statuses).toEqual(['running'])

    // The refold turn is the one that actually ends, and it commits BOTH.
    cc.completeTurn()
    await settle()
    expect(statuses).toEqual(['running', 'idle'])
    expect(agent.inbox.hasPending).toBe(false)
  })

  it('keeps the steer pending until the refold turn commits it', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('long task'))
    agent.steer(userMessage('BANANA'))

    expect(cc.sends.map(send => send.mode)).toEqual(['followup', 'steer'])
    cc.emitSteerArtifact()
    await settle()
    // Nothing committed, so nothing is claimed: the steer is still owed.
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })
})

describe('runMaintenance racing a followup', () => {
  it('excludes the claim: a waking send parks and is delivered only after the task settles', async () => {
    const { agent, cc } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => { await release.promise })

    agent.followup(userMessage('one'))
    agent.followup(userMessage('two'))
    expect(cc.sends).toEqual([])
    expect(agent.status).toBe('idle')

    // A second claim is refused SYNCHRONOUSLY while the first still owns the phase.
    expect(() => agent.runMaintenance(async () => Promise.resolve())).toThrow(/already has an active maintenance task/)

    release.resolve()
    await task
    await settle()
    // Delivered oldest first, in the order they were sent.
    expect(cc.sends.map(send => send.text)).toEqual(['one', 'two'])
  })

  it('does not deadlock whenIdle(): parked work settles it only once the turn behind it ends', async () => {
    const { agent, cc } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => { await release.promise })
    agent.followup(userMessage('queued during maintenance'))

    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    release.resolve()
    await task
    await settle()
    // The task is gone but the message it held is now a running turn.
    expect(settled).toBe(false)
    expect(agent.status).toBe('running')

    cc.completeTurn()
    await idle
    expect(settled).toBe(true)
    expect(agent.inbox.hasPending).toBe(false)
  })

  it('a task that rejects still releases parked work rather than stranding it', async () => {
    const { agent, cc } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => {
      await release.promise
      throw new Error('compaction failed')
    })
    agent.followup(userMessage('behind a failure'))

    release.resolve()
    await expect(task).rejects.toThrow('compaction failed')
    await settle()

    expect(cc.sends.map(send => send.text)).toEqual(['behind a failure'])
    expect(agent.status).toBe('running')
  })
})

describe('inbox reconciliation against an outbox that cannot account for everything', () => {
  it('ignores uuids it never issued — a concurrent claude_code_send on the same session', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('mine'))
    // Somebody else (the Phase 4 tool) sends on the SAME seam session.
    cc.send('not the agent\'s', { mode: 'followup' })

    cc.completeTurn()
    await settle()

    // The stranger's uuid is in the outbox and simply is not the agent's problem.
    expect(cc.outbox()).toHaveLength(2)
    expect(agent.inbox.hasPending).toBe(false)
    expect(agent.status).toBe('idle')
  })

  it('leaves a message pending when the outbox forgets its uuid, and still settles whenIdle', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('orphaned'))
    const uuid = cc.sends[0]?.uuid
    if (uuid === undefined) throw new Error('the fake recorded no send')
    cc.dropOutboxEntry(uuid)

    cc.completeTurn()
    await settle()

    // Honest, if unhappy: the adapter will not claim what the seam cannot
    // confirm ran. It also does not crash, and quiescence does NOT depend on
    // the inbox, so nothing wedges.
    expect(agent.inbox.nextTurn).toHaveLength(1)
    await expect(agent.whenIdle()).resolves.toBeUndefined()
  })

  it('does not claim a committed next-turn head while an uncommitted next-step is ahead of it', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('turn'))
    agent.steer(userMessage('step'))
    // Commit ONLY the followup, leaving the steer queued.
    const followupUuid = cc.sends[0]?.uuid
    if (followupUuid === undefined) throw new Error('the fake recorded no send')
    cc.commitOnly(followupUuid)
    await settle()

    // `claim('next-turn')` takes the whole next-step list too, so issuing it
    // here would claim a message that has not run.
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })
})

describe('the reconcile hot path', () => {
  it('reads the event log only when a claim is actually owed', async () => {
    const { agent, cc, session } = await build()
    // `Session.events` rebuilds and freezes a copy of the WHOLE log on every
    // read after an append. The mirror appends per streamed chunk, so a
    // reconcile that reads it unconditionally is quadratic in session length.
    const events = vi.spyOn(session, 'events', 'get')

    // Idle, nothing pending: hundreds of chunks must cost nothing.
    for (let index = 0; index < 200; index += 1) cc.emit({ type: 'stream_event' })
    expect(events).not.toHaveBeenCalled()

    // With work in flight it still must not read per chunk — only when the
    // outbox says something committed.
    agent.followup(userMessage('go'))
    for (let index = 0; index < 200; index += 1) cc.emit({ type: 'stream_event' })
    expect(events).not.toHaveBeenCalled()

    cc.completeTurn()
    await settle()
    expect(events).toHaveBeenCalledTimes(1)
    expect(agent.inbox.hasPending).toBe(false)
  })
})

describe('the seam session dying underneath the agent', () => {
  it('settles status, whenIdle and a drain the moment the seam closes mid-turn', async () => {
    const { agent, cc, statuses } = await build()
    agent.followup(userMessage('never finishes'))
    expect(agent.status).toBe('running')

    const idle = agent.whenIdle()
    cc.close()
    await settle()

    expect(agent.status).toBe('idle')
    expect(statuses).toEqual(['running', 'idle'])
    await expect(idle).resolves.toBeUndefined()
    // Draining a corpse must not reach for it, and must not wait out the bound.
    await expect(agent.drain()).resolves.toBeUndefined()
    expect(cc.interrupts).toEqual([])
  })

  it('drops a send the closed seam refuses instead of leaving it pending forever', async () => {
    const { agent, cc } = await build()
    cc.close()
    await settle()

    cc.failNextSend = new Error('claude-code: session is closed')
    agent.followup(userMessage('too late'))

    expect(agent.inbox.hasPending).toBe(false)
    await expect(agent.whenIdle()).resolves.toBeUndefined()
  })

  it('reaches idle when the subprocess dies mid-turn, because the seam closes itself', async () => {
    mounted = await mountSeam()
    const seam = mounted
    const handle = await createClaudeCodeAgent(
      seam.ctx, { cwd: tmpdir(), prompt: 'go' }, { disposeDrainMs: 20 })
    const query = seam.fake.queries[0]
    if (query === undefined) throw new Error('the fake backend built no query')
    expect(handle.agent.status).toBe('running')
    const idle = handle.agent.whenIdle()

    // The subprocess dies: the SDK's iterator completes and the seam's pump
    // ends. The seam now runs its OWN close path (api-contract correction 42's
    // fix), so everything downstream of a close happens without anyone asking.
    query.endStream()
    await settle()

    // The turn was in flight, so this is a crash, not an orderly exit — and the
    // snapshot says which. This assertion is the inverse of the Phase 6 probe
    // that pinned the gap; it was written to fail exactly here when the seam
    // learned to self-close.
    expect(seam.ctx.claudeCode.get(handle.agent.id)?.status).toBe('closed')
    expect(seam.ctx.claudeCode.get(handle.agent.id)?.closeReason).toBe('crashed')
    expect(handle.agent.status).toBe('idle')
    // The parked wait settles instead of hanging until disposal's bounded drain.
    await expect(idle).resolves.toBeUndefined()
    // And the phase is claimable again, which it was not while status stuck at
    // `running` — `runMaintenance()` refused every claim.
    await expect(handle.agent.runMaintenance(async () => {})).resolves.toBeUndefined()

    // Disposal still works, and still promptly: there is nothing left to drain.
    const started = Date.now()
    await handle.dispose()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(seam.ctx.agents.get(handle.agent.id)).toBeUndefined()
  })

  it('reports an orderly exit as `exited`, not as a crash, when no turn was in flight', async () => {
    mounted = await mountSeam()
    const seam = mounted
    const handle = await createClaudeCodeAgent(seam.ctx, { cwd: tmpdir() }, { disposeDrainMs: 20 })
    const query = seam.fake.queries[0]
    if (query === undefined) throw new Error('the fake backend built no query')
    expect(handle.agent.status).toBe('idle')

    query.endStream()
    await settle()

    expect(seam.ctx.claudeCode.get(handle.agent.id)?.closeReason).toBe('exited')
    expect(handle.agent.status).toBe('idle')
    await handle.dispose()
  })

  it('refuses a cancel against a closed session rather than throwing at the caller', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('go'))
    cc.close()
    await settle()

    expect(() => { agent.cancel({ kind: 'user' }, { keepInbox: false }) }).not.toThrow()
    expect(cc.interrupts).toEqual([])
  })
})

describe('send() with non-text blocks', () => {
  it('parks nothing and enters nothing for a message with no text, even mid-maintenance', async () => {
    const { agent, cc } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => { await release.promise })

    agent.followup(blockMessage([{ type: 'reasoning', text: 'internal only' }]))
    expect(agent.inbox.hasPending).toBe(false)

    release.resolve()
    await task
    await settle()
    // Nothing was parked, so nothing is flushed.
    expect(cc.sends).toEqual([])
  })

  it('records the loss even when the session log refuses the notice', async () => {
    const { agent, cc, session } = await build()
    const append = vi.spyOn(session, 'append').mockImplementation(() => {
      throw new Error('log is sealed')
    })

    expect(() => {
      agent.followup(blockMessage([
        { type: 'text', text: 'look at this' },
        { type: 'reasoning', text: 'internal only' },
      ]))
    }).toThrow('log is sealed')

    // The throw came from the INBOX append, not from the notice: the notice's
    // own failure is swallowed. Restore and prove the send still happens.
    append.mockRestore()
    agent.followup(blockMessage([
      { type: 'text', text: 'look at this' },
      { type: 'reasoning', text: 'internal only' },
    ]))
    expect(cc.sends.map(send => send.text)).toEqual(['look at this'])
  })
})

describe('spawn failing after the subprocess is live', () => {
  /**
   * Spawn against a mounted seam, expecting the attempt to fail.
   * @returns the error the spawn threw.
   */
  async function failedSpawn(): Promise<{ readonly error: unknown, readonly seam: MountedSeam }> {
    mounted = await mountSeam()
    const seam = mounted
    let error: unknown
    try {
      await createClaudeCodeAgent(seam.ctx, { cwd: tmpdir() }, { disposeDrainMs: 20 })
    } catch (thrown) {
      error = thrown
    }
    return { error, seam }
  }

  it('closes the just-opened seam session when prepare() refuses the id', async () => {
    vi.spyOn(SessionStore.prototype, 'prepare').mockImplementation(() => {
      throw new Error('session "x" already exists')
    })
    const { error, seam } = await failedSpawn()

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/already exists/)
    // No stranded subprocess, no half-registered agent, no dsh session.
    expect(seam.ctx.claudeCode.list()).toEqual([])
    expect(seam.ctx.agents.list()).toEqual([])
    expect(seam.fake.queries.every(query => query.closed)).toBe(true)
  })

  it('unwinds the session attachment and closes the seam when register() refuses the agent', async () => {
    let registered: CcSessionId | undefined
    vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation(function (this: AgentRegistry, agent) {
      registered = agent.id as CcSessionId
      throw new Error(`agent "${agent.id}" is already registered`)
    })
    const { error, seam } = await failedSpawn()

    expect((error as Error).message).toMatch(/is already registered/)
    expect(registered).toBeDefined()
    // The composite effect unwound everything it had already yielded.
    expect(seam.ctx.sessions.get(registered as unknown as SessionId)).toBeUndefined()
    expect(seam.ctx.agents.list()).toEqual([])
    expect(seam.ctx.claudeCode.list()).toEqual([])
    expect(seam.fake.queries.every(query => query.closed)).toBe(true)
  })
})

describe('disposal called twice, and at once', () => {
  it('is safe when both callers dispose concurrently', async () => {
    mounted = await mountSeam()
    const seam = mounted
    const handle = await createClaudeCodeAgent(seam.ctx, { cwd: tmpdir() }, { disposeDrainMs: 20 })
    const id = handle.agent.id

    await Promise.all([handle.dispose(), handle.dispose(), handle.dispose()])

    expect(seam.ctx.agents.get(id)).toBeUndefined()
    expect(seam.ctx.sessions.get(id)).toBeUndefined()
    // The live actor is gone; `get()` still answers from the tombstone.
    expect(seam.ctx.claudeCode.session(id)).toBeUndefined()
    expect(seam.ctx.claudeCode.get(id)).toMatchObject({ status: 'closed' })
  })

  it('emits agent/disposed exactly once across a dispose() and a fiber unload', async () => {
    mounted = await mountSeam()
    const seam = mounted
    const disposed: string[] = []
    seam.ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id) })
    const handle = await createClaudeCodeAgent(seam.ctx, { cwd: tmpdir() }, { disposeDrainMs: 20 })

    await handle.dispose()
    await handle.dispose()
    await seam.ctx.fiber.dispose()
    mounted = undefined

    expect(disposed).toEqual([handle.agent.id])
  })

  it('yields the EXACT disposer register() returned, so it is a step in the chain', async () => {
    mounted = await mountSeam()
    const seam = mounted
    const handle = await createClaudeCodeAgent(seam.ctx, { cwd: tmpdir() }, { disposeDrainMs: 20 })

    // A cordis effect's disposer carries its own metadata; a yielded disposer is
    // re-parented into the composite effect as a CHILD, keeping its label. A
    // wrapper (`yield () => detach()`) would lose the symbol and the child.
    const composite = seam.ctx.fiber.getEffects()
      .find(effect => effect.label === `claudeCodeAgent(${handle.agent.id})`)
    expect(composite).toBeDefined()
    expect(composite?.children.map(child => child.label)).toContain('agents.register()')

    await handle.dispose()
  })
})

describe('teardown under every other entry', () => {
  it('tears down cleanly when the seam session was already closed from underneath it', async () => {
    mounted = await mountSeam()
    const seam = mounted
    const handle = await createClaudeCodeAgent(
      seam.ctx, { cwd: tmpdir(), prompt: 'go' }, { disposeDrainMs: 20 })
    const id = handle.agent.id

    // Somebody closes the Claude Code session directly — the seam's own
    // teardown loop, a `claude_code_close` tool call, a dead subprocess reaped.
    await seam.ctx.claudeCode.close(id)
    await settle()
    expect(handle.agent.status).toBe('idle')

    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(seam.ctx.agents.get(id)).toBeUndefined()
    expect(seam.ctx.sessions.get(id)).toBeUndefined()
  })

  it('unloads the owning fiber mid-turn without waiting out the drain bound', async () => {
    mounted = await mountSeam()
    const seam = mounted
    const handle = await createClaudeCodeAgent(
      seam.ctx, { cwd: tmpdir(), prompt: 'a turn nobody will finish' }, { disposeDrainMs: 50 })
    const id = handle.agent.id
    expect(handle.agent.status).toBe('running')

    // Read through the services BEFORE they unmount with the root fiber.
    const agents = seam.ctx.get('agents')
    const sessions = seam.ctx.get('sessions')
    const started = Date.now()
    await seam.ctx.fiber.dispose()
    mounted = undefined

    // The interrupt's abort result never arrives (the fake query answers
    // nothing), so this is the BOUNDED path — it must end, and near the bound.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(agents?.get(id)).toBeUndefined()
    expect(sessions?.get(id)).toBeUndefined()
    // The mirror's finalize() closed the dangling turn on the way out.
    const ended = handle.agent.session.events.filter(event => event.type === 'turn/end')
    expect(ended).toHaveLength(1)
  })
})
