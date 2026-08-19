import {
  CC_ASK_USER_QUESTION, CC_EXIT_PLAN_MODE, CC_PLAN_REVIEW_ID, mapAnswers, mapQuestions,
} from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeUserQuestionError, makeRequest, makeRouter } from './ask-helpers.ts'
import type { AskHarness } from './ask-helpers.ts'

/**
 * §4.2 (clarifying questions) and §4.3 (plan review): the mapping in both
 * directions, and the decisions each answer shape produces.
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

/** One `AskUserQuestion` input with two questions. */
const TWO_QUESTIONS = {
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      options: [
        { label: 'Postgres', description: 'Relational', preview: '<b>pg</b>' },
        { label: 'SQLite', description: 'Embedded' },
      ],
    },
    {
      question: 'Which extras?',
      multiSelect: true,
      options: [{ label: 'Metrics' }, { label: 'Tracing' }],
    },
  ],
}

describe('mapQuestions (§4.2)', () => {
  it('uses the question text as the id, keeps header/options, and drops preview', () => {
    const mapped = mapQuestions(TWO_QUESTIONS)

    expect(mapped).toHaveLength(2)
    expect(mapped[0]?.item).toEqual({
      id: 'Which database?',
      question: 'Which database?',
      header: 'Database',
      options: [
        { label: 'Postgres', description: 'Relational' },
        { label: 'SQLite', description: 'Embedded' },
      ],
    })
    expect(mapped[1]?.item.multiSelect).toBe(true)
  })

  it('suffixes colliding ids and keeps the original text for the answer key (§4.2.1)', () => {
    const mapped = mapQuestions({
      questions: [
        { question: 'Which one?', options: [{ label: 'a' }] },
        { question: 'Which one?', options: [{ label: 'b' }] },
        { question: 'Which one?', options: [{ label: 'c' }] },
      ],
    })

    expect(mapped.map(question => question.id)).toEqual(['Which one?', 'Which one? #2', 'Which one? #3'])
    expect(mapped.map(question => question.text)).toEqual(['Which one?', 'Which one?', 'Which one?'])
  })

  it('caps an over-long header and skips entries with no question text', () => {
    const mapped = mapQuestions({
      questions: [
        { question: 'ok', header: 'h'.repeat(200), options: [{ label: 'a' }] },
        { question: '   ' },
        { notAQuestion: true },
      ],
    })

    expect(mapped).toHaveLength(1)
    expect(mapped[0]?.item.header?.length).toBe(64)
  })

  it('returns nothing for input that carries no questions array', () => {
    expect(mapQuestions({})).toEqual([])
  })
})

describe('mapAnswers (§4.2, D4/S4)', () => {
  it('keys by question TEXT, joins a single-select and keeps a multi-select array', () => {
    const mapped = mapQuestions(TWO_QUESTIONS)

    const answers = mapAnswers(mapped, {
      answers: [
        { id: 'Which database?', selected: ['Postgres'] },
        { id: 'Which extras?', selected: ['Metrics', 'Tracing'] },
      ],
    })

    expect(answers).toEqual({
      'Which database?': 'Postgres',
      'Which extras?': ['Metrics', 'Tracing'],
    })
  })

  it('lets custom override selected on a single-select, and appends it on a multi-select', () => {
    const mapped = mapQuestions(TWO_QUESTIONS)

    const answers = mapAnswers(mapped, {
      answers: [
        { id: 'Which database?', selected: ['Postgres'], custom: 'DuckDB' },
        { id: 'Which extras?', selected: ['Metrics'], custom: 'Profiling' },
      ],
    })

    expect(answers).toEqual({
      'Which database?': 'DuckDB',
      'Which extras?': ['Metrics', 'Profiling'],
    })
  })

  it('OMITS a skipped question (no selection, no custom) — CC has no per-question skip', () => {
    const mapped = mapQuestions(TWO_QUESTIONS)

    const answers = mapAnswers(mapped, {
      answers: [
        { id: 'Which database?', selected: [] },
        { id: 'Which extras?', selected: ['Metrics'] },
      ],
    })

    expect(answers).toEqual({ 'Which extras?': ['Metrics'] })
    expect('Which database?' in answers).toBe(false)
  })

  it('reads positionally but still resolves an out-of-order id rather than misattributing it', () => {
    const mapped = mapQuestions(TWO_QUESTIONS)

    const answers = mapAnswers(mapped, {
      answers: [
        { id: 'Which extras?', selected: ['Tracing'] },
        { id: 'Which database?', selected: ['SQLite'] },
      ],
    })

    expect(answers).toEqual({ 'Which extras?': ['Tracing'], 'Which database?': 'SQLite' })
  })

  it('drops an answer whose id names no question we asked', () => {
    const mapped = mapQuestions(TWO_QUESTIONS)

    expect(mapAnswers(mapped, { answers: [{ id: 'not asked', selected: ['x'] }] })).toEqual({})
  })

  it('routes a suffixed id back onto the original question text', () => {
    const mapped = mapQuestions({
      questions: [
        { question: 'Which one?', options: [{ label: 'a' }] },
        { question: 'Which one?', options: [{ label: 'b' }] },
      ],
    })

    const answers = mapAnswers(mapped, {
      answers: [
        { id: 'Which one?', selected: ['a'] },
        { id: 'Which one? #2', selected: ['b'] },
      ],
    })

    // Both map onto the same CC key; the LAST answer wins, exactly as CC's
    // text-keyed encoding requires.
    expect(answers).toEqual({ 'Which one?': 'b' })
  })
})

describe('ask router: the AskUserQuestion round trip (§4.2)', () => {
  it('passes the original questions back through, unchanged, beside the answers', async () => {
    const { router, questions } = harness()
    questions.answer = {
      answers: [
        { id: 'Which database?', selected: [], custom: 'DuckDB' },
        { id: 'Which extras?', selected: ['Tracing'] },
      ],
    }

    const decision = await router.canUseTool(CC_ASK_USER_QUESTION, TWO_QUESTIONS, makeRequest())

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: TWO_QUESTIONS.questions,
        answers: { 'Which database?': 'DuckDB', 'Which extras?': ['Tracing'] },
      },
    })
    // The exact live agent and the derived signal both reach the seam.
    expect(questions.requests[0]?.agent).toBeDefined()
    expect(questions.requests[0]?.signal).toBeDefined()
  })

  it('applies the fallback policy when the input carries no usable question', async () => {
    const { router, questions } = harness()

    const decision = await router.canUseTool(CC_ASK_USER_QUESTION, { questions: [] }, makeRequest())

    expect(questions.requests).toHaveLength(0)
    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('EMPTY_QUESTIONS') as unknown as string,
    })
  })
})

describe('ask router: plan review (§4.3, delta D5)', () => {
  /** The `ExitPlanMode` input CC actually sends (delta S3, live-probed). */
  const PLAN_INPUT = { plan: '# Plan\n\nDo the thing.', planFilePath: '/tmp/plan.md' }

  it('asks dsh\'s own plan-review question, with the plan as detail', async () => {
    const { router, questions } = harness()
    questions.answer = { answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] }

    await router.canUseTool(CC_EXIT_PLAN_MODE, PLAN_INPUT, makeRequest())

    expect(questions.requests[0]?.questions[0]).toEqual({
      id: CC_PLAN_REVIEW_ID,
      header: 'Plan review',
      question: 'Approve this plan?',
      detail: '# Plan\n\nDo the thing.',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    })
  })

  it('approves ONLY on exactly one plan-review item selecting Approve with no custom text', async () => {
    const { router, questions } = harness()
    questions.answer = { answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] }

    expect(await router.canUseTool(CC_EXIT_PLAN_MODE, PLAN_INPUT, makeRequest()))
      .toEqual({ behavior: 'allow', updatedInput: PLAN_INPUT })
  })

  it.each([
    ['a second answer item for the same id', {
      answers: [
        { id: CC_PLAN_REVIEW_ID, selected: ['Approve'] },
        { id: CC_PLAN_REVIEW_ID, selected: ['Approve'] },
      ],
    }],
    ['Approve alongside custom text', {
      answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'], custom: 'but rename it' }],
    }],
    ['two selections', {
      answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve', 'Keep planning'] }],
    }],
    ['an answer for a different question', {
      answers: [{ id: 'something else', selected: ['Approve'] }],
    }],
  ])('does not approve on %s', async (_name, answer) => {
    const { router, questions } = harness()
    questions.answer = answer

    const decision = await router.canUseTool(CC_EXIT_PLAN_MODE, PLAN_INPUT, makeRequest())

    expect(decision.behavior).toBe('deny')
  })

  it('returns the user\'s custom text as the deny message so Claude can revise', async () => {
    const { router, questions } = harness()
    questions.answer = {
      answers: [{ id: CC_PLAN_REVIEW_ID, selected: [], custom: 'Split step 2 in half.' }],
    }

    expect(await router.canUseTool(CC_EXIT_PLAN_MODE, PLAN_INPUT, makeRequest())).toEqual({
      behavior: 'deny',
      message: 'The user chose to keep planning; their feedback: Split step 2 in half.',
    })
  })

  it('falls back to a generic keep-planning message when the user typed nothing', async () => {
    const { router, questions } = harness()
    questions.answer = { answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Keep planning'] }] }

    expect(await router.canUseTool(CC_EXIT_PLAN_MODE, PLAN_INPUT, makeRequest())).toEqual({
      behavior: 'deny',
      message: 'The user chose to keep planning; revise the plan and present it again.',
    })
  })

  it('treats ASK_CANCELLED as dismissed, not declined', async () => {
    const { router, questions } = harness()
    questions.throws = new FakeUserQuestionError('ASK_CANCELLED')

    expect(await router.canUseTool(CC_EXIT_PLAN_MODE, PLAN_INPUT, makeRequest())).toEqual({
      behavior: 'deny',
      message: 'Plan review dismissed: the user closed the review to speak instead. '
        + 'Stay in plan mode, stop here, and wait for their message.',
    })
  })

  it('reads planFilePath when the inline plan is absent (documented probe order)', async () => {
    const read: string[] = []
    const { router, questions } = harness({
      deps: {
        readPlanFile: (path: string) => {
          read.push(path)
          return '# From the file'
        },
      },
    })
    questions.answer = { answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] }

    await router.canUseTool(CC_EXIT_PLAN_MODE, { planFilePath: '/tmp/plan.md' }, makeRequest())

    expect(read).toEqual(['/tmp/plan.md'])
    expect(questions.requests[0]?.questions[0]?.detail).toBe('# From the file')
  })

  it('ignores a non-string plan and falls through to the plan file (never "[object Object]")', async () => {
    const { router, questions } = harness({ deps: { readPlanFile: () => '# From the file' } })
    questions.answer = { answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] }

    // `plan` is untyped in the SDK's .d.ts (delta S3). A human must never be
    // asked to approve a stringified object.
    await router.canUseTool(
      CC_EXIT_PLAN_MODE, { plan: { steps: [] }, planFilePath: '/tmp/plan.md' }, makeRequest())

    expect(questions.requests[0]?.questions[0]?.detail).toBe('# From the file')
  })

  it('omits detail when neither probe finds a plan, so ask() rejects BAD_INTENT (propagated to the fallback)', async () => {
    const { router, questions } = harness({ deps: { readPlanFile: () => undefined } })
    questions.throws = new FakeUserQuestionError('BAD_INTENT', 'declares intent plan-review without the detail it reviews')

    const decision = await router.canUseTool(CC_EXIT_PLAN_MODE, {}, makeRequest())

    expect(questions.requests[0]?.questions[0]).not.toHaveProperty('detail')
    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('BAD_INTENT') as unknown as string,
    })
  })
})
