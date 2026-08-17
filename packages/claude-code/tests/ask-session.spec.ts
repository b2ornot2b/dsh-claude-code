import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CcAskRouter, CcAskRules, CcSession, ClaudeCodeService, newCcSessionId, resolveClaudeCodeConfig,
} from '@deepseek-ai/dsh-claude-code'
import type { CcAskTarget, ClaudeCodeError } from '@deepseek-ai/dsh-claude-code'
import SessionStore from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'

import {
  FakeApproval, FakeQuestions, fakeAgent, makeRequest, RecordingLogger, settle,
} from './ask-helpers.ts'
import { createFakeBackend } from './fake-backend.ts'

/**
 * Wiring: the ask channel inside `CcSession` and `ClaudeCodeService`.
 *
 * The two facts a router-only test cannot show — that `close()` drains the ask
 * table before the query goes away (§5.4), and that the service hands the
 * channel BOTH its target and the mirror it must correlate `callId`s against
 * (§4.4) — live here.
 */

/** Teardown callbacks registered by the current test. */
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/**
 * A temp directory usable as a session `cwd`.
 * @returns its absolute path.
 */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cc-ask-session-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/**
 * Build a router wired to scripted seams, for a session-level test.
 * @param cwd - the session cwd (the rule cache lives under it).
 * @returns the router and its seams.
 */
function router(cwd: string): {
  router: CcAskRouter
  approval: FakeApproval
  questions: FakeQuestions
  target: CcAskTarget
  logger: RecordingLogger
} {
  const config = resolveClaudeCodeConfig()
  const approval = new FakeApproval()
  const questions = new FakeQuestions()
  const logger = new RecordingLogger()
  const made = new CcAskRouter({
    services: { approval: () => undefined, userQuestions: () => undefined },
    config,
    rules: CcAskRules.forSession(config, cwd, logger),
    logger,
  })
  const target: CcAskTarget = { agent: fakeAgent(), delegated: false, approval, userQuestions: questions }
  return { router: made, approval, questions, target, logger }
}

describe('CcSession: the ask channel', () => {
  it('installs the channel\'s callback, reports pendingAsks, and drains the table on close', async () => {
    const cwd = scratch()
    const wired = router(cwd)
    const fake = createFakeBackend()
    const session = new CcSession(
      { id: newCcSessionId(), cwd },
      { backend: fake.backend, config: resolveClaudeCodeConfig(), asks: wired.router })
    await session.open()
    session.attachAskTarget(wired.target)
    const query = fake.queries[0]
    if (query === undefined) throw new Error('fake backend built no query')

    wired.approval.gate = new Promise<void>(() => {})
    const pending = query.options.canUseTool?.('Bash', { command: 'ls' }, makeRequest())
    await settle()

    expect(session.pendingAsks).toBe(1)
    expect(session.snapshot().pendingAsks).toBe(1)

    await session.close()

    // §5.4: asks settle FIRST, so nothing is left holding a promise the closed
    // query can never answer.
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(session.pendingAsks).toBe(0)
  })

  it('refuses to attach a target when the session has no ask channel', async () => {
    const cwd = scratch()
    const fake = createFakeBackend()
    const session = new CcSession(
      { id: newCcSessionId(), cwd },
      { backend: fake.backend, config: resolveClaudeCodeConfig() })
    cleanups.push(async () => await session.close())
    await session.open()

    expect(() => session.attachAskTarget({ agent: fakeAgent(), delegated: false }))
      .toThrow(expect.objectContaining({ code: 'ASK_UNAVAILABLE' }) as unknown as Error)
  })

  it('surfaces an unanswerable ask as a typed session error under the error policy', async () => {
    const cwd = scratch()
    const config = resolveClaudeCodeConfig({ ask: { fallback: 'error' } })
    const logger = new RecordingLogger()
    const questions = new FakeQuestions()
    questions.throws = Object.assign(new Error('delegated'), { code: 'DELEGATED_CALLER' })
    const asks = new CcAskRouter({
      services: { approval: () => undefined, userQuestions: () => undefined },
      config,
      rules: CcAskRules.forSession(config, cwd, logger),
      logger,
    })
    const fake = createFakeBackend()
    const session = new CcSession({ id: newCcSessionId(), cwd }, { backend: fake.backend, config, asks })
    cleanups.push(async () => await session.close())
    await session.open()
    session.attachAskTarget({ agent: fakeAgent(), delegated: true, userQuestions: questions })
    const seen: ClaudeCodeError[] = []
    session.onAskError(error => seen.push(error))

    const decision = await fake.queries[0]?.options.canUseTool?.('AskUserQuestion', {
      questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }],
    }, makeRequest())

    expect(decision).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(seen[0]?.code).toBe('ASK_UNANSWERABLE')
    expect(session.lastAskError?.code).toBe('ASK_UNANSWERABLE')
  })
})

describe('ClaudeCodeService: the ask channel', () => {
  /**
   * Mount the service over a fake backend inside a composition that also
   * provides the two dsh seams.
   * @returns the context, the raw service, the fake backend and the live agent.
   */
  async function mount(): Promise<{
    ctx: Context
    service: ClaudeCodeService
    fake: ReturnType<typeof createFakeBackend>
    agent: Agent
    cwd: string
  }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(ApprovalService, { policy: 'ask' })

    const fake = createFakeBackend()
    let service: ClaudeCodeService | undefined
    function claudeCodeAskMount(inner: Context): void {
      service = new ClaudeCodeService(inner, { prewarm: false }, { backend: fake.backend })
    }
    const fiber = await ctx.plugin(claudeCodeAskMount)
    if (service === undefined) throw new Error('mount did not construct the service')

    const dshSession = ctx.sessions.create(newCcSessionId())
    const agent = { id: dshSession.id, session: dshSession, ctx } as unknown as Agent
    const agentFiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.register(agent)
    }, { inject: ['agents'] }))

    const cwd = scratch()
    cleanups.push(async () => {
      await agentFiber.dispose()
      await fiber.dispose()
      await ctx.fiber.dispose()
    })
    return { ctx, service, fake, agent, cwd }
  }

  it('attaches the open-time ask target and routes through the composition\'s approval seam', async () => {
    const { ctx, service, fake, agent, cwd } = await mount()
    const off = ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
    cleanups.push(() => { off() })

    const snapshot = await service.open({ cwd, ask: { agent, delegated: false } })
    agent.session.append('turn/start', { turn: 1 })

    const decision = await fake.queries[0]?.options.canUseTool?.(
      'Bash', { command: 'ls' }, makeRequest())

    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(service.get(snapshot.id)?.pendingAsks).toBe(0)
  })

  it('attaches a target after the fact through the service', async () => {
    const { ctx, service, fake, agent, cwd } = await mount()
    const off = ctx.on('approval/request', () => Promise.resolve('rejected' as const))
    cleanups.push(() => { off() })

    const snapshot = await service.open({ cwd })
    agent.session.append('turn/start', { turn: 1 })
    const detach = service.attachAskTarget(snapshot.id, { agent, delegated: false })
    cleanups.push(detach)

    expect(await fake.queries[0]?.options.canUseTool?.('Bash', { command: 'ls' }, makeRequest()))
      .toEqual({ behavior: 'deny', message: 'User rejected this action' })
  })

  it('gives the ask channel the mirror as its call site, so approvals carry a real callId (§4.4)', async () => {
    const { ctx, service, fake, agent, cwd } = await mount()
    const seen: (string | undefined)[] = []
    const off = ctx.on('approval/request', (request) => {
      seen.push(request.callId)
      return Promise.resolve('allowed-once' as const)
    })
    cleanups.push(() => { off() })

    const mirrored = ctx.sessions.create(newCcSessionId())
    await service.open({ cwd, ask: { agent, delegated: false }, mirror: { session: mirrored } })
    agent.session.append('turn/start', { turn: 1 })

    await fake.queries[0]?.options.canUseTool?.(
      'Bash', { command: 'ls' }, makeRequest({ toolUseID: 'toolu_mirror' }))

    // The mirror never streamed this call, so §4.4's synthesize path ran: the
    // dsh log now holds the tool/call the prompt refers to.
    expect(seen).toEqual(['toolu_mirror'])
    const call = mirrored.events.find(event => event.type === 'tool/call')
    expect(call).toBeDefined()
    expect(mirrored.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
  })

  it('reports an unknown session id when attaching a target to one', async () => {
    const { service, agent } = await mount()

    expect(() => service.attachAskTarget(newCcSessionId(), { agent, delegated: false }))
      .toThrow(expect.objectContaining({ code: 'UNKNOWN_SESSION' }) as unknown as Error)
  })
})
