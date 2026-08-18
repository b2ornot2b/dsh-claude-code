import { tmpdir } from 'node:os'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CcSessionId } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { createClaudeCodeAgent } from '@deepseek-ai/dsh-claude-code-agent'
import type { CcAgentHandle } from '@deepseek-ai/dsh-claude-code-agent'

import { mountSeam, settle, userMessage } from './fake-seam.ts'
import type { MountedSeam } from './fake-seam.ts'

/**
 * The spawn/teardown contract, against the REAL `SessionStore` and
 * `AgentRegistry` (the registration rules and the disposal order are only
 * meaningful against those), with the Claude Code SDK replaced by the seam's
 * own fake backend so nothing spawns.
 */

let mounted: MountedSeam | undefined

afterEach(async () => {
  await mounted?.dispose()
  mounted = undefined
})

/** A spawned agent plus everything a test needs to drive its session. */
interface Spawned {
  readonly handle: CcAgentHandle
  readonly id: CcSessionId
  readonly ctx: MountedSeam['ctx']
  /** Deliver one `result` message — the Claude Code turn boundary. */
  endTurn(): Promise<void>
}

/**
 * Spawn one agent over the fake backend.
 * @param options - extra open options.
 * @returns the handle and its driving surface.
 */
async function spawn(options: { readonly prompt?: string } = {}): Promise<Spawned> {
  mounted = await mountSeam()
  const seam = mounted
  const handle = await createClaudeCodeAgent(
    seam.ctx,
    { cwd: tmpdir(), ...options },
    { disposeDrainMs: 20 })
  return {
    handle,
    id: handle.agent.id,
    ctx: seam.ctx,
    endTurn: async () => {
      const query = seam.fake.queries[0]
      if (query === undefined) throw new Error('the fake backend built no query')
      await query.emitResult()
    },
  }
}

describe('createClaudeCodeAgent: publication', () => {
  it('publishes one agent whose id is its session\'s id, as a registry ROOT', async () => {
    const { handle, id, ctx } = await spawn()

    expect(ctx.agents.get(id)).toBe(handle.agent)
    expect(ctx.agents.list()).toHaveLength(1)
    // A root, not a delegate: `register()` records no owner, which is exactly
    // what makes `ctx.userQuestions.ask()` legal for this agent.
    expect(ctx.agents.roots().map((agent: Agent) => agent.id)).toEqual([id])
    expect(ctx.sessions.get(id)).toBe(handle.agent.session)
    expect(ctx.claudeCode.list().map(snapshot => snapshot.id)).toEqual([id])
  })

  it('announces creation and the session lifecycle, in that order', async () => {
    mounted = await mountSeam()
    const ctx = mounted.ctx
    const seen: string[] = []
    ctx.on('session/created', () => { seen.push('session/created') })
    ctx.on('agent/created', ({ agent }) => { seen.push(`agent/created:${agent.id}`) })
    ctx.on('agent/session-start', ({ source }) => { seen.push(`agent/session-start:${source}`) })

    const handle = await createClaudeCodeAgent(ctx, { cwd: tmpdir() }, { disposeDrainMs: 20 })

    expect(seen).toEqual([
      'session/created',
      `agent/created:${handle.agent.id}`,
      'agent/session-start:startup',
    ])
  })

  it('mirrors the opening prompt into the dsh session log', async () => {
    const { handle } = await spawn({ prompt: 'summarize this repo' })
    await settle()

    const events = handle.agent.session.events.map(event => event.type)
    expect(events).toContain('turn/start')
    expect(events).toContain('user/message')
    const prompt = handle.agent.session.events.find(event => event.type === 'user/message')
    expect(prompt?.type === 'user/message' ? prompt.data.content : undefined)
      .toEqual([{ type: 'text', text: 'summarize this repo' }])
    // The prompt goes through the agent, so it is durable pending work too.
    expect(handle.agent.inbox.nextTurn).toHaveLength(1)
  })

  it('refuses a composition missing one of the three services it needs', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const bare = new Context()
    await expect(createClaudeCodeAgent(bare, { cwd: tmpdir() }))
      .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'INVALID_CONFIG' })
    await bare.fiber.dispose()
  })

  it('re-throws what the seam refuses, untouched, having opened nothing', async () => {
    mounted = await mountSeam()
    await expect(createClaudeCodeAgent(mounted.ctx, { cwd: 'relative/not-allowed' }))
      .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'INVALID_CWD' })
    expect(mounted.ctx.agents.list()).toEqual([])
    expect(mounted.ctx.claudeCode.list()).toEqual([])
  })
})

describe('createClaudeCodeAgent: teardown', () => {
  it('leaves nothing behind: no registry entry, no session, no live seam session', async () => {
    const { handle, id, ctx } = await spawn({ prompt: 'hello' })
    await settle()

    await handle.dispose()

    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(ctx.claudeCode.list()).toEqual([])
    expect(ctx.claudeCode.session(id)).toBeUndefined()
    expect(mounted?.fake.queries[0]?.closed).toBe(true)
  })

  it('is idempotent', async () => {
    const { handle } = await spawn()
    await handle.dispose()
    await expect(handle.dispose()).resolves.toBeUndefined()
  })

  it('disposes in the ONE order the exact-disposer rule buys', async () => {
    const { handle, id, ctx } = await spawn({ prompt: 'start a turn' })
    await settle()
    // A turn is open and will never get its result — the mid-turn death the
    // mirror's `finalize()` exists for.
    expect(handle.agent.status).toBe('running')

    let atDisposal: { sessionLive: boolean, ccLive: boolean, turnClosed: boolean } | undefined
    ctx.on('agent/disposed', ({ agent }) => {
      atDisposal = {
        // The session is still attached: its publication hooks were live for
        // every closing event the mirror just wrote.
        sessionLive: ctx.sessions.get(agent.id) !== undefined,
        // The subprocess is already gone. Probed through `session()` — the
        // LIVE-actor lookup — because `get()` deliberately keeps answering for
        // a bounded while after a close (the closed-session tombstone), so it
        // is no longer the question "is this still running?".
        ccLive: ctx.claudeCode.session(agent.id) !== undefined,
        // …and the mirror closed the turn it left open.
        turnClosed: agent.session.events.some(event => event.type === 'turn/end'),
      }
    })

    await handle.dispose()

    expect(atDisposal).toEqual({ sessionLive: true, ccLive: false, turnClosed: true })
    const end = handle.agent.session.events.findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason : undefined)
      .toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('interrupts before closing, so a live turn is cancelled rather than severed', async () => {
    const { handle } = await spawn({ prompt: 'start a turn' })
    await settle()

    await handle.dispose()

    expect(mounted?.fake.queries[0]?.interruptCount).toBe(1)
  })

  it('does not wedge unload on a session that never reaches quiescence', async () => {
    const { handle } = await spawn({ prompt: 'start a turn' })
    await settle()

    // No result is ever emitted: the bounded drain is what lets this resolve.
    const started = Date.now()
    await handle.dispose()

    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('tears everything down when the owning fiber unloads instead (HMR)', async () => {
    const { id, ctx } = await spawn({ prompt: 'hello' })
    await settle()

    await ctx.fiber.dispose()

    expect(ctx.get('agents')).toBeUndefined()
    expect(mounted?.fake.queries[0]?.closed).toBe(true)
    // Nothing tried to keep driving the dead session.
    expect(ctx.get('sessions')?.get(id)).toBeUndefined()
    mounted = undefined
  })

  it('settles a completed turn before disposal without an interrupt receipt in flight', async () => {
    const { handle, endTurn } = await spawn({ prompt: 'hello' })
    await endTurn()

    expect(handle.agent.status).toBe('idle')
    expect(handle.agent.inbox.hasPending).toBe(false)
    await handle.dispose()
    expect(handle.agent.status).toBe('idle')
  })
})

describe('createClaudeCodeAgent: driving a published agent', () => {
  it('routes a followup through the seam and frames it in the mirror', async () => {
    const { handle, endTurn } = await spawn({ prompt: 'first' })
    await endTurn()

    handle.agent.followup(userMessage('second'))
    await endTurn()

    const prompts = handle.agent.session.events
      .filter(event => event.type === 'user/message')
      .map(event => event.type === 'user/message' ? event.data.content : [])
    expect(prompts).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'second' }],
    ])
    expect(handle.agent.inbox.hasPending).toBe(false)
  })

  it('switches the model through the seam\'s passthrough', async () => {
    const { handle } = await spawn()

    await handle.agent.setModel('claude-sonnet-4-5')

    expect(mounted?.fake.queries[0]?.models).toEqual(['claude-sonnet-4-5'])
    expect(handle.agent.options.model).toBe('claude-sonnet-4-5')
  })
})
