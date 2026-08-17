import {
  CC_ASK_USER_QUESTION, CC_CANCELLED_MESSAGE, CC_EXIT_PLAN_MODE, CC_PLAN_REVIEW_ID,
  CC_REJECTED_MESSAGE, describeCall,
} from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeCallSite, makeRouter, makeRequest } from './ask-helpers.ts'
import type { AskHarness } from './ask-helpers.ts'

/**
 * §4.1 and §4.4: the router's dispatch, the approval outcome table, the
 * `callId` correlation, and the two guards that keep a rejected promise (which
 * hangs Claude Code forever) from ever leaving this seam.
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

describe('ask router: dispatch (§4)', () => {
  it('routes AskUserQuestion to the user-questions seam', async () => {
    const { router, questions, approval } = harness()
    questions.answer = { answers: [{ id: 'Ship it?', selected: ['Yes'] }] }

    const decision = await router.canUseTool(
      CC_ASK_USER_QUESTION,
      { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      makeRequest())

    expect(questions.requests).toHaveLength(1)
    expect(approval.requests).toHaveLength(0)
    expect(decision.behavior).toBe('allow')
  })

  it('routes ExitPlanMode to the user-questions seam with the plan-review intent', async () => {
    const { router, questions, approval } = harness()
    questions.answer = { answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] }

    await router.canUseTool(CC_EXIT_PLAN_MODE, { plan: '# Plan\n\nDo the thing.' }, makeRequest())

    expect(approval.requests).toHaveLength(0)
    const asked = questions.requests[0]?.questions[0]
    expect(asked?.id).toBe(CC_PLAN_REVIEW_ID)
    expect(asked?.intent).toEqual({ kind: 'plan-review', approve: 'Approve' })
  })

  it('routes every other tool to the approval seam', async () => {
    const { router, questions, approval } = harness()

    await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(questions.requests).toHaveLength(0)
    expect(approval.requests).toHaveLength(1)
    expect(approval.requests[0]?.toolName).toBe('Bash')
  })
})

describe('ask router: the ApprovalOutcome → PermissionResult table (§4.1)', () => {
  it('maps allowed-once to an allow that ALWAYS carries updatedInput', async () => {
    const { router, approval } = harness()
    approval.outcomes = ['allowed-once']
    const input = { command: 'ls -la' }

    const decision = await router.canUseTool('Bash', input, makeRequest())

    expect(decision).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('maps rejected to a deny with the documented message', async () => {
    const { router, approval } = harness()
    approval.outcomes = ['rejected']

    expect(await router.canUseTool('Bash', { command: 'ls' }, makeRequest()))
      .toEqual({ behavior: 'deny', message: CC_REJECTED_MESSAGE })
  })

  it('maps cancelled to a deny with the documented message', async () => {
    const { router, approval } = harness()
    approval.outcomes = ['cancelled']

    expect(await router.canUseTool('Bash', { command: 'ls' }, makeRequest()))
      .toEqual({ behavior: 'deny', message: CC_CANCELLED_MESSAGE })
  })

  it('routes unavailable through the fallback policy, not through the table', async () => {
    const { router, approval } = harness({ config: { ask: { fallback: 'first-option' } } })
    approval.outcomes = ['unavailable']

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    // `first-option` must never turn a missing approver into a grant.
    expect(decision.behavior).toBe('deny')
    expect(decision).toMatchObject({
      message: expect.stringContaining('no approver is available') as unknown as string,
    })
  })

  it('passes the CLI title through as the reason and falls back to describeCall', async () => {
    const { router, approval } = harness()

    await router.canUseTool('Bash', { command: 'ls' }, makeRequest({ title: 'Claude wants to run ls' }))
    await router.canUseTool('Bash', { command: 'ls' }, makeRequest({ requestId: 'req_2' }))

    expect(approval.requests[0]?.reason).toBe('Claude wants to run ls')
    expect(approval.requests[1]?.reason).toBe('Bash: ls')
  })

  it('resolves the seams through the composition when the target overrides neither', async () => {
    const { router, approval } = harness({ viaServices: true })

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(approval.requests).toHaveLength(1)
    expect(decision.behavior).toBe('allow')
  })
})

describe('ask router: fail-closed guards', () => {
  it('denies (and never throws) when the approval seam throws — the open-turn guard', async () => {
    const { router, approval } = harness()
    approval.throws = new Error('approval.request() outside an open turn')

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision.behavior).toBe('deny')
    expect(decision).toMatchObject({
      message: expect.stringContaining('no turn open') as unknown as string,
    })
  })

  it('denies fail-closed when no approval service is mounted, whatever the fallback policy says', async () => {
    const { router } = harness({ noApproval: true, config: { ask: { fallback: 'first-option' } } })

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision.behavior).toBe('deny')
    expect(decision).toMatchObject({
      message: expect.stringContaining('no approval service is mounted') as unknown as string,
    })
  })

  it('denies fail-closed when no ask target is attached at all', async () => {
    const { router } = harness({ noTarget: true })

    const decision = await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('no dsh ask target') as unknown as string,
    })
  })
})

describe('ask router: callId correlation (§4.4)', () => {
  it('sends no callId when the session has no mirror', async () => {
    const { router, approval } = harness()

    await router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(approval.requests[0]).not.toHaveProperty('callId')
  })

  it('uses the mirrored call id when the tool/call is already in the log', async () => {
    const { router, approval } = harness()
    const site = new FakeCallSite()
    site.emitted.add('toolu_7')
    router.attachCallSite(site)

    await router.canUseTool('Bash', { command: 'ls' }, makeRequest({ toolUseID: 'toolu_7' }))

    expect(approval.requests[0]?.callId).toBe('toolu_7')
    expect(site.synthesized).toHaveLength(0)
  })

  it('waits for the mirror, then adopts the call it emits mid-wait', async () => {
    const { router, approval } = harness()
    const site = new FakeCallSite()
    router.attachCallSite(site)
    setTimeout(() => site.emitted.add('toolu_9'), 5)

    await router.canUseTool('Bash', { command: 'ls' }, makeRequest({ toolUseID: 'toolu_9' }))

    expect(approval.requests[0]?.callId).toBe('toolu_9')
    expect(site.synthesized).toHaveLength(0)
  })

  it('synthesizes the tool/call, loudly, when the mirror never emits one', async () => {
    const { router, approval, logger } = harness()
    const site = new FakeCallSite()
    router.attachCallSite(site)

    await router.canUseTool('Bash', { command: 'ls' }, makeRequest({ toolUseID: 'toolu_x' }))

    expect(site.synthesized).toEqual([
      { toolUseId: 'toolu_x', toolName: 'Bash', input: { command: 'ls' } },
    ])
    expect(approval.requests[0]?.callId).toBe('toolu_x')
    expect(logger.saw('synthesizing one')).toBe(true)
  })
})

describe('describeCall', () => {
  it('prefers the most informative field and stays on one bounded line', () => {
    expect(describeCall('Bash', { command: 'echo\n  hi' })).toBe('Bash: echo hi')
    expect(describeCall('Read', { file_path: '/tmp/a.txt' })).toBe('Read: /tmp/a.txt')
    expect(describeCall('Unknown', {})).toBe('Unknown')
    expect(describeCall('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(240)
  })
})
