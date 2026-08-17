import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CC_PLAN_REVIEW_ID, CcAskRouter, CcAskRules, resolveClaudeCodeConfig,
} from '@deepseek-ai/dsh-claude-code'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'

import { makeRequest, RecordingLogger } from './ask-helpers.ts'

/**
 * The ask channel against the REAL dsh seams (the Phase 0 composition spike
 * proved `SessionStore` + `AgentRegistry` + `ApprovalService` +
 * `UserQuestionService` all mount in-memory, offline, with no LLM and no agent
 * loop).
 *
 * These are the tests a double cannot honestly write: the open-turn guard, the
 * `policy: 'never'` fold, the registry liveness gate, and `ask()`'s own intent
 * validation. Everything here is behaviour of the seam we are integrating with,
 * so faking it would only assert our own assumptions back at us.
 */

/** Teardown callbacks registered by the current test. */
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** A live dsh composition with all four seams mounted. */
interface Harness {
  /** The root context. */
  readonly ctx: Context
  /** The registered agent (the exact live instance the seams check for). */
  readonly agent: Agent
  /** Its session. */
  readonly session: Session
  /** The router under test. */
  readonly router: CcAskRouter
  /** Its logger. */
  readonly logger: RecordingLogger
}

/**
 * Mount the four dsh seams, register one minimal live agent, and point a router
 * at the composition (no target-level overrides: every seam is resolved through
 * `ctx.get(...)`, exactly as production does).
 *
 * @param options - approval policy and the seam's own configuration.
 * @returns the harness.
 */
async function mount(options: {
  policy?: 'ask' | 'never'
  fallback?: 'deny' | 'first-option' | 'error'
  delegated?: boolean
} = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService, { policy: options.policy ?? 'ask' })

  const id = SessionId('cc-ask-seams')
  const session = ctx.sessions.create(id)
  // The minimal live Agent both seams accept: they reach `agent.session` and use
  // the object itself as the scope carrier (spike 7).
  const agent = { id, session, ctx } as unknown as Agent
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    inner.agents.register(agent)
  }, { inject: ['agents'] }))

  const cwd = mkdtempSync(join(tmpdir(), 'cc-seams-'))
  const logger = new RecordingLogger()
  const config = resolveClaudeCodeConfig({
    ...(options.fallback === undefined ? {} : { ask: { fallback: options.fallback } }),
  })
  const router = new CcAskRouter({
    services: {
      approval: () => ctx.get('approval'),
      userQuestions: () => ctx.get('userQuestions'),
    },
    config,
    rules: CcAskRules.forSession(config, cwd, logger),
    logger,
  })
  router.attachTarget({ agent, delegated: options.delegated === true })

  cleanups.push(async () => {
    rmSync(cwd, { recursive: true, force: true })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
  return { ctx, agent, session, router, logger }
}

/**
 * Register a scripted user-questions provider.
 * @param ctx - the composition.
 * @param answer - how to answer.
 * @returns the requests it received, and its disposer.
 */
function provider(
  ctx: Context,
  answer: (request: AskUserQuestionRequest) => AskUserQuestionAnswer,
): { requests: AskUserQuestionRequest[], dispose: () => void } {
  const requests: AskUserQuestionRequest[] = []
  const dispose = ctx.userQuestions.registerProvider({
    ask: async (request) => {
      requests.push(request)
      return await Promise.resolve(answer(request))
    },
  })
  cleanups.push(dispose)
  return { requests, dispose }
}

describe('ask channel against the real ctx.approval (§4.1, delta D2)', () => {
  it('asks the answerer chain inside an open turn and appends the audit pair with our callId', async () => {
    const { ctx, session, router } = await mount()
    session.append('turn/start', { turn: 1 })
    const seen: { agent: unknown, callId: string | undefined, reason: string | undefined }[] = []
    const off = ctx.on('approval/request', (request) => {
      seen.push({ agent: request.agent, callId: request.callId, reason: request.reason })
      return Promise.resolve('allowed-once' as const)
    })
    cleanups.push(() => { off() })

    router.attachCallSite({
      hasEmittedCall: () => true,
      ensureToolCall: (toolUseId: string) => toolUseId,
    })
    const decision = await router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ toolUseID: 'toolu_42', title: 'Claude wants to run ls' }))

    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(seen[0]?.callId).toBe('toolu_42')
    expect(seen[0]?.reason).toBe('Claude wants to run ls')
    // The audit pair the seam appends — the reason dsh omits tool arguments.
    const types = session.events.map(event => event.type)
    expect(types).toContain('approval/asked')
    expect(types).toContain('approval/decided')
  })

  it('denies with an explanation when the session has no open turn, and appends nothing', async () => {
    const { session, router, logger } = await mount()
    const before = session.events.length

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision.behavior).toBe('deny')
    expect(decision).toMatchObject({
      message: expect.stringContaining('no turn open') as unknown as string,
    })
    // The guard rejects BEFORE appending: no half-written audit pair.
    expect(session.events.length).toBe(before)
    expect(logger.saw('could not be requested')).toBe(true)
  })

  it('treats the deterministic policy "never" as an ordinary rejection, not a fallback', async () => {
    const { session, router } = await mount({ policy: 'never', fallback: 'first-option' })
    session.append('turn/start', { turn: 1 })
    setApprovalPolicy(session, 'never')

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision).toEqual({ behavior: 'deny', message: 'User rejected this action' })
  })

  it('falls back when no answerer claims the request (unavailable)', async () => {
    const { session, router } = await mount()
    session.append('turn/start', { turn: 1 })

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('no approver is available') as unknown as string,
    })
  })
})

describe('ask channel against the real ctx.userQuestions (§4.2, delta D3/D4)', () => {
  it('round-trips a real question through a registered provider', async () => {
    const { ctx, router } = await mount()
    const scripted = provider(ctx, request => ({
      answers: request.questions.map(question => ({
        id: question.id,
        selected: [question.options?.[1]?.label ?? ''],
      })),
    }))

    const decision = await router.canUseTool('AskUserQuestion', {
      questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
    }, makeRequest())

    expect(scripted.requests[0]?.agent).toBeDefined()
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which database?': 'SQLite' } },
    })
  })

  it('falls back on NO_PROVIDER (fail-closed with no UI mounted)', async () => {
    const { router } = await mount()

    const decision = await router.canUseTool('AskUserQuestion', {
      questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('NO_PROVIDER') as unknown as string,
    })
  })

  it('falls back on CALLER_NOT_LIVE when the target agent is not the registry\'s live instance', async () => {
    const { ctx, session, router } = await mount()
    provider(ctx, () => ({ answers: [] }))
    // A look-alike agent: same session, not the object the registry holds.
    router.attachTarget({
      agent: { id: SessionId('ghost'), session, ctx } as unknown as Agent,
      delegated: false,
    })

    const decision = await router.canUseTool('AskUserQuestion', {
      questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }],
    }, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('CALLER_NOT_LIVE') as unknown as string,
    })
  })

  it('propagates the real BAD_INTENT when a plan review carries no plan to review (§4.3)', async () => {
    const { ctx, router } = await mount()
    provider(ctx, () => ({ answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] }))

    // Neither `plan` nor a readable `planFilePath`: the intent has no detail, and
    // `ask()` — not this seam — is what refuses it.
    const decision = await router.canUseTool('ExitPlanMode', {}, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('BAD_INTENT') as unknown as string,
    })
  })

  it('approves a real plan review end to end', async () => {
    const { ctx, router } = await mount()
    const scripted = provider(ctx, () => ({
      answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }],
    }))
    const input = { plan: '# Plan\n\nShip it.' }

    const decision = await router.canUseTool('ExitPlanMode', input, makeRequest())

    expect(scripted.requests[0]?.questions[0]?.intent).toEqual({ kind: 'plan-review', approve: 'Approve' })
    expect(decision).toEqual({ behavior: 'allow', updatedInput: input })
  })
})
