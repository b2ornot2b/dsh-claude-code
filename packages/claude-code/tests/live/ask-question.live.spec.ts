/**
 * The ask channel's clarifying-questions path (§4.2), LIVE: a REAL Claude Code
 * subprocess asked to use `AskUserQuestion`, answered by a REAL registered
 * `ctx.userQuestions` provider — through the REAL `CcAskRouter`.
 *
 * Three provider shapes, each a distinct branch of `answerValue` (router.ts):
 *
 * - `selected: ['blue']` — an ordinary single-select pick.
 * - `custom: 'teal'` — free text, which overrides `selected` on single-select.
 * - `selected: []` with no `custom` — a skipped question: dsh permits this,
 *   CC has no per-question skip, so the key is omitted from `answers`
 *   entirely, and the turn must still complete without CC hanging on it.
 */

import { describe, expect, it } from 'vitest'

import {
  disposeLiveWithAsk, LIVE, LIVE_TIMEOUT_MS, mountLiveWithAsk, registerLiveRootAgent, removeCwd, resultText,
  tmpCwd,
} from './helpers.ts'

const PROMPT
  = 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: '
  + '"Red" and "Blue". After you get my answer, reply with one short sentence that repeats the '
  + 'color I chose back to me.'

describe.skipIf(!LIVE)('ask channel — clarifying questions, live (§4.2, DSH_CC_LIVE=1)', () => {
  it(
    'a selected option round-trips into the final answer',
    async () => {
      const cwd = tmpCwd('ask-question-selected')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        const dispose = ctx.userQuestions.registerProvider({
          ask: async request => await Promise.resolve({
            answers: request.questions.map(question => ({
              id: question.id,
              selected: [question.options?.find(option => option.label === 'Blue')?.label ?? 'Blue'],
            })),
          }),
        })

        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(PROMPT)
        const result = await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(resultText(result.message).toLowerCase()).toContain('blue')
        dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'free-text "custom" overrides the selected option (single-select) and reaches the final answer',
    async () => {
      const cwd = tmpCwd('ask-question-custom')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        const dispose = ctx.userQuestions.registerProvider({
          ask: async request => await Promise.resolve({
            answers: request.questions.map(question => ({ id: question.id, selected: [], custom: 'teal' })),
          }),
        })

        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(PROMPT)
        const result = await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(resultText(result.message).toLowerCase()).toContain('teal')
        dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'a skipped question (empty selected, no custom) does not hang the turn — CC proceeds without the answer',
    async () => {
      const cwd = tmpCwd('ask-question-skip')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })
        const dispose = ctx.userQuestions.registerProvider({
          ask: async request => await Promise.resolve({
            answers: request.questions.map(question => ({ id: question.id, selected: [] })),
          }),
        })

        const snap = await service.open({
          cwd,
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(PROMPT)
        // The assertion IS that this resolves at all within budget — a skipped
        // answer must never leave the turn open waiting on something nobody sent.
        const result = await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(session.status).toBe('idle')
        expect(resultText(result.message).length).toBeGreaterThan(0)
        dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
