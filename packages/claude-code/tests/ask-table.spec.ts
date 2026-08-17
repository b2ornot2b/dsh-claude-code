import {
  ASK_SESSION_CLOSED_MESSAGE, ASK_WITHDRAWN_MESSAGE, CcAskTable,
} from '@deepseek-ai/dsh-claude-code'
import type { CcAskSettleCause, CcPermissionDecision } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { makeRequest, makeRouter, RecordingLogger, settle } from './ask-helpers.ts'
import type { AskHarness } from './ask-helpers.ts'

/**
 * §4.6: pending, timeouts and idempotency. The table is where "the callback may
 * pend indefinitely" stops being fatal.
 */

/** Harnesses built by a test, cleaned up afterwards. */
const built: AskHarness[] = []

afterEach(() => {
  while (built.length > 0) built.pop()?.cleanup()
})

/**
 * Build a harness and register it for cleanup.
 * @param options - harness options.
 * @returns the harness.
 */
function harness(options: Parameters<typeof makeRouter>[0] = {}): AskHarness {
  const made = makeRouter(options)
  built.push(made)
  return made
}

/** An allow decision, for scripting. */
const ALLOW: CcPermissionDecision = { behavior: 'allow', updatedInput: {} }

describe('CcAskTable: idempotency (delta S12)', () => {
  it('answers a redelivered requestId from the settled table, without asking twice', async () => {
    const table = new CcAskTable()
    let asked = 0
    const work = async (): Promise<CcPermissionDecision> => {
      asked += 1
      return await Promise.resolve(ALLOW)
    }

    const first = await table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW }, work)
    const second = await table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW }, work)

    expect(asked).toBe(1)
    expect(second).toBe(first)
  })

  it('attaches a redelivery to the ask still in flight', async () => {
    const table = new CcAskTable()
    let asked = 0
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const work = async (): Promise<CcPermissionDecision> => {
      asked += 1
      await gate
      return ALLOW
    }

    const first = table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW }, work)
    const second = table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW }, work)
    await settle()
    expect(table.pendingCount).toBe(1)

    release()
    expect(await first).toBe(await second)
    expect(asked).toBe(1)
  })

  it('does not open a second dsh prompt when the SDK redelivers one permission request', async () => {
    const { router, approval } = harness()

    const decisions = await Promise.all([
      router.canUseTool('Bash', { command: 'ls' }, makeRequest({ requestId: 'same' })),
      router.canUseTool('Bash', { command: 'ls' }, makeRequest({ requestId: 'same' })),
    ])

    expect(approval.requests).toHaveLength(1)
    expect(decisions[0]).toEqual(decisions[1])
  })

  it('evicts the oldest settled decisions past the retention bound', async () => {
    const table = new CcAskTable({ retain: 2 })
    const work = async (): Promise<CcPermissionDecision> => await Promise.resolve(ALLOW)
    let asked = 0
    const counted = async (): Promise<CcPermissionDecision> => {
      asked += 1
      return await work()
    }

    for (const id of ['a', 'b', 'c']) {
      await table.run({ requestId: id, toolName: 'Bash', onTimeout: () => ALLOW }, counted)
    }
    // 'a' fell out of the retention window, so its redelivery asks again.
    await table.run({ requestId: 'a', toolName: 'Bash', onTimeout: () => ALLOW }, counted)

    expect(asked).toBe(4)
  })
})

describe('CcAskTable: settlement', () => {
  it('settles an aborted request as withdrawn and discards the late answer', async () => {
    const causes: CcAskSettleCause[] = []
    const table = new CcAskTable({ onSettle: (_id, cause) => causes.push(cause) })
    const controller = new AbortController()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let sawAbort = false

    const decision = table.run(
      { requestId: 'r1', toolName: 'Bash', signal: controller.signal, onTimeout: () => ALLOW },
      async (signal) => {
        await gate
        sawAbort = signal.aborted
        return ALLOW
      })

    await settle()
    controller.abort()

    expect(await decision).toEqual({ behavior: 'deny', message: ASK_WITHDRAWN_MESSAGE })
    expect(table.pendingCount).toBe(0)

    // The late answer lands on a settled entry and changes nothing.
    release()
    await settle()
    expect(sawAbort).toBe(true)
    expect(causes).toEqual(['abort'])
  })

  it('never asks at all when the signal aborted before the request arrived', async () => {
    const table = new CcAskTable()
    const controller = new AbortController()
    controller.abort()
    let asked = 0

    const decision = await table.run(
      { requestId: 'r1', toolName: 'Bash', signal: controller.signal, onTimeout: () => ALLOW },
      async () => {
        asked += 1
        return await Promise.resolve(ALLOW)
      })

    expect(asked).toBe(0)
    expect(decision).toEqual({ behavior: 'deny', message: ASK_WITHDRAWN_MESSAGE })
  })

  it('settles on the deadline with the caller-supplied timeout decision', async () => {
    const table = new CcAskTable()
    const timeoutDecision: CcPermissionDecision = { behavior: 'deny', message: 'timed out' }

    const decision = await table.run(
      { requestId: 'r1', toolName: 'Bash', timeoutMs: 5, onTimeout: () => timeoutDecision },
      async () => await new Promise<CcPermissionDecision>(() => {}))

    expect(decision).toEqual(timeoutDecision)
    expect(table.pendingCount).toBe(0)
  })

  it('denies every open ask on settleAll, and reports how many', async () => {
    const table = new CcAskTable()
    const parked = async (): Promise<CcPermissionDecision> =>
      await new Promise<CcPermissionDecision>(() => {})
    const first = table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW }, parked)
    const second = table.run({ requestId: 'r2', toolName: 'Read', onTimeout: () => ALLOW }, parked)
    await settle()

    expect(table.pending().map(entry => entry.toolName)).toEqual(['Bash', 'Read'])
    expect(table.settleAll()).toBe(2)

    expect(await first).toEqual({ behavior: 'deny', message: ASK_SESSION_CLOSED_MESSAGE })
    expect(await second).toEqual({ behavior: 'deny', message: ASK_SESSION_CLOSED_MESSAGE })
    expect(table.pendingCount).toBe(0)
  })

  it('contains a throwing ask as a deny instead of rejecting the callback', async () => {
    const logger = new RecordingLogger()
    const table = new CcAskTable({ logger })

    const decision = await table.run(
      { requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW },
      async () => await Promise.reject(new Error('boom')))

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('boom') as unknown as string,
    })
    expect(logger.saw('failed unexpectedly')).toBe(true)
  })
})

describe('ask router: timeouts (§4.6)', () => {
  it('uses ask.timeoutMs for an interactive target and applies the fallback', async () => {
    const { router, questions } = harness({ config: { ask: { timeoutMs: 5 } } })
    questions.gate = new Promise<void>(() => {})

    const decision = await router.canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] },
      makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('nobody answered within 5ms') as unknown as string,
    })
  })

  it('uses ask.delegatedTimeoutMs when the target is delegated', async () => {
    const { router, approval } = harness({
      delegated: true,
      config: { ask: { timeoutMs: 60_000, delegatedTimeoutMs: 5 } },
    })
    approval.gate = new Promise<void>(() => {})

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('nobody answered within 5ms') as unknown as string,
    })
  })

  it('auto-answers a timed-out QUESTION under first-option, but never a timed-out permission', async () => {
    const questionHarness = harness({
      config: { ask: { timeoutMs: 5, fallback: 'first-option' } },
    })
    questionHarness.questions.gate = new Promise<void>(() => {})
    const answered = await questionHarness.router.canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      makeRequest())

    expect(answered).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        answers: { 'Ship it?': 'Yes' },
      },
    })

    const permissionHarness = harness({
      config: { ask: { timeoutMs: 5, fallback: 'first-option' } },
    })
    permissionHarness.approval.gate = new Promise<void>(() => {})
    const denied = await permissionHarness.router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(denied.behavior).toBe('deny')
  })

  it('pends indefinitely when no timeout is configured, and reports the pending ask', async () => {
    const { router, approval } = harness()
    approval.gate = new Promise<void>(() => {})

    const pending = router.canUseTool('Bash', { command: 'ls' }, makeRequest())
    await settle()

    expect(router.pendingAsks).toBe(1)
    expect(router.table.pending()[0]?.toolName).toBe('Bash')

    router.settleAll()
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(router.pendingAsks).toBe(0)
  })
})
