/**
 * Settled-ask RECEIPTS: the record of what a human (or a policy) decided.
 *
 * The failure this covers is a misreport, not a crash. An operator ran the
 * 13-step acceptance test through the real dsh UI, answering every prompt by
 * hand; the delegating agent then graded a working integration 7 PASS / 5
 * PARTIAL / 1 FAIL, and every one of its three worst calls was a guess about a
 * human it could not see:
 *
 * - a permission the human REJECTED was reported as "the denial was not
 *   propagated — the file was created anyway" (it was not created);
 * - a plan the human APPROVED was reported as "FAIL — no plan review happened";
 * - a question the human ANSWERED ("hola") was reported as "session auto-chose".
 *
 * Pending asks were already visible. SETTLED asks were not, so "a human chose
 * hola" and "Claude invented hola" produced identical observations. These specs
 * pin the seam half: every settle path leaves a receipt, each receipt says
 * whether a HUMAN or a POLICY produced it, the human's actual choice is carried,
 * and the ring is bounded so a long session cannot grow a transcript in memory.
 *
 * The `source` assertions are the load-bearing ones. A receipt that claimed
 * `human` for a timeout would be worse than no receipt at all: it would let an
 * agent report a machine's fail-closed deny as the operator's refusal.
 */

import {
  ASK_SESSION_CLOSED_DETAIL, ASK_WITHDRAWN_DETAIL, CC_ASK_OUTCOMES, CC_ASK_SOURCES,
  CC_ASK_USER_QUESTION, CC_EXIT_PLAN_MODE, CC_PLAN_APPROVE_LABEL, CC_PLAN_DECLINE_LABEL,
  CC_PLAN_REVIEW_ID, CcAskTable, DEFAULT_RECEIPT_LIMIT,
} from '@deepseek-ai/dsh-claude-code'
import type { CcAskReceipt, CcPermissionDecision } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeCallSite, FakeUserQuestionError, makeRequest, makeRouter, settle } from './ask-helpers.ts'
import type { AskHarness } from './ask-helpers.ts'

/** Harnesses built by a test, cleaned up afterwards. */
const built: AskHarness[] = []

afterEach(() => {
  while (built.length > 0) built.pop()?.cleanup()
})

/**
 * Build a router harness and register it for cleanup.
 * @param options - harness options.
 * @returns the harness.
 */
function harness(options: Parameters<typeof makeRouter>[0] = {}): AskHarness {
  const made = makeRouter(options)
  built.push(made)
  return made
}

/** An allow, for a table driven directly (no router, no seam, no human). */
const ALLOW: CcPermissionDecision = { behavior: 'allow', updatedInput: {} }

/** One `AskUserQuestion` input with a single option list. */
const GREETING = {
  questions: [{
    question: 'Which greeting?',
    header: 'Greeting',
    options: [{ label: 'hola' }, { label: 'bonjour' }],
  }],
}

/**
 * The only receipt on a router, asserted to exist.
 * @param made - the harness.
 * @returns the single receipt.
 */
function only(made: AskHarness): CcAskReceipt {
  const receipts = made.router.recentAsks
  expect(receipts).toHaveLength(1)
  const receipt = receipts[0]
  if (receipt === undefined) throw new Error('no receipt was recorded')
  return receipt
}

describe('receipts: the permission path', () => {
  it('records a HUMAN allow, naming the tool and the sentence the human read', async () => {
    const made = harness()
    made.approval.outcomes = ['allowed-once']

    await made.router.canUseTool('Bash', { command: 'touch marker.txt' },
      makeRequest({ title: 'Bash: touch marker.txt' }))

    expect(only(made)).toMatchObject({
      kind: 'permission',
      toolName: 'Bash',
      reason: 'Bash: touch marker.txt',
      outcome: 'allowed',
      source: 'human',
    })
    // The reason is the SAME string the approval seam was given, so the words a
    // model reports and the words the human answered cannot drift apart.
    expect(only(made).reason).toBe(made.approval.requests[0]?.reason)
  })

  it('records a HUMAN reject — the case an agent reported as "the denial was not propagated"', async () => {
    const made = harness()
    made.approval.outcomes = ['rejected']

    const decision = await made.router.canUseTool('Bash', { command: 'touch marker2.txt' },
      makeRequest({ title: 'Bash: touch marker2.txt' }))

    expect(decision).toEqual({ behavior: 'deny', message: 'User rejected this action' })
    expect(only(made)).toMatchObject({
      kind: 'permission',
      toolName: 'Bash',
      reason: 'Bash: touch marker2.txt',
      outcome: 'rejected',
      source: 'human',
    })
  })

  it('records a dismissed prompt as cancelled and does NOT attribute it to a human', async () => {
    const made = harness()
    // The approval seam says `cancelled` both when a person closes the prompt
    // and when it is taken down underneath them. One word, two stories — so the
    // receipt refuses to pick the flattering one.
    made.approval.outcomes = ['cancelled']

    await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(only(made)).toMatchObject({ outcome: 'cancelled', source: 'policy' })
    expect(only(made).detail).toContain('dismissed or withdrawn')
  })

  it('records a rule-cache allow as POLICY: it is a grant nobody was asked for now', async () => {
    // A rule seeded from configuration is the same code path a stored
    // always-allow takes: the prompt is skipped entirely.
    const made = harness({ config: { ask: { rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] } } })

    const decision = await made.router.canUseTool('Bash', { command: 'npm test' }, makeRequest({
      suggestions: [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      }],
    }))

    expect(decision.behavior).toBe('allow')
    // Nobody was asked, so nobody can be reported as having decided.
    expect(made.approval.requests).toHaveLength(0)
    expect(only(made)).toMatchObject({ outcome: 'allowed', source: 'policy' })
    expect(only(made).detail).toContain('always-allow rule cache')
  })

  it('records a fail-closed deny (no ask target) as POLICY, never as a human decision', async () => {
    const made = harness({ noTarget: true })

    const decision = await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(decision.behavior).toBe('deny')
    expect(only(made)).toMatchObject({ kind: 'permission', outcome: 'unavailable', source: 'policy' })
    expect(only(made).detail).toContain('nobody could be asked')
  })

  it('records an approval-seam failure (no open turn) as POLICY unavailable', async () => {
    const made = harness()
    made.approval.throws = new Error('no open turn')

    await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())

    expect(only(made)).toMatchObject({ outcome: 'unavailable', source: 'policy' })
  })
})

describe('receipts: the question path', () => {
  it('carries the option the human PICKED — the "session auto-chose hola" misreport', async () => {
    const made = harness()
    made.questions.answer = { answers: [{ id: 'Which greeting?', selected: ['hola'] }] }

    await made.router.canUseTool(CC_ASK_USER_QUESTION, GREETING, makeRequest())

    expect(only(made)).toMatchObject({
      kind: 'question',
      toolName: CC_ASK_USER_QUESTION,
      reason: 'Which greeting?',
      outcome: 'answered',
      source: 'human',
      detail: 'hola',
    })
  })

  it('carries CUSTOM text a human typed, not the option labels they ignored', async () => {
    const made = harness()
    made.questions.answer = {
      answers: [{ id: 'Which greeting?', selected: [], custom: 'g’day, and use British spelling' }],
    }

    await made.router.canUseTool(CC_ASK_USER_QUESTION, GREETING, makeRequest())

    expect(only(made).detail).toBe('g’day, and use British spelling')
    expect(only(made).source).toBe('human')
  })

  it('names each question when several were answered at once', async () => {
    const made = harness()
    const input = {
      questions: [
        { question: 'Which database?', options: [{ label: 'Postgres' }] },
        { question: 'Which extras?', multiSelect: true, options: [{ label: 'Metrics' }, { label: 'Tracing' }] },
      ],
    }
    made.questions.answer = {
      answers: [
        { id: 'Which database?', selected: ['Postgres'] },
        { id: 'Which extras?', selected: ['Metrics', 'Tracing'] },
      ],
    }

    await made.router.canUseTool(CC_ASK_USER_QUESTION, input, makeRequest())

    expect(only(made).detail).toBe('Which database?: Postgres; Which extras?: Metrics, Tracing')
  })

  it('records a routing failure as POLICY, even when first-option answered it', async () => {
    const made = harness({ config: { ask: { fallback: 'first-option' } } })
    made.questions.throws = new FakeUserQuestionError('NO_PROVIDER')

    const decision = await made.router.canUseTool(CC_ASK_USER_QUESTION, GREETING, makeRequest())

    // The tool call succeeded — and NOBODY chose. That is exactly the pair of
    // facts an agent has to be able to report separately.
    expect(decision.behavior).toBe('allow')
    expect(only(made)).toMatchObject({ outcome: 'answered', source: 'policy' })
    expect(only(made).detail).toContain('no human answered')
  })
})

describe('receipts: the plan path', () => {
  it('records a HUMAN plan approval — the case an agent read as "plan mode never engaged"', async () => {
    const made = harness()
    made.questions.answer = { answers: [{ id: CC_PLAN_REVIEW_ID, selected: [CC_PLAN_APPROVE_LABEL] }] }

    const decision = await made.router.canUseTool(CC_EXIT_PLAN_MODE, { plan: '# Plan\n1. write README' },
      makeRequest())

    expect(decision.behavior).toBe('allow')
    expect(only(made)).toMatchObject({
      kind: 'plan',
      toolName: CC_EXIT_PLAN_MODE,
      outcome: 'allowed',
      source: 'human',
    })
    expect(only(made).detail).toContain(CC_PLAN_APPROVE_LABEL)
  })

  it('records a decline WITH the feedback the human typed', async () => {
    const made = harness()
    made.questions.answer = {
      answers: [{ id: CC_PLAN_REVIEW_ID, selected: [CC_PLAN_DECLINE_LABEL], custom: 'add a rollback step' }],
    }

    await made.router.canUseTool(CC_EXIT_PLAN_MODE, { plan: '# Plan' }, makeRequest())

    expect(only(made)).toMatchObject({ kind: 'plan', outcome: 'rejected', source: 'human' })
    expect(only(made).detail).toContain('add a rollback step')
  })

  it('records a dismissed review as a HUMAN cancellation (they took the turn back to speak)', async () => {
    const made = harness()
    made.questions.throws = new FakeUserQuestionError('ASK_CANCELLED')

    await made.router.canUseTool(CC_EXIT_PLAN_MODE, { plan: '# Plan' }, makeRequest())

    expect(only(made)).toMatchObject({ kind: 'plan', outcome: 'cancelled', source: 'human' })
  })
})

describe('receipts: the paths where nobody answered', () => {
  it('records a TIMEOUT as policy, with the fallback that answered it', async () => {
    const made = harness({ config: { ask: { timeoutMs: 5 } } })
    // Nobody ever clicks: the prompt is up in the dsh UI and the wait elapses.
    made.approval.gate = new Promise<void>(() => {})

    const decision = await made.router.canUseTool('Bash', { command: 'rm -rf build' },
      makeRequest({ title: 'Bash: rm -rf build' }))

    expect(decision.behavior).toBe('deny')
    expect(only(made)).toMatchObject({
      kind: 'permission',
      toolName: 'Bash',
      outcome: 'timed-out',
      source: 'policy',
    })
    expect(only(made).detail).toContain('no human answered')
  })

  it('records an SDK withdrawal as a policy cancellation', async () => {
    const made = harness()
    const controller = new AbortController()
    made.approval.gate = new Promise<void>(() => {})

    const pending = made.router.canUseTool('Bash', { command: 'ls' },
      makeRequest({ signal: controller.signal }))
    await settle()
    controller.abort()
    await pending

    expect(only(made)).toMatchObject({ outcome: 'cancelled', source: 'policy', detail: ASK_WITHDRAWN_DETAIL })
  })

  it('records the close drain as a policy cancellation, one receipt per open ask', async () => {
    const made = harness()
    made.approval.gate = new Promise<void>(() => {})
    const first = made.router.canUseTool('Bash', { command: 'ls' }, makeRequest({ requestId: 'req_1' }))
    const second = made.router.canUseTool('Write', { file_path: '/tmp/a' }, makeRequest({ requestId: 'req_2' }))
    await settle()

    expect(made.router.settleAll()).toBe(2)
    await Promise.all([first, second])

    expect(made.router.recentAsks).toHaveLength(2)
    for (const receipt of made.router.recentAsks) {
      expect(receipt).toMatchObject({
        outcome: 'cancelled',
        source: 'policy',
        detail: ASK_SESSION_CLOSED_DETAIL,
      })
    }
  })
})

describe('the receipt ring', () => {
  it('keeps the last 20 and evicts the oldest — the 21st ask drops the 1st', async () => {
    const table = new CcAskTable()
    for (let index = 1; index <= DEFAULT_RECEIPT_LIMIT + 1; index += 1) {
      await table.run(
        { requestId: `r${index}`, toolName: `Tool${index}`, onTimeout: () => ALLOW },
        async () => await Promise.resolve(ALLOW))
    }

    const receipts = table.receipts()
    expect(receipts).toHaveLength(DEFAULT_RECEIPT_LIMIT)
    // Newest LAST, oldest gone.
    expect(receipts[0]?.toolName).toBe('Tool2')
    expect(receipts[receipts.length - 1]?.toolName).toBe(`Tool${DEFAULT_RECEIPT_LIMIT + 1}`)
  })

  it('honors a configured bound', async () => {
    const table = new CcAskTable({ receiptLimit: 2 })
    for (const id of ['a', 'b', 'c']) {
      await table.run({ requestId: id, toolName: id, onTimeout: () => ALLOW },
        async () => await Promise.resolve(ALLOW))
    }

    expect(table.receipts().map(receipt => receipt.toolName)).toEqual(['b', 'c'])
  })

  it('records a bare decision as POLICY: a caller that claims no human is never given one', async () => {
    const table = new CcAskTable()

    await table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW },
      async () => await Promise.resolve(ALLOW))

    expect(table.receipts()[0]).toMatchObject({ outcome: 'allowed', source: 'policy' })
  })

  it('filters by settle time, so a caller can report ONE turn\'s decisions', async () => {
    const table = new CcAskTable()
    await table.run({ requestId: 'r1', toolName: 'First', onTimeout: () => ALLOW },
      async () => await Promise.resolve(ALLOW))
    // A turn boundary: everything before this instant belongs to the last turn.
    await settle()
    const turnTwo = Date.now()
    await settle()
    await table.run({ requestId: 'r2', toolName: 'Second', onTimeout: () => ALLOW },
      async () => await Promise.resolve(ALLOW))

    expect(table.receiptsSince(turnTwo).map(receipt => receipt.toolName)).toEqual(['Second'])
    expect(table.receipts()).toHaveLength(2)
  })

  it('times each receipt against the ask it belongs to', async () => {
    const made = harness()
    made.approval.outcomes = ['allowed-once']

    const before = Date.now()
    await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
    const after = Date.now()

    const receipt = only(made)
    expect(receipt.askedAt).toBeGreaterThanOrEqual(before)
    expect(receipt.settledAt).toBeGreaterThanOrEqual(receipt.askedAt)
    expect(receipt.settledAt).toBeLessThanOrEqual(after)
  })
})

describe('the one lie: no policy settle may ever be attributed to a human', () => {
  /**
   * Every settle path that reaches a decision WITHOUT a person answering, each
   * driven through the real router (or the real table, where the path lives
   * there). The assertion is uniform and negative: `source` is `policy`, and the
   * receipt therefore cannot be rendered as an operator's decision.
   *
   * The list is exhaustive by construction — one entry per `return` in
   * `router.ts` that is not an `ApprovalOutcome` decision, a question answer or
   * a plan choice, plus the three the table owns (timeout, abort, close).
   */
  const CASES: { name: string, expect?: Partial<CcAskReceipt>, run: () => Promise<readonly CcAskReceipt[]> }[] = [
    {
      name: 'the stored always-allow rule cache',
      expect: { outcome: 'allowed' },
      run: async () => {
        const made = harness({ config: { ask: { rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] } } })
        await made.router.canUseTool('Bash', { command: 'npm test' }, makeRequest({
          suggestions: [{
            type: 'addRules',
            behavior: 'allow',
            destination: 'localSettings',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
          }],
        }))
        return made.router.recentAsks
      },
    },
    {
      name: 'no ask target attached',
      expect: { outcome: 'unavailable' },
      run: async () => {
        const made = harness({ noTarget: true })
        await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'no approval seam mounted in the composition',
      expect: { outcome: 'unavailable' },
      run: async () => {
        const made = harness({ noApproval: true })
        await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'the approval prompt was dismissed or withdrawn',
      expect: { outcome: 'cancelled' },
      run: async () => {
        const made = harness()
        made.approval.outcomes = ['cancelled']
        await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'the approval seam answered "unavailable"',
      expect: { outcome: 'unavailable' },
      run: async () => {
        const made = harness()
        made.approval.outcomes = ['unavailable']
        await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'the approval seam threw (no open turn)',
      expect: { outcome: 'unavailable' },
      run: async () => {
        const made = harness()
        made.approval.throws = new Error('no open turn')
        await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'the SDK withdrew the request while its tool/call was being correlated',
      expect: { outcome: 'cancelled' },
      run: async () => {
        const made = harness({ deps: { callIdWaitMs: 200, callIdPollMs: 5 } })
        made.router.attachCallSite(new FakeCallSite())
        const controller = new AbortController()
        const pending = made.router.canUseTool('Bash', { command: 'ls' },
          makeRequest({ signal: controller.signal }))
        await settle()
        controller.abort()
        await pending
        return made.router.recentAsks
      },
    },
    {
      name: 'the configured wait elapsed with the prompt still on screen',
      expect: { outcome: 'timed-out' },
      run: async () => {
        const made = harness({ config: { ask: { timeoutMs: 5 } } })
        made.approval.gate = new Promise<void>(() => {})
        await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'the timeout policy itself threw',
      expect: { outcome: 'unavailable' },
      run: async () => {
        const table = new CcAskTable()
        await table.run({
          requestId: 'r1',
          toolName: 'Bash',
          timeoutMs: 1,
          onTimeout: () => {
            throw new Error('boom')
          },
        }, async () => await new Promise<CcPermissionDecision>(() => {}))
        return table.receipts()
      },
    },
    {
      name: 'the session closed with the ask still open',
      expect: { outcome: 'cancelled' },
      run: async () => {
        const made = harness()
        made.approval.gate = new Promise<void>(() => {})
        const pending = made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
        await settle()
        made.router.settleAll()
        await pending
        return made.router.recentAsks
      },
    },
    {
      name: 'a question call carrying nothing this seam could map',
      expect: { kind: 'question', outcome: 'fallback-denied' },
      run: async () => {
        const made = harness()
        await made.router.canUseTool(CC_ASK_USER_QUESTION, { questions: [] }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'no user-questions seam mounted',
      expect: { kind: 'question', outcome: 'unavailable' },
      run: async () => {
        const made = harness({ noQuestions: true })
        await made.router.canUseTool(CC_ASK_USER_QUESTION, GREETING, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'the questions seam failed and the deny policy answered',
      expect: { kind: 'question', outcome: 'fallback-denied' },
      run: async () => {
        const made = harness()
        made.questions.throws = new FakeUserQuestionError('NO_PROVIDER')
        await made.router.canUseTool(CC_ASK_USER_QUESTION, GREETING, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'the first-option policy answered a question nobody saw',
      expect: { kind: 'question', outcome: 'answered' },
      run: async () => {
        const made = harness({ config: { ask: { fallback: 'first-option' } } })
        made.questions.throws = new FakeUserQuestionError('NO_PROVIDER')
        await made.router.canUseTool(CC_ASK_USER_QUESTION, GREETING, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'a plan review with no seam to review it',
      expect: { kind: 'plan', outcome: 'unavailable' },
      run: async () => {
        const made = harness({ noQuestions: true })
        await made.router.canUseTool(CC_EXIT_PLAN_MODE, { plan: '# Plan' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'a plan review the SDK aborted (ASK_ABORTED is not a person closing it)',
      expect: { kind: 'plan' },
      run: async () => {
        const made = harness()
        made.questions.throws = new FakeUserQuestionError('ASK_ABORTED')
        await made.router.canUseTool(CC_EXIT_PLAN_MODE, { plan: '# Plan' }, makeRequest())
        return made.router.recentAsks
      },
    },
    {
      name: 'a caller that returned a bare decision, claiming nothing about anyone',
      run: async () => {
        const table = new CcAskTable()
        await table.run({ requestId: 'r1', toolName: 'Bash', onTimeout: () => ALLOW },
          async () => await Promise.resolve({ behavior: 'deny', message: 'nope' } as CcPermissionDecision))
        return table.receipts()
      },
    },
  ]

  for (const testCase of CASES) {
    it(`records ${testCase.name} as POLICY`, async () => {
      const receipts = await testCase.run()

      expect(receipts).toHaveLength(1)
      const receipt = receipts[0]
      if (receipt === undefined) throw new Error('no receipt was recorded')
      // THE assertion. A `human` here would let an agent report a machine's
      // fail-closed answer as the operator's — which is worse than the silence
      // this whole feature replaced.
      expect(receipt.source).toBe('policy')
      if (testCase.expect !== undefined) expect(receipt).toMatchObject(testCase.expect)
    })
  }

  it('discards a human\'s LATE click rather than rewriting a policy receipt', async () => {
    // The prompt timed out; the SDK already has its deny. The person clicks
    // approve a moment later. The tool call did NOT run, so a receipt saying a
    // human allowed it would describe a world that never happened.
    const made = harness({ config: { ask: { timeoutMs: 5 } } })
    let click: () => void = () => {}
    made.approval.gate = new Promise<void>(resolve => { click = resolve })
    made.approval.outcomes = ['allowed-once']

    const decision = await made.router.canUseTool('Bash', { command: 'ls' }, makeRequest())
    click()
    await settle()

    expect(decision.behavior).toBe('deny')
    expect(made.router.recentAsks).toHaveLength(1)
    expect(only(made)).toMatchObject({ outcome: 'timed-out', source: 'policy' })
  })
})

describe('receipts and redelivery (delta S12)', () => {
  it('writes ONE receipt when a settled requestId is redelivered', async () => {
    const table = new CcAskTable()
    const work = async (): Promise<CcPermissionDecision> => await Promise.resolve(ALLOW)

    await table.run({ requestId: 'req_1', toolName: 'Bash', onTimeout: () => ALLOW }, work)
    await table.run({ requestId: 'req_1', toolName: 'Bash', onTimeout: () => ALLOW }, work)
    await table.run({ requestId: 'req_1', toolName: 'Bash', onTimeout: () => ALLOW }, work)

    // Three deliveries, one ask, one decision — so exactly one receipt. A
    // duplicate would tell a reader the human was asked (and answered) three
    // times about one tool call.
    expect(table.receipts()).toHaveLength(1)
  })

  it('writes ONE receipt when a redelivery attaches to an ask still in flight', async () => {
    const made = harness()
    let click: () => void = () => {}
    made.approval.gate = new Promise<void>(resolve => { click = resolve })
    made.approval.outcomes = ['rejected']

    const first = made.router.canUseTool('Bash', { command: 'ls' }, makeRequest({ requestId: 'req_1' }))
    await settle()
    // The SDK reinitialized and redelivered the same request, with a FRESH
    // signal, while the human was still looking at the prompt.
    const redelivered = made.router.canUseTool('Bash', { command: 'ls' },
      makeRequest({ requestId: 'req_1', signal: new AbortController().signal }))
    await settle()
    click()
    const [one, two] = await Promise.all([first, redelivered])

    expect(one).toEqual(two)
    expect(made.approval.requests).toHaveLength(1)
    expect(made.router.recentAsks).toHaveLength(1)
    expect(only(made)).toMatchObject({ outcome: 'rejected', source: 'human' })
  })

  it('holds the ring bound under a session that settles thousands of asks', async () => {
    const table = new CcAskTable()
    const total = 5_000

    for (let index = 1; index <= total; index += 1) {
      await table.run(
        { requestId: `req_${index}`, toolName: `Tool${index}`, onTimeout: () => ALLOW },
        async () => await Promise.resolve(ALLOW))
    }

    const receipts = table.receipts()
    expect(receipts).toHaveLength(DEFAULT_RECEIPT_LIMIT)
    // The tail is the LAST twenty, in order: the ring never reorders and never
    // grows, which is what keeps a week-long session from holding a transcript.
    expect(receipts.map(receipt => receipt.toolName))
      .toEqual(Array.from({ length: DEFAULT_RECEIPT_LIMIT }, (_, offset) => `Tool${total - DEFAULT_RECEIPT_LIMIT + offset + 1}`))
    expect(table.pendingCount).toBe(0)
  })
})

describe('the receipt vocabulary', () => {
  it('declares every outcome and source it can produce', () => {
    expect([...CC_ASK_OUTCOMES].sort()).toEqual([
      'allowed', 'answered', 'cancelled', 'fallback-denied', 'rejected', 'timed-out', 'unavailable',
    ])
    expect([...CC_ASK_SOURCES].sort()).toEqual(['human', 'policy'])
  })
})
