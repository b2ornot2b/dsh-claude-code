import type { Agent } from '@deepseek-ai/dsh-agent'
import { newCcSessionId } from '@deepseek-ai/dsh-claude-code'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeCodeAgent, extractMessageText } from '@deepseek-ai/dsh-claude-code-agent'

import { blockMessage, deferred, FakeCcSession, mountSeam, settle, userMessage } from './fake-seam.ts'
import type { MountedSeam } from './fake-seam.ts'

/**
 * The adapter, driven entirely through a scripted seam actor: no subprocess, no
 * network, no credentials. Everything asserted here is a decision the adapter
 * makes about session state — which is exactly the part a live test cannot pin
 * down deterministically.
 */

let mounted: MountedSeam | undefined

afterEach(async () => {
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
  /** Every inbox notification observed, as `<verb>:<text>`. */
  readonly inbox: string[]
}

/**
 * Build one agent over a fresh fake session.
 * @param model - the model the fake reports.
 * @returns the harness.
 */
async function build(model?: string): Promise<Harness> {
  mounted = await mountSeam()
  const ctx = mounted.ctx
  const id = newCcSessionId()
  const cc = new FakeCcSession(id, model)
  const session = ctx.sessions.create(id)
  const statuses: string[] = []
  const inbox: string[] = []
  ctx.on('agent/status', ({ status }) => { statuses.push(status) })
  ctx.on('agent/inbox/inserted', ({ message }) => { inbox.push(`inserted:${text(message)}`) })
  ctx.on('agent/inbox/claimed', ({ message }) => { inbox.push(`claimed:${text(message)}`) })
  ctx.on('agent/inbox/discarded', ({ message }) => { inbox.push(`discarded:${text(message)}`) })
  const agent = new ClaudeCodeAgent({ ctx, session, cc, disposeDrainMs: 20 })
  return { agent, cc, session, statuses, inbox }
}

/**
 * Read a message's text for an assertion label.
 * @param message - the message.
 * @returns its joined text.
 */
function text(message: { content: readonly { type: string }[] }): string {
  return extractMessageText(message as Parameters<typeof extractMessageText>[0]).text
}

describe('ClaudeCodeAgent: identity and interface conformance', () => {
  it('is a dsh Agent with every member the interface declares', async () => {
    const { agent, session } = await build()

    // The compiler proves conformance (`implements Agent` in src, plus this
    // assignment); the runtime check catches a member that exists only in the
    // type because a class field was never initialized.
    const asAgent: Agent = agent
    expect(asAgent.id).toBe(session.id)
    expect(asAgent.session).toBe(session)
    expect(asAgent.status).toBe('idle')
    expect(asAgent.options).toEqual({ provider: 'claude-code' })
    expect(asAgent.inbox.hasPending).toBe(false)
    expect(asAgent.ctx).toBeDefined()
    for (const method of ['cancel', 'whenIdle', 'runMaintenance', 'send', 'followup', 'steer', 'inject'] as const) {
      expect(typeof asAgent[method], method).toBe('function')
    }
  })

  it('carries the agent association on its own scoped context', async () => {
    const { agent } = await build()

    expect(agent.ctx.agent).toBe(agent)
    // A plain context reads `undefined` rather than throwing (the registry's
    // root accessor), which is what makes `ctx.agent` safe to read anywhere.
    expect(mounted?.ctx.agent).toBeUndefined()
  })

  it('refuses a Claude Code session whose id differs from the dsh session (D6)', async () => {
    mounted = await mountSeam()
    const ctx = mounted.ctx
    const session = ctx.sessions.create(newCcSessionId())
    const cc = new FakeCcSession(newCcSessionId())

    expect(() => new ClaudeCodeAgent({ ctx, session, cc }))
      .toThrow(/must share ONE identity/)
  })

  it('reports the model the seam reports, and follows setModel()', async () => {
    const { agent, cc } = await build('claude-haiku-4-5-20251001')
    expect(agent.options).toEqual({ provider: 'claude-code', model: 'claude-haiku-4-5-20251001' })
    // Identity is stable while nothing changes — the snapshot is not rebuilt per read.
    expect(agent.options).toBe(agent.options)

    await agent.setModel('claude-sonnet-4-5')

    expect(cc.models).toEqual(['claude-sonnet-4-5'])
    expect(agent.options).toEqual({ provider: 'claude-code', model: 'claude-sonnet-4-5' })
  })
})

describe('ClaudeCodeAgent: send-mode mapping (§7.1 substitutes)', () => {
  it('routes followup / steer / inject onto the seam\'s three modes', async () => {
    const { agent, cc } = await build()

    agent.followup(userMessage('one'))
    agent.steer(userMessage('two'))
    agent.inject(userMessage('three'))

    expect(cc.sends.map(send => [send.mode, send.text])).toEqual([
      ['followup', 'one'],
      ['steer', 'two'],
      ['inject', 'three'],
    ])
  })

  it('routes wakeup:false to inject regardless of target (the inject-buffer substitute)', async () => {
    const { agent, cc } = await build()

    agent.send(userMessage('no wake, next-turn'), 'next-turn', false)
    agent.send(userMessage('no wake, next-step'), 'next-step', false)

    expect(cc.sends.map(send => send.mode)).toEqual(['inject', 'inject'])
  })

  it('records every send in the durable inbox and claims it when the turn runs', async () => {
    const { agent, cc, inbox } = await build()

    agent.followup(userMessage('one'))
    expect(agent.inbox.nextTurn.map(message => text(message))).toEqual(['one'])
    expect(agent.inbox.hasPending).toBe(true)

    cc.completeTurn()
    await settle()

    expect(agent.inbox.hasPending).toBe(false)
    expect(inbox).toEqual(['inserted:one', 'claimed:one'])
    // A claim is a PURE deletion in the log: recording it as a canceled splice
    // would say the message never ran.
    const splices = agent.session.events.filter(event => event.type === 'agent/inbox/spliced')
    expect(splices.map(event => event.data.outcome)).toEqual([undefined, undefined])
  })

  it('claims an inject as soon as the seam commits it, without waiting for a turn', async () => {
    const { agent, inbox } = await build()

    agent.inject(userMessage('context'))
    // The seam commits an inject at send time (it starts no turn), so the
    // reconciliation that follows the send already claims it.
    expect(agent.inbox.hasPending).toBe(false)
    expect(inbox).toEqual(['inserted:context', 'claimed:context'])
  })

  it('drops a message the seam refused, rather than leaving it pending forever', async () => {
    const { agent, cc, inbox } = await build()
    cc.failNextSend = new Error('claude-code: session is closed')

    agent.followup(userMessage('lost'))

    expect(agent.inbox.hasPending).toBe(false)
    expect(inbox).toEqual(['inserted:lost', 'discarded:lost'])
  })
})

describe('ClaudeCodeAgent: non-text content', () => {
  it('reduces a message to its text blocks and reports what was dropped', () => {
    const message = blockMessage([
      { type: 'text', text: 'first' },
      { type: 'tool-call', id: 'call-1' as never, name: 'Bash', arguments: '{}' },
      { type: 'text', text: 'second' },
    ])

    expect(extractMessageText(message)).toEqual({ text: 'first\n\nsecond', dropped: ['tool-call'] })
  })

  it('sends the text and records the loss as a notice in the transcript', async () => {
    const { agent, cc, session } = await build()

    agent.followup(blockMessage([
      { type: 'text', text: 'look at this' },
      { type: 'reasoning', text: 'internal' },
    ]))

    expect(cc.sends.map(send => send.text)).toEqual(['look at this'])
    const notices = session.events.filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(notices).toHaveLength(1)
    const source = notices[0]?.type === 'user/message' ? notices[0].data.source : undefined
    expect(source).toMatchObject({ kind: 'plugin', plugin: 'dsh-claude-code-agent', form: 'notice' })
    expect(String((source as { summary?: string } | undefined)?.summary)).toContain('reasoning')
  })

  it('sends nothing at all for a message with no text, and leaves the inbox untouched', async () => {
    const { agent, cc, session } = await build()

    agent.followup(blockMessage([
      { type: 'reasoning', text: 'internal only' },
    ]))

    expect(cc.sends).toEqual([])
    expect(agent.inbox.hasPending).toBe(false)
    const notices = session.events.filter(event => event.type === 'user/message')
    expect(notices).toHaveLength(1)
    expect(agent.status).toBe('idle')
  })
})

describe('ClaudeCodeAgent: status transitions', () => {
  it('starts idle while the seam is still starting, and follows every seam transition', async () => {
    const { agent, cc, statuses } = await build()
    expect(cc.status).toBe('starting')
    expect(agent.status).toBe('idle')

    agent.followup(userMessage('go'))
    expect(agent.status).toBe('running')

    cc.completeTurn()
    await settle()
    expect(agent.status).toBe('idle')

    expect(statuses).toEqual(['running', 'idle'])
  })

  it('follows a turn Claude Code started on its own', async () => {
    const { agent, cc, statuses } = await build()

    cc.setStatus('running')
    expect(agent.status).toBe('running')
    cc.setStatus('idle')
    expect(agent.status).toBe('idle')

    expect(statuses).toEqual(['running', 'idle'])
  })

  it('reads idle after the session closes — disposal is not a third status', async () => {
    const { agent, cc, statuses } = await build()
    agent.followup(userMessage('go'))
    expect(agent.status).toBe('running')

    cc.close()

    expect(agent.status).toBe('idle')
    expect(statuses).toEqual(['running', 'idle'])
  })
})

describe('ClaudeCodeAgent: cancel and inbox reconciliation', () => {
  it('keeps queued work by default (the seam\'s drain is emulated and lossy)', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('one'))

    agent.cancel({ kind: 'user' })
    await settle()

    expect(cc.interrupts).toEqual([{ keepQueued: true }])
    // Still pending: the receipt said it survives, so the inbox must agree.
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })

  it('maps keepInbox:false onto keepQueued:false and discards what the seam cancelled', async () => {
    const { agent, cc, inbox } = await build()
    agent.followup(userMessage('one'))
    agent.followup(userMessage('two'))

    agent.cancel({ kind: 'user' }, { keepInbox: false })
    await settle()

    expect(cc.interrupts).toEqual([{ keepQueued: false }])
    expect(agent.inbox.hasPending).toBe(false)
    expect(inbox).toEqual([
      'inserted:one', 'inserted:two', 'discarded:one', 'discarded:two',
    ])
    // A discard IS a cancellation, and the durable splice says so.
    const splices = agent.session.events.filter(event => event.type === 'agent/inbox/spliced')
    expect(splices.filter(event => event.data.outcome === 'canceled')).toHaveLength(2)
  })

  it('is a no-op with no active activity, and does not arm later work', async () => {
    const { agent, cc } = await build()

    agent.cancel({ kind: 'user' })
    await settle()

    expect(cc.interrupts).toEqual([])
    agent.followup(userMessage('after'))
    expect(cc.sends).toHaveLength(1)
  })

  it('does not reach a closed session', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('one'))
    cc.close()

    agent.cancel({ kind: 'user' })
    await settle()

    expect(cc.interrupts).toEqual([])
  })
})

describe('ClaudeCodeAgent: whenIdle', () => {
  it('waits for the turn AND for everything queued behind it', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('one'))

    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    cc.completeTurn()
    await idle
    expect(settled).toBe(true)
  })

  it('resolves immediately when nothing is in flight', async () => {
    const { agent } = await build()
    await expect(agent.whenIdle()).resolves.toBeUndefined()
  })

  it('resolves once the session closes, even with work the seam never ran', async () => {
    const { agent, cc } = await build()
    agent.followup(userMessage('one'))
    const idle = agent.whenIdle()

    cc.close()

    await expect(idle).resolves.toBeUndefined()
  })
})

describe('ClaudeCodeAgent: runMaintenance (D7 note 8)', () => {
  it('throws SYNCHRONOUSLY when another maintenance task already owns the agent', async () => {
    const { agent } = await build()
    const release = deferred()
    const first = agent.runMaintenance(async () => { await release.promise })

    expect(() => agent.runMaintenance(async () => Promise.resolve()))
      .toThrow(/already has an active maintenance task/)

    release.resolve()
    await first
  })

  it('throws SYNCHRONOUSLY while a turn is running', async () => {
    const { agent } = await build()
    agent.followup(userMessage('go'))

    expect(() => agent.runMaintenance(async () => Promise.resolve()))
      .toThrow(/cannot start a maintenance task/)
  })

  it('keeps public status idle and holds waking input until the task settles', async () => {
    const { agent, cc } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => { await release.promise })

    agent.followup(userMessage('held'))
    expect(agent.status).toBe('idle')
    expect(cc.sends).toEqual([])
    // It is in the inbox meanwhile — dsh's contract, verbatim.
    expect(agent.inbox.nextTurn).toHaveLength(1)

    release.resolve()
    await task
    await settle()

    expect(cc.sends.map(send => send.mode)).toEqual(['followup'])
    expect(agent.status).toBe('running')
  })

  it('delivers a non-waking inject immediately — it starts no turn', async () => {
    const { agent, cc } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => { await release.promise })

    agent.inject(userMessage('context'))
    expect(cc.sends.map(send => send.mode)).toEqual(['inject'])

    release.resolve()
    await task
  })

  it('discards parked work on a keepInbox:false cancel — it never reached the subprocess', async () => {
    const { agent, cc, inbox } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => { await release.promise })
    agent.followup(userMessage('held'))

    agent.cancel({ kind: 'user' }, { keepInbox: false })

    // Nothing to interrupt: the message never left this process.
    expect(cc.interrupts).toEqual([])
    expect(agent.inbox.hasPending).toBe(false)
    expect(inbox).toEqual(['inserted:held', 'discarded:held'])

    release.resolve()
    await task
    await settle()
    expect(cc.sends).toEqual([])
  })

  it('preserves the task\'s rejection and releases the phase', async () => {
    const { agent } = await build()

    await expect(agent.runMaintenance(async () => {
      await Promise.resolve()
      throw new Error('compaction failed')
    })).rejects.toThrow('compaction failed')

    // The phase is free again.
    await expect(agent.runMaintenance(async () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('aborts the task\'s signal on cancel, carrying the cause', async () => {
    const { agent } = await build()
    let reason: unknown
    const task = agent.runMaintenance(async (signal) => {
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => { resolve() }) })
      reason = signal.reason
    })

    agent.cancel({ kind: 'hook', reason: 'policy' })
    await task

    expect(reason).toEqual({ kind: 'hook', reason: 'policy' })
  })

  it('blocks whenIdle() while it runs, and releases held work behind it', async () => {
    const { agent, cc } = await build()
    const release = deferred()
    const task = agent.runMaintenance(async () => { await release.promise })
    agent.followup(userMessage('behind'))

    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    release.resolve()
    await task
    await settle()
    expect(settled).toBe(false)

    cc.completeTurn()
    await idle
    expect(settled).toBe(true)
  })
})
