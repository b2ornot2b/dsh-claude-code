/**
 * What a MODEL learns about human decisions.
 *
 * The seam-side specs (`packages/claude-code/tests/ask-receipts.spec.ts`) prove
 * the receipts are recorded correctly. These prove the part that actually
 * changes an agent's report: the prose. A delegating agent graded a working
 * integration 7 PASS / 5 PARTIAL / 1 FAIL because nothing it read said a person
 * had approved, rejected or answered anything — so it inferred, and inferred
 * wrong in all three directions (a human rejection reported as a broken deny
 * path, a human plan approval reported as "plan mode never engaged", a human's
 * "hola" reported as the session auto-choosing).
 *
 * The strongest assertions here are the verbatim ones. Two properties in
 * particular are behavioural, not cosmetic:
 *
 * 1. a HUMAN decision says so, in words a model repeats accurately;
 * 2. a POLICY settle NEVER reads as a human's — a timeout deny that sounded
 *    like "the operator refused" would be a new way to produce the same wrong
 *    report from the opposite direction.
 *
 * Everything below the tool layer is real: the real service, the real ask
 * router, the real ask table, the Phase 2 fake backend in place of the SDK.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CWD, fakeAgent, firstQuery, mountTools, settle } from './harness.ts'
import type { ToolHarness } from './harness.ts'
import { renderSessionList } from '../src/list.ts'
import {
  projectHumanDecisions, renderDecisionBlock, renderLastDecision, renderWithDecisions,
} from '../src/receipts.ts'
import type { CcHumanDecisionProjection } from '../src/receipts.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The text block of a tool result. */
function text(result: { content: unknown[] }): string {
  return String((result.content[0] as { text?: unknown }).text ?? '')
}

/** One projected decision, with the fields a case is about. */
function decision(overrides: Partial<CcHumanDecisionProjection> = {}): CcHumanDecisionProjection {
  return {
    kind: 'permission',
    tool_name: 'Bash',
    reason: 'Bash: touch marker2.txt',
    outcome: 'rejected',
    decided_by: 'human',
    ...overrides,
  }
}

/** Let a millisecond pass, so two turns cannot share one clock reading. */
async function tick(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 5) })
}

describe('the decision prose', () => {
  it('states a human REJECTION as a human rejection, naming the tool and the command', () => {
    expect(renderDecisionBlock([decision()], 'this turn')).toBe(
      '1 human decision this turn:\n'
      + '  1. permission for Bash (touch marker2.txt) — REJECTED by a human in the dsh UI')
  })

  it('states a human ALLOW the same way', () => {
    expect(renderDecisionBlock([decision({ outcome: 'allowed', reason: 'Bash: touch marker.txt' })], 'this turn'))
      .toBe('1 human decision this turn:\n'
        + '  1. permission for Bash (touch marker.txt) — ALLOWED by a human in the dsh UI')
  })

  it('quotes what a human typed for a question, so the model repeats their words', () => {
    const rendered = renderDecisionBlock([decision({
      kind: 'question',
      tool_name: 'AskUserQuestion',
      reason: 'Which greeting?',
      outcome: 'answered',
      detail: 'g’day, and use British spelling',
    })], 'this turn')

    expect(rendered).toBe(
      '1 human decision this turn:\n'
      + '  1. question (Which greeting?) — answered by a human in the dsh UI: '
      + '\'g’day, and use British spelling\'')
  })

  it('states a plan approval and a plan decline as the human\'s own choice', () => {
    expect(renderDecisionBlock([decision({
      kind: 'plan',
      tool_name: 'ExitPlanMode',
      reason: 'Approve this plan?',
      outcome: 'allowed',
      detail: 'the human chose "Approve" in the plan review',
    })], 'this turn')).toContain('plan review (Approve this plan?) — ALLOWED by a human in the dsh UI');

    expect(renderDecisionBlock([decision({
      kind: 'plan',
      tool_name: 'ExitPlanMode',
      reason: 'Approve this plan?',
      outcome: 'rejected',
      detail: 'the human chose "Keep planning"; their feedback: add a rollback step',
    })], 'this turn')).toContain('add a rollback step')
  })

  it('NEVER lets a timeout deny read as a human decision', () => {
    const rendered = renderDecisionBlock([decision({
      outcome: 'timed-out',
      decided_by: 'policy',
      reason: 'Bash: rm -rf build',
      detail: 'denied by the "deny" fallback policy (nobody answered within 5000ms); no human answered',
    })], 'this turn')

    expect(rendered).toBe(
      '1 ask settled this turn WITHOUT any human decision:\n'
      + '  1. permission for Bash (rm -rf build) — NOT answered: the ask timed out and was settled by policy '
      + '— denied by the "deny" fallback policy (nobody answered within 5000ms); no human answered '
      + '— NOT a human decision')
    // The negative property, stated as a property: nothing in this string may
    // read as a person's decision.
    expect(rendered).toContain('NOT a human decision')
    expect(rendered).not.toContain('by a human in the dsh UI')
  })

  it('says so when a fail-closed deny happened because nobody could be asked', () => {
    const rendered = renderDecisionBlock([decision({
      outcome: 'unavailable',
      decided_by: 'policy',
      detail: 'no dsh ask target is attached to this Claude Code session, so nobody could be asked',
    })], 'this turn')

    expect(rendered).toContain('denied by policy')
    expect(rendered).toContain('NOT a human decision, nobody was asked or nobody answered')
  })

  it('counts the two sources separately in a mixed turn', () => {
    const rendered = renderDecisionBlock([
      decision(),
      decision({ outcome: 'timed-out', decided_by: 'policy', tool_name: 'Write', reason: 'Write: /tmp/a.txt' }),
    ], 'this turn')

    expect(rendered.split('\n')[0]).toBe(
      '2 settled asks this turn (1 decided by a human, 1 settled by policy with no human involved):')
  })

  it('renders nothing at all when nothing settled, and leaves the turn prose untouched', () => {
    expect(renderDecisionBlock([], 'this turn')).toBe('')
    expect(renderWithDecisions('all done', [], 'this turn')).toBe('all done')
  })

  it('puts the decisions BEFORE the turn prose, so a model reads them first', () => {
    const rendered = renderWithDecisions('all done', [decision()], 'this turn')

    expect(rendered.startsWith('1 human decision this turn:')).toBe(true)
    expect(rendered.endsWith('all done')).toBe(true)
  })

  it('says when a decision answers an ask an EARLIER turn raised', () => {
    const rendered = renderDecisionBlock([decision({ asked_in_an_earlier_turn: true })], 'this turn')

    expect(rendered).toBe(
      '1 human decision this turn:\n'
      + '  1. permission for Bash (touch marker2.txt), raised during an EARLIER turn '
      + '— REJECTED by a human in the dsh UI')
  })

  it('summarises one session in a single listing line', () => {
    expect(renderLastDecision(1, decision()))
      .toBe('     last decision: permission for Bash (touch marker2.txt) — REJECTED by a human in the dsh UI')
    expect(renderLastDecision(3, decision())).toContain('(3 settled asks on this session; newest shown)')
    expect(renderLastDecision(0, undefined)).toBe('')
  })
})

describe('projectHumanDecisions', () => {
  it('drops empty optionals rather than shipping blank strings', () => {
    const projected = projectHumanDecisions([
      { kind: 'permission', toolName: '', outcome: 'allowed', askedAt: 1, settledAt: 2, source: 'human' },
    ])

    expect(projected).toEqual([{ kind: 'permission', outcome: 'allowed', decided_by: 'human' }])
  })

  it('flags only the receipts whose ask predates the turn window', () => {
    const receipts = [
      { kind: 'permission', toolName: 'Bash', outcome: 'allowed', askedAt: 10, settledAt: 30, source: 'human' },
      { kind: 'permission', toolName: 'Write', outcome: 'allowed', askedAt: 25, settledAt: 40, source: 'human' },
    ] as const

    const scoped = projectHumanDecisions(receipts, 20)
    expect(scoped[0]?.asked_in_an_earlier_turn).toBe(true)
    expect(scoped[1]).not.toHaveProperty('asked_in_an_earlier_turn')

    // A whole-session list has no turn to be earlier than, so it never claims one.
    for (const entry of projectHumanDecisions(receipts)) {
      expect(entry).not.toHaveProperty('asked_in_an_earlier_turn')
    }
  })

  it('keeps the seam order (oldest first) and carries the human\'s choice through', () => {
    const projected = projectHumanDecisions([
      { kind: 'question', toolName: 'AskUserQuestion', outcome: 'answered', detail: 'hola', askedAt: 1, settledAt: 2, source: 'human' },
      { kind: 'permission', toolName: 'Bash', outcome: 'rejected', askedAt: 3, settledAt: 4, source: 'human' },
    ])

    expect(projected.map(entry => entry.outcome)).toEqual(['answered', 'rejected'])
    expect(projected[0]?.detail).toBe('hola')
  })
})

/**
 * Open a session, attach a scripted answerer, and settle one permission on it.
 *
 * Everything below the tool layer is real, so this is the production path with a
 * fake subprocess: the CLI asks, the router routes, the dsh answerer decides,
 * and the ask table receipts it.
 * @param harness - the mounted composition.
 * @param outcome - what the scripted human clicks.
 * @param options - the tool call to decide, and the request id to key it on.
 * @returns the session id.
 */
async function settleOneApproval(
  harness: ToolHarness,
  outcome: 'allowed-once' | 'rejected',
  options: { sessionId?: string, command?: string, requestId?: string } = {},
): Promise<string> {
  let sessionId = options.sessionId
  if (sessionId === undefined) {
    const opened = await harness.call('claude_code_open', { cwd: CWD })
    sessionId = (opened.value as { session_id: string }).session_id
    harness.ctx.claudeCode.attachAskTarget(sessionId as never, {
      agent: fakeAgent(),
      delegated: false,
      approval: { request: async () => await Promise.resolve(outcome) },
    })
  }
  const command = options.command ?? 'touch marker2.txt'
  const query = await firstQuery(harness)
  await harness.call('claude_code_send', { session_id: sessionId, message: command, mode: 'followup' })
  await query.options.canUseTool?.(
    'Bash',
    { command },
    {
      signal: new AbortController().signal,
      toolUseID: options.requestId ?? 'toolu_1',
      requestId: options.requestId ?? 'req_1',
      title: `Bash: ${command}`,
    })
  await settle()
  return sessionId
}

describe('claude_code_wait: what a human decided during the turn', () => {
  it('reports a human rejection alongside the turn\'s own answer', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await settleOneApproval(harness, 'rejected')
      const query = await firstQuery(harness)

      const waiting = harness.call('claude_code_wait', { session_id: sessionId })
      await query.emitResult('success', { result: 'I could not create the file.' })
      const waited = await waiting

      expect(waited.isError, JSON.stringify(waited.error)).toBe(false)
      expect((waited.value as unknown as { human_decisions: CcHumanDecisionProjection[] }).human_decisions).toEqual([{
        kind: 'permission',
        tool_name: 'Bash',
        reason: 'Bash: touch marker2.txt',
        outcome: 'rejected',
        decided_by: 'human',
      }])
      // The sentence the delegating agent has to repeat instead of guessing.
      expect(text(waited)).toContain(
        '1. permission for Bash (touch marker2.txt) — REJECTED by a human in the dsh UI')
      expect(text(waited)).toContain('I could not create the file.')
    } finally {
      await harness.dispose()
    }
  })

  it('reports an empty list when a turn ran with nobody deciding anything', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', { session_id: sessionId, message: 'hi', mode: 'followup' })

      const waiting = harness.call('claude_code_wait', { session_id: sessionId })
      await query.emitResult('success', { result: 'hello' })
      const waited = await waiting

      // Present and empty: "no human was involved" is evidence, and an ABSENT
      // field would let a model read "I cannot tell" as "a human approved".
      expect((waited.value as unknown as { human_decisions: unknown[] }).human_decisions).toEqual([])
      expect(text(waited)).toBe('hello')
    } finally {
      await harness.dispose()
    }
  })

  it('reports ONLY the decisions of the turn it waited on', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await settleOneApproval(harness, 'allowed-once')
      const query = await firstQuery(harness)
      const firstWait = harness.call('claude_code_wait', { session_id: sessionId })
      await query.emitResult('success', { result: 'first turn done' })
      await firstWait

      // A clean millisecond boundary between the two turns.
      await tick()

      await settleOneApproval(harness, 'allowed-once',
        { sessionId, command: 'touch marker3.txt', requestId: 'req_2' })
      const secondWait = harness.call('claude_code_wait', { session_id: sessionId })
      await query.emitResult('success', { result: 'second turn done' })
      const waited = await secondWait

      const decisions = (waited.value as unknown as { human_decisions: CcHumanDecisionProjection[] }).human_decisions
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.reason).toBe('Bash: touch marker3.txt')
      expect(text(waited)).not.toContain('marker2.txt')
    } finally {
      await harness.dispose()
    }
  })
})

describe('an ask that straddles a turn boundary', () => {
  it('reports it under the turn it SETTLED in, labelled as raised earlier', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      // A human who is still looking at the prompt when the turn under it ends.
      let click: (outcome: 'allowed-once') => void = () => {}
      const clicked = new Promise<'allowed-once'>(resolve => { click = resolve })
      harness.ctx.claudeCode.attachAskTarget(sessionId as never, {
        agent: fakeAgent(),
        delegated: false,
        approval: { request: async () => await clicked },
      })
      const query = await firstQuery(harness)

      // Turn 1 raises the ask and then ENDS underneath it — what an interrupt
      // does to a turn whose permission prompt is still open in the dsh UI.
      await harness.call('claude_code_send', { session_id: sessionId, message: 'go', mode: 'followup' })
      const asking = query.options.canUseTool?.('Bash', { command: 'touch marker2.txt' }, {
        signal: new AbortController().signal,
        toolUseID: 'toolu_1',
        requestId: 'req_1',
        title: 'Bash: touch marker2.txt',
      })
      await settle()
      const firstWait = harness.call('claude_code_wait', { session_id: sessionId })
      await query.emitResult('success', { result: 'first turn ended' })
      const firstWaited = await firstWait
      // Turn 1 settled nothing: the person had not clicked yet, and saying "1
      // human decision" here would be the invention, one turn early.
      expect((firstWaited.value as unknown as { human_decisions: unknown[] }).human_decisions).toEqual([])

      await tick()

      // Turn 2 starts. THEN the human clicks.
      await harness.call('claude_code_send', { session_id: sessionId, message: 'and again', mode: 'followup' })
      const secondWait = harness.call('claude_code_wait', { session_id: sessionId })
      click('allowed-once')
      await asking
      await settle()
      await query.emitResult('success', { result: 'second turn done' })
      const waited = await secondWait

      const decisions = (waited.value as unknown as {
        human_decisions: CcHumanDecisionProjection[]
      }).human_decisions
      // Reported HERE — the settle is the event, and a decision no tool result
      // ever mentions is the failure this feature exists to end.
      expect(decisions).toEqual([{
        kind: 'permission',
        tool_name: 'Bash',
        reason: 'Bash: touch marker2.txt',
        outcome: 'allowed',
        decided_by: 'human',
        asked_in_an_earlier_turn: true,
      }])
      // And labelled, so nothing reads as approval of THIS turn's work.
      expect(text(waited)).toContain(
        '1. permission for Bash (touch marker2.txt), raised during an EARLIER turn '
        + '— ALLOWED by a human in the dsh UI')
    } finally {
      await harness.dispose()
    }
  })

  it('does not label a decision made inside the turn that raised it', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await settleOneApproval(harness, 'rejected')
      const query = await firstQuery(harness)

      const waiting = harness.call('claude_code_wait', { session_id: sessionId })
      await query.emitResult('success', { result: 'done' })
      const waited = await waiting

      const [only] = (waited.value as unknown as {
        human_decisions: CcHumanDecisionProjection[]
      }).human_decisions
      expect(only).not.toHaveProperty('asked_in_an_earlier_turn')
      expect(text(waited)).not.toContain('EARLIER turn')
    } finally {
      await harness.dispose()
    }
  })
})

describe('a resumed or forked session', () => {
  it('starts with an empty decision record — a fork never inherits the parent\'s', async () => {
    const harness = await mountTools()
    try {
      const parentId = await settleOneApproval(harness, 'rejected')
      const parentQuery = await firstQuery(harness)
      const parentWait = harness.call('claude_code_wait', { session_id: parentId })
      await parentQuery.emitResult('success', { result: 'parent turn done' })
      await parentWait

      // The child carries the parent's TRANSCRIPT, never its decisions: the ask
      // table is per actor, and a human who rejected something in the parent
      // did not approve anything here.
      const forked = await harness.call('claude_code_open', { cwd: CWD, resume: parentId, fork: true })
      const childId = (forked.value as { session_id: string }).session_id
      expect(childId).not.toBe(parentId)

      const childQuery = await firstQuery(harness, 1)
      await harness.call('claude_code_send', { session_id: childId, message: 'carry on', mode: 'followup' })
      const childWait = harness.call('claude_code_wait', { session_id: childId })
      await childQuery.emitResult('success', { result: 'child turn done' })
      const waited = await childWait

      expect((waited.value as unknown as { human_decisions: unknown[] }).human_decisions).toEqual([])
      expect(text(waited)).toBe('child turn done')
      const status = await harness.call('claude_code_status', { session_id: childId })
      expect((status.value as unknown as { human_decisions: unknown[] }).human_decisions).toEqual([])
      // The parent still remembers its own.
      const parentStatus = await harness.call('claude_code_status', { session_id: parentId })
      expect((parentStatus.value as unknown as { human_decisions: unknown[] }).human_decisions).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('reports the LIVE session\'s decisions when a plain resume reuses the id', async () => {
    const harness = await mountTools()
    try {
      const firstId = await settleOneApproval(harness, 'rejected')
      const query = await firstQuery(harness)
      const waiting = harness.call('claude_code_wait', { session_id: firstId })
      await query.emitResult('success', { result: 'done' })
      await waiting
      await harness.call('claude_code_close', { session_id: firstId })

      // A plain resume continues under the SAME id. The tombstone holds the old
      // session's receipts; the live actor holds none. Reporting the tombstone's
      // would attribute a decision from a session that has ended to the one
      // running now.
      const resumed = await harness.call('claude_code_open', { cwd: CWD, resume: firstId })
      expect((resumed.value as { session_id: string }).session_id).toBe(firstId)

      const status = await harness.call('claude_code_status', { session_id: firstId })
      expect((status.value as unknown as { human_decisions: unknown[] }).human_decisions).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

describe('claude_code_status and claude_code_list', () => {
  it('reports every settled ask on the session, and says who settled it', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await settleOneApproval(harness, 'allowed-once')

      const status = await harness.call('claude_code_status', { session_id: sessionId })

      expect(status.isError, JSON.stringify(status.error)).toBe(false)
      expect((status.value as unknown as { human_decisions: CcHumanDecisionProjection[] }).human_decisions)
        .toMatchObject([{ outcome: 'allowed', decided_by: 'human', tool_name: 'Bash' }])
      expect(text(status)).toContain('1 human decision on this session:')
      expect(text(status)).toContain('ALLOWED by a human in the dsh UI')
    } finally {
      await harness.dispose()
    }
  })

  it('carries a count plus the most recent decision per session, compactly', async () => {
    const harness = await mountTools()
    try {
      const sessionId = await settleOneApproval(harness, 'rejected')

      const listed = await harness.call('claude_code_list', {})
      const sessions = (listed.value as unknown as {
        sessions: { session_id: string, human_decisions_count: number,
          last_human_decision?: CcHumanDecisionProjection }[]
      }).sessions
      const row = sessions.find(entry => entry.session_id === sessionId)

      expect(row?.human_decisions_count).toBe(1)
      expect(row?.last_human_decision).toMatchObject({ outcome: 'rejected', decided_by: 'human' })
      expect(text(listed)).toContain('last decision: permission for Bash (touch marker2.txt) — REJECTED by a human')
      // Compact: one extra line per session, never the whole history.
      expect(text(listed).split('\n').filter(line => line.includes('last decision:'))).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('renders a listing with no settled asks exactly as before', () => {
    const rendered = renderSessionList([{
      session_id: 'session-a',
      status: 'idle',
      cwd: '/repo/api',
      age_ms: 1_000,
      pending_asks: 0,
      pending_ask_details: [],
      human_decisions_count: 0,
    }], false)

    expect(rendered).not.toContain('last decision')
  })
})

describe('claude_code_cancel: still_queued is always stated', () => {
  it('says ZERO explicitly when nothing survived the cancel', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      await harness.call('claude_code_send', { session_id: sessionId, message: 'go', mode: 'followup' })

      const cancelled = await harness.call('claude_code_cancel', { session_id: sessionId })

      expect((cancelled.value as unknown as { still_queued: string[] }).still_queued).toEqual([])
      // The old render stopped at "cancelled session X", and the operator's
      // agent read the silence as "no still_queued value was returned".
      expect(text(cancelled)).toBe(
        `cancelled session ${sessionId}; still_queued is empty: 0 queued messages survived this cancel.`)
    } finally {
      await harness.dispose()
    }
  })

  it('names the ids that survived, and how many', async () => {
    const harness = await mountTools()
    try {
      const opened = await harness.call('claude_code_open', { cwd: CWD })
      const sessionId = (opened.value as { session_id: string }).session_id
      const query = await firstQuery(harness)
      await harness.call('claude_code_send', { session_id: sessionId, message: 'first', mode: 'followup' })
      await harness.call('claude_code_send', { session_id: sessionId, message: 'queued', mode: 'followup' })
      // The CLI's interrupt receipt: the second send outlived the cancel.
      const queued = String(harness.ctx.claudeCode.session(sessionId as never)?.outbox()[1]?.uuid)
      query.receipts.push({ still_queued: [queued] })

      const cancelled = await harness.call('claude_code_cancel', { session_id: sessionId })
      const stillQueued = (cancelled.value as unknown as { still_queued: string[] }).still_queued

      expect(stillQueued).toHaveLength(1)
      expect(text(cancelled)).toContain('1 queued message(s) survived and will still run — still_queued: ')
      expect(text(cancelled)).toContain(stillQueued[0] as string)
    } finally {
      await harness.dispose()
    }
  })
})
