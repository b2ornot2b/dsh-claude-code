import { CC_ASK_ERROR_CODES, CC_ASK_USER_QUESTION } from '@deepseek-ai/dsh-claude-code'
import type { ClaudeCodeError } from '@deepseek-ai/dsh-claude-code'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeUserQuestionError, makeRequest, makeRouter } from './ask-helpers.ts'
import type { AskHarness } from './ask-helpers.ts'

/**
 * §4.5: the fallback policy, across the FULL `UserQuestionError` taxonomy
 * (delta D3) — not just the two codes the spec named.
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

/** One `AskUserQuestion` input. */
const QUESTION_INPUT = {
  questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
}

describe('ask fallback: the full UserQuestionError taxonomy (delta D3)', () => {
  it.each(CC_ASK_ERROR_CODES.map(code => [code]))('denies with an explanation on %s', async (code) => {
    const { router, questions } = harness()
    questions.throws = new FakeUserQuestionError(code)

    const decision = await router.canUseTool(CC_ASK_USER_QUESTION, QUESTION_INPUT, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining(code) as unknown as string,
    })
    expect(decision).toMatchObject({
      message: expect.stringContaining('best assumption') as unknown as string,
    })
  })

  it('answers with the first option of every question under first-option, loudly', async () => {
    const { router, questions, logger } = harness({ config: { ask: { fallback: 'first-option' } } })
    questions.throws = new FakeUserQuestionError('DELEGATED_CALLER')

    const decision = await router.canUseTool(CC_ASK_USER_QUESTION, {
      questions: [
        { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] },
        { question: 'Extras?', multiSelect: true, options: [{ label: 'Metrics' }] },
      ],
    }, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Ship it?': 'Yes', 'Extras?': ['Metrics'] } },
    })
    expect(logger.saw('FIRST-OPTION FALLBACK')).toBe(true)
  })

  it('denies under first-option when no question offers an option to pick', async () => {
    const { router, questions, logger } = harness({ config: { ask: { fallback: 'first-option' } } })
    questions.throws = new FakeUserQuestionError('NO_PROVIDER')

    const decision = await router.canUseTool(
      CC_ASK_USER_QUESTION, { questions: [{ question: 'Free text?' }] }, makeRequest())

    expect(decision.behavior).toBe('deny')
    expect(logger.saw('cannot answer')).toBe(true)
  })

  it('denies AND interrupts under the error policy, surfacing a typed ASK_UNANSWERABLE', async () => {
    const { router, questions } = harness({ config: { ask: { fallback: 'error' } } })
    questions.throws = new FakeUserQuestionError('CALLER_NOT_LIVE')
    const seen: ClaudeCodeError[] = []
    router.onError(error => seen.push(error))

    const decision = await router.canUseTool(CC_ASK_USER_QUESTION, QUESTION_INPUT, makeRequest())

    expect(decision).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.code).toBe('ASK_UNANSWERABLE')
    expect(seen[0]?.message).toContain('CALLER_NOT_LIVE')
  })

  it('reports an unrecognized rejection as UNKNOWN rather than swallowing it', async () => {
    const { router, questions } = harness()
    questions.throws = new Error('the provider exploded')

    const decision = await router.canUseTool(CC_ASK_USER_QUESTION, QUESTION_INPUT, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('UNKNOWN') as unknown as string,
    })
  })

  it('falls back when no user-questions service is mounted at all', async () => {
    const { router } = harness({ noQuestions: true })

    const decision = await router.canUseTool(CC_ASK_USER_QUESTION, QUESTION_INPUT, makeRequest())

    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('no user-questions service is mounted') as unknown as string,
    })
  })

  it('never auto-approves a plan review under first-option', async () => {
    const { router, questions, logger } = harness({ config: { ask: { fallback: 'first-option' } } })
    questions.throws = new FakeUserQuestionError('DELEGATED_CALLER')

    const decision = await router.canUseTool('ExitPlanMode', { plan: '# Plan' }, makeRequest())

    expect(decision.behavior).toBe('deny')
    expect(logger.saw('never auto-answered')).toBe(true)
  })
})
