import {
  ASK_WITHDRAWN_MESSAGE, CC_ASK_USER_QUESTION, CC_EXIT_PLAN_MODE, CcAskTable,
} from '@deepseek-ai/dsh-claude-code'
import type { CcPermissionDecision } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeCallSite, makeRequest, makeRouter, settle } from './ask-helpers.ts'
import type { AskHarness, AskHarnessOptions } from './ask-helpers.ts'

/**
 * The ORDERINGS probe (Phase 4's answer to Phase 3's mirror-orderings suite).
 *
 * Every test here drives the router or the table through an interleaving the
 * happy-path specs cannot reach: a redelivery landing mid-flight, an abort
 * arriving after the answer, an answer arriving after the session closed, two
 * asks in flight at once, and a plan review opened while a permission is still
 * pending.
 *
 * The invariant under test is always the same one, because it is the only
 * invariant Claude Code cannot survive losing: **`canUseTool` resolves exactly
 * once, for every ordering.** A rejection or a never-settling promise hangs the
 * CLI forever — there is no park deadline.
 */

/** Harnesses to clean up after each test. */
const open: AskHarness[] = []

afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup()
})

/**
 * Build a router harness that is torn down automatically.
 * @param options - harness options.
 * @returns the harness.
 */
function harness(options: AskHarnessOptions = {}): AskHarness {
  const made = makeRouter(options)
  open.push(made)
  return made
}

/** A promise that never settles — a seam waiting on a human who never answers. */
function never(): Promise<void> {
  return new Promise<void>(() => {})
}

describe('ask orderings: redelivery mid-flight (delta S12)', () => {
  it('joins the in-flight ask and honours the REDELIVERED request\'s own signal', async () => {
    const made = harness()
    made.approval.gate = never()
    const first = new AbortController()
    const second = new AbortController()

    const original = made.router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ signal: first.signal }))
    await settle()
    const redelivered = made.router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ signal: second.signal }))
    await settle()

    // One prompt, two deliveries.
    expect(made.approval.requests).toHaveLength(1)
    expect(made.router.pendingAsks).toBe(1)

    // The redelivery's transport is the live one: aborting it withdraws the ask.
    second.abort()

    expect(await original).toEqual({ behavior: 'deny', message: ASK_WITHDRAWN_MESSAGE })
    expect(await redelivered).toEqual({ behavior: 'deny', message: ASK_WITHDRAWN_MESSAGE })
    expect(made.router.pendingAsks).toBe(0)
  })

  it('answers a redelivery that arrives after the answer from the settled table', async () => {
    const made = harness()

    const first = await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
    const second = await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(first).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(second).toEqual(first)
    expect(made.approval.requests).toHaveLength(1)
  })

  it('never conflates two distinct asks when the CLI supplies no requestId', async () => {
    const made = harness()
    made.approval.outcomes = ['allowed-once', 'rejected']

    const first = await made.router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ requestId: '', toolUseID: 'toolu_a' }))
    const second = await made.router.canUseTool(
      'Bash', { command: 'rm -rf /' }, makeRequest({ requestId: '', toolUseID: 'toolu_b' }))

    // Two tool calls, two prompts. Folding them onto one empty key would grant
    // the second call the first call's answer.
    expect(made.approval.requests).toHaveLength(2)
    expect(first.behavior).toBe('allow')
    expect(second).toEqual({ behavior: 'deny', message: 'User rejected this action' })
    expect(made.logger.saw('carried no requestId')).toBe(true)
  })
})

describe('ask orderings: abort, answer and close racing each other', () => {
  it('keeps the answer when the SDK aborts immediately after it landed', async () => {
    const made = harness()
    const controller = new AbortController()

    const decision = await made.router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ signal: controller.signal }))
    controller.abort()
    await settle()

    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(made.router.pendingAsks).toBe(0)
  })

  it('discards an answer that arrives after the session closed the table', async () => {
    const made = harness()
    let release = (): void => {}
    made.approval.gate = new Promise<void>(resolve => { release = resolve })

    const pending = made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
    await settle()
    expect(made.router.pendingAsks).toBe(1)

    made.router.settleAll()
    const decision = await pending
    expect(decision).toMatchObject({ behavior: 'deny' })

    // The human's late "yes" must not reopen a decided request.
    release()
    await settle()
    expect(await pending).toBe(decision)
    expect(made.router.pendingAsks).toBe(0)
  })

  it('never synthesizes a tool/call for an ask the SDK already withdrew (§4.4)', async () => {
    const site = new FakeCallSite()
    const made = harness({ deps: { callIdWaitMs: 200, callIdPollMs: 5 } })
    made.router.attachCallSite(site)
    const controller = new AbortController()

    const pending = made.router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ signal: controller.signal, toolUseID: 'toolu_gone' }))
    await settle()
    controller.abort()

    expect(await pending).toEqual({ behavior: 'deny', message: ASK_WITHDRAWN_MESSAGE })
    // Past the whole 200ms correlation window: the router's own wait, not the
    // test's timing, is what must decide there is nothing left to correlate.
    await new Promise<void>(resolve => { setTimeout(resolve, 260) })
    // A phantom tool/call would put a call Claude Code abandoned into the dsh
    // transcript, and an approval/asked pair with it.
    expect(site.synthesized).toEqual([])
    expect(made.approval.requests).toEqual([])
  })

  it('stops correlating when the mirror detaches during the callId wait', async () => {
    const site = new FakeCallSite()
    const made = harness({ deps: { callIdWaitMs: 120, callIdPollMs: 5 } })
    const detach = made.router.attachCallSite(site)

    const pending = made.router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ toolUseID: 'toolu_detached' }))
    await settle()
    detach()

    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(site.synthesized).toEqual([])
    // No mirror, no callId: dsh's answerer back-scan then matches only
    // callId-less asks, which is exactly right — there is no UI record.
    expect(made.approval.requests[0]?.callId).toBeUndefined()
  })
})

describe('ask orderings: concurrency', () => {
  it('runs two asks for the same tool independently, each with its own callId', async () => {
    const site = new FakeCallSite()
    const made = harness({ deps: { callIdWaitMs: 5, callIdPollMs: 1 } })
    made.router.attachCallSite(site)
    site.emitted.add('toolu_1')
    site.emitted.add('toolu_2')
    made.approval.outcomes = ['allowed-once', 'rejected']

    const [first, second] = await Promise.all([
      made.router.canUseTool('Bash', { command: 'ls' },
        makeRequest({ requestId: 'req_a', toolUseID: 'toolu_1' })),
      made.router.canUseTool('Bash', { command: 'pwd' },
        makeRequest({ requestId: 'req_b', toolUseID: 'toolu_2' })),
    ])

    expect(made.approval.requests.map(request => request.callId)).toEqual(['toolu_1', 'toolu_2'])
    expect(first.behavior).toBe('allow')
    expect(second.behavior).toBe('deny')
  })

  it('opens a plan review while a permission is still pending, and drains both on close', async () => {
    const made = harness()
    made.approval.gate = never()
    made.questions.answer = { answers: [{ id: 'plan-review', selected: ['Approve'] }] }

    const permission = made.router.canUseTool(
      'Bash', { command: 'ls' }, makeRequest({ requestId: 'req_perm' }))
    await settle()
    const plan = await made.router.canUseTool(
      CC_EXIT_PLAN_MODE, { plan: '# Plan' }, makeRequest({ requestId: 'req_plan' }))

    // The plan review is decided while the permission is still in flight.
    expect(plan).toMatchObject({ behavior: 'allow' })
    expect(made.router.pendingAsks).toBe(1)

    expect(made.router.settleAll()).toBe(1)
    expect(await permission).toMatchObject({ behavior: 'deny' })
    expect(made.router.pendingAsks).toBe(0)
  })

  it('reports every in-flight ask in the pending table, in arrival order', async () => {
    const made = harness()
    made.approval.gate = never()
    made.questions.gate = never()

    void made.router.canUseTool('Bash', { command: 'ls' }, makeRequest({ requestId: 'req_1' }))
    void made.router.canUseTool(CC_ASK_USER_QUESTION, {
      questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }, makeRequest({ requestId: 'req_2' }))
    await settle()

    expect(made.router.table.pending().map(entry => entry.toolName))
      .toEqual(['Bash', CC_ASK_USER_QUESTION])
    expect(made.router.pendingAsks).toBe(2)
    made.router.settleAll()
  })
})

describe('CcAskTable: timer edges', () => {
  it('contains a throwing onTimeout as a deny instead of an uncaught timer exception', async () => {
    const table = new CcAskTable()
    const decision = await table.run({
      requestId: 'req_boom',
      toolName: 'Bash',
      timeoutMs: 1,
      onTimeout: () => { throw new Error('policy exploded') },
    }, async () => await new Promise<CcPermissionDecision>(() => {}))

    expect(decision).toMatchObject({ behavior: 'deny' })
    expect(decision).toMatchObject({
      message: expect.stringContaining('policy exploded') as unknown as string,
    })
    expect(table.pendingCount).toBe(0)
  })

  it('settles ONCE when the timeout, the abort and the close all land together', async () => {
    const settles: string[] = []
    const table = new CcAskTable({ onSettle: (_id, cause) => settles.push(cause) })
    const controller = new AbortController()
    let seamSignal: AbortSignal | undefined

    const pending = table.run({
      requestId: 'req_pileup',
      toolName: 'Bash',
      signal: controller.signal,
      timeoutMs: 1,
      onTimeout: () => ({ behavior: 'deny', message: 'timed out' }),
    }, async (signal) => {
      seamSignal = signal
      return await new Promise<CcPermissionDecision>(() => {})
    })

    await new Promise<void>(resolve => { setTimeout(resolve, 20) })
    controller.abort()
    expect(table.settleAll()).toBe(0)

    // Whoever won, exactly one settle happened, the dsh seam was told the
    // question went away, and nothing is left in the table.
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(settles).toEqual(['timeout'])
    expect(seamSignal?.aborted).toBe(true)
    expect(table.pendingCount).toBe(0)
  })

  it('does not fire immediately when the configured wait exceeds the 32-bit timer ceiling', async () => {
    vi.useFakeTimers()
    try {
      const table = new CcAskTable()
      let timedOut = false
      const pending = table.run({
        requestId: 'req_huge',
        toolName: 'Bash',
        // Node clamps anything past 2^31-1 to 1ms and warns; an unclamped
        // delegatedTimeoutMs of a month would deny every prompt instantly.
        timeoutMs: 2 ** 31 + 1000,
        onTimeout: () => {
          timedOut = true
          return { behavior: 'deny', message: 'timeout' }
        },
      }, async () => await new Promise<CcPermissionDecision>(() => {}))
      void pending

      await vi.advanceTimersByTimeAsync(5000)
      expect(timedOut).toBe(false)
      expect(table.pendingCount).toBe(1)
      table.settleAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pends with NO timer at all when no timeout is configured (§4.6)', async () => {
    vi.useFakeTimers()
    try {
      const table = new CcAskTable()
      void table.run({
        requestId: 'req_none',
        toolName: 'Bash',
        onTimeout: () => ({ behavior: 'deny', message: 'never reached' }),
      }, async () => await new Promise<CcPermissionDecision>(() => {}))

      // A 0ms timer would have fired by now; an absent one never does.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(vi.getTimerCount()).toBe(0)
      expect(table.pendingCount).toBe(1)
      table.settleAll()
    } finally {
      vi.useRealTimers()
    }
  })
})
