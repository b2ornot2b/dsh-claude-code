/**
 * `CcPendingAsk` detail: the seam half of the human-in-the-loop fix.
 *
 * The failure this covers is not a crash — it is an absence. A real session sat
 * for thirty minutes behind an unanswered `Write` approval while the only signal
 * any consumer could read was a COUNT ("1 pending ask(s)"), even though the ask
 * table already held the tool name and the exact sentence the human was looking
 * at. These specs assert that the table now carries the kind, the tool, the
 * reason and the start time, that the reason is IDENTICAL to what the router
 * sends `ctx.approval.request`, and that snapshots project all of it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CC_PENDING_ASK_KINDS, CcAskRouter, CcAskRules, CcAskTable, describeCall,
  resolveClaudeCodeConfig,
} from '@deepseek-ai/dsh-claude-code'
import type { CcAskTarget, CcPermissionDecision } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeApproval, FakeQuestions, fakeAgent, makeRequest, RecordingLogger, settle } from './ask-helpers.ts'

/** Teardown callbacks registered by the current test. */
const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  vi.restoreAllMocks()
})

/** An ask that never answers — the human is still looking at the prompt. */
async function parked(): Promise<CcPermissionDecision> {
  return await new Promise<CcPermissionDecision>(() => {})
}

/** The deny a timeout policy would produce; unused while an ask stays pending. */
function denied(): CcPermissionDecision {
  return { behavior: 'deny', message: 'no' }
}

/**
 * A temp directory usable as a session `cwd` (the rule cache lives under it).
 * @returns its absolute path.
 */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cc-ask-details-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/**
 * A router whose seams never answer, so every ask stays pending and observable.
 * @returns the router and the two parked seams.
 */
function parkedRouter(): { router: CcAskRouter, approval: FakeApproval, questions: FakeQuestions } {
  const config = resolveClaudeCodeConfig()
  const logger = new RecordingLogger()
  const approval = new FakeApproval()
  const questions = new FakeQuestions()
  // Never resolves: exactly the production case — the prompt is up in the dsh
  // UI and the human has not clicked anything yet.
  approval.gate = new Promise<void>(() => {})
  questions.gate = new Promise<void>(() => {})
  const router = new CcAskRouter({
    services: { approval: () => undefined, userQuestions: () => undefined },
    config,
    rules: CcAskRules.forSession(config, scratch(), logger),
    logger,
  })
  const target: CcAskTarget = { agent: fakeAgent(), delegated: false, approval, userQuestions: questions }
  router.attachTarget(target)
  return { router, approval, questions }
}

describe('CcPendingAsk detail', () => {
  it('reports kind, tool, the CLI\'s own title as the reason, and when it started', async () => {
    const { router } = parkedRouter()
    const before = Date.now()

    void router.canUseTool(
      'Write',
      { file_path: '/private/tmp/scratch/notes.txt', content: 'alpha' },
      makeRequest({ title: 'Write: /private/tmp/scratch/notes.txt' }))
    await settle()

    const [pending] = router.pendingAskDetails
    expect(router.pendingAsks).toBe(1)
    expect(pending).toMatchObject({
      kind: 'permission',
      toolName: 'Write',
      // The CLI's pre-rendered sentence, verbatim — the words the human reads.
      reason: 'Write: /private/tmp/scratch/notes.txt',
      requestId: 'req_1',
    })
    expect(pending?.since).toBeGreaterThanOrEqual(before)
    expect(pending?.since).toBeLessThanOrEqual(Date.now())
    // `startedAt` is the pre-existing name for the same instant, kept for
    // consumers written before `since` existed. They must never disagree.
    expect(pending?.startedAt).toBe(pending?.since)

    router.settleAll()
  })

  it('sends ctx.approval.request the SAME reason string it puts on the pending ask', async () => {
    const { router, approval } = parkedRouter()
    // No `title`: the CLI is older than delta S2, so the router falls back to
    // `describeCall`. Both consumers must still see one sentence, not two.
    // The gate is held only long enough to read the table while the ask is
    // genuinely pending — releasing it lets the approval land and be compared.
    let release: () => void = () => {}
    approval.gate = new Promise<void>(resolve => { release = resolve })

    const decided = router.canUseTool('Bash', { command: 'rm -rf /tmp/x' }, makeRequest())
    await settle()
    const pendingReason = router.pendingAskDetails[0]?.reason
    release()
    await decided

    expect(pendingReason).toBe(describeCall('Bash', { command: 'rm -rf /tmp/x' }))
    expect(approval.requests[0]?.reason).toBe(pendingReason)
  })

  it('names a clarifying question and a plan review by their own kind', async () => {
    const { router } = parkedRouter()

    void router.canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Which database should I target?', options: [{ label: 'postgres' }] }] },
      makeRequest({ requestId: 'q1' }))
    void router.canUseTool('ExitPlanMode', { plan: '# Plan\n\n1. do it' }, makeRequest({ requestId: 'p1' }))
    await settle()

    expect(router.pendingAskDetails.map(ask => [ask.kind, ask.toolName, ask.reason])).toEqual([
      ['question', 'AskUserQuestion', 'Which database should I target?'],
      ['plan', 'ExitPlanMode', 'Approve this plan?'],
    ])

    router.settleAll()
  })

  it('empties as asks settle, and every reported kind is a declared one', async () => {
    const { router } = parkedRouter()
    void router.canUseTool('Read', { file_path: '/etc/hosts' }, makeRequest())
    await settle()

    for (const ask of router.pendingAskDetails) expect(CC_PENDING_ASK_KINDS).toContain(ask.kind)
    expect(router.settleAll()).toBe(1)
    expect(router.pendingAskDetails).toEqual([])
  })

  it('defaults an ask registered without a kind to permission, the one that never auto-answers', async () => {
    const table = new CcAskTable()
    void table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: denied }, parked)
    await settle()

    expect(table.pending()[0]?.kind).toBe('permission')
    expect(table.pending()[0]?.reason).toBeUndefined()
    table.settleAll()
  })
})

describe('CcPendingAsk under the races that actually happen', () => {
  it('keeps the ORIGINAL since when the SDK redelivers an in-flight request', async () => {
    // Delta S12: after `reinitialize()` the CLI redelivers every in-flight
    // `can_use_tool`. If the table restamped on redelivery, an ask a human had
    // been ignoring for ten minutes would report "pending 0s" — and the ONE
    // number that tells an operator "nobody is at their desk" would reset every
    // time the subprocess reinitialized. The clock is stubbed rather than
    // faked because `settle()` needs a real `setTimeout`.
    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(1_000_000)
    const table = new CcAskTable()
    const worked: string[] = []

    void table.run(
      { requestId: 'req_1', toolName: 'Write', kind: 'permission', reason: 'Write: /tmp/notes.txt', onTimeout: denied },
      async () => {
        worked.push('first')
        return await parked()
      })
    await settle()

    // Ten minutes later the same request arrives again, on the fresh transport.
    clock.mockReturnValue(1_600_000)
    const redelivered = new AbortController()
    void table.run(
      {
        requestId: 'req_1',
        toolName: 'Write',
        kind: 'permission',
        reason: 'Write: /tmp/notes.txt',
        signal: redelivered.signal,
        onTimeout: denied,
      },
      async () => {
        worked.push('second')
        return await parked()
      })
    await settle()

    // One entry, one prompt, and the original instant.
    expect(table.pendingCount).toBe(1)
    expect(worked).toEqual(['first'])
    expect(table.pending()[0]?.since).toBe(1_000_000)
    expect(table.pending()[0]?.startedAt).toBe(1_000_000)

    // …and the redelivered signal is live: withdrawing it settles the ask,
    // which then leaves the pending list rather than lingering as a ghost.
    redelivered.abort()
    await settle()
    expect(table.pendingCount).toBe(0)
    expect(table.pending()).toEqual([])
  })

  it('never lets the count and the detail list disagree, at any point in an ask\'s life', async () => {
    // A count of 1 with an empty detail list is the exact signal the production
    // trace was stuck with ("1 pending ask(s)", nothing more). Both numbers come
    // off one map, and this pins that they still do.
    const table = new CcAskTable()
    const agree = (): void => { expect(table.pendingCount).toBe(table.pending().length) }
    agree()

    const withdrawn = new AbortController()
    void table.run({ requestId: 'req_1', toolName: 'Write', signal: withdrawn.signal, onTimeout: denied }, parked)
    void table.run({ requestId: 'req_2', toolName: 'Read', onTimeout: denied }, parked)
    await settle()
    agree()
    expect(table.pendingCount).toBe(2)

    withdrawn.abort()
    await settle()
    agree()
    // The SURVIVOR is the one still open — a settled ask does not merely stop
    // being counted, it stops being described.
    expect(table.pending().map(ask => ask.requestId)).toEqual(['req_2'])

    table.settleAll()
    agree()
    expect(table.pendingCount).toBe(0)
  })

  it('drops an answered ask from the very next read, and stays dropped on redelivery', async () => {
    const table = new CcAskTable()
    let answer: (decision: CcPermissionDecision) => void = () => {}
    void table.run(
      { requestId: 'req_1', toolName: 'Write', kind: 'permission', reason: 'Write: /tmp/notes.txt', onTimeout: denied },
      async () => await new Promise<CcPermissionDecision>(resolve => { answer = resolve }))
    await settle()
    expect(table.pending()).toHaveLength(1)

    // The human clicks approve.
    answer({ behavior: 'allow', updatedInput: { file_path: '/tmp/notes.txt' } })
    await settle()
    expect(table.pending()).toEqual([])
    expect(table.pendingCount).toBe(0)

    // A redelivery of an ALREADY-ANSWERED request replays the decision and must
    // not resurrect it as pending — otherwise a reinitialize would re-open a
    // prompt the human already dealt with.
    const replay = await table.run({ requestId: 'req_1', toolName: 'Write', onTimeout: denied }, parked)
    expect(replay).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/notes.txt' } })
    expect(table.pending()).toEqual([])
  })

  it('reports nothing pending once the session-close path has denied everything', async () => {
    // `CcSession.close()` runs `settleAll()` BEFORE it notifies its close
    // listeners, which is what keeps a tombstone from freezing a pending ask
    // that has in fact been denied. Reading the table after `settleAll()` is
    // the seam-level statement of that ordering.
    const { router } = parkedRouter()
    void router.canUseTool('Write', { file_path: '/tmp/notes.txt' }, makeRequest())
    await settle()
    expect(router.pendingAskDetails).toHaveLength(1)

    expect(router.settleAll()).toBe(1)
    expect(router.pendingAsks).toBe(0)
    expect(router.pendingAskDetails).toEqual([])
    // Idempotent: a second close settles nothing and still reports nothing.
    expect(router.settleAll()).toBe(0)
    expect(router.pendingAskDetails).toEqual([])
  })
})
