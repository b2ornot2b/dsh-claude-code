/**
 * The ask channel's plan-review path (§4.3), LIVE: a REAL Claude Code
 * subprocess in `permissionMode: 'plan'` presenting a real `ExitPlanMode` call,
 * answered through the REAL `ctx.userQuestions` with dsh's own `plan-review`
 * intent (`CC_PLAN_REVIEW_ID`, copied verbatim from `@deepseek-ai/dsh-plan-mode`).
 *
 * Scenario (a): approve on the first review. `ExitPlanMode` is allowed, plan
 * mode ends, and the actual file-creation tool call that follows goes through
 * a REAL `ctx.approval` (also scripted to allow) — the file lands on disk.
 *
 * Scenario (b): decline the first review with `custom` revision feedback.
 * `ExitPlanMode` is denied carrying that feedback, Claude revises and presents
 * a SECOND `ExitPlanMode` — asserted to carry a different `detail` than the
 * first — which the provider then approves, and execution proceeds exactly as
 * in (a).
 */

import { readdirSync } from 'node:fs'

import { CC_PLAN_REVIEW_ID } from '@deepseek-ai/dsh-claude-code'
import { describe, expect, it } from 'vitest'

import {
  disposeLiveWithAsk, LIVE, LIVE_TIMEOUT_MS, mountLiveWithAsk, registerLiveRootAgent, removeCwd, tmpCwd,
} from './helpers.ts'
import { scriptApproval } from './ask-live-helpers.ts'

const PLAN_PROMPT
  = 'Make a very short plan (one step) to create a new empty text file in the current directory '
  + 'using the Bash tool, then present the plan for approval. Do not execute anything until the plan '
  + 'is approved.'

describe.skipIf(!LIVE)('ask channel — plan review, live (§4.3, DSH_CC_LIVE=1)', () => {
  it(
    'approves the plan on the first review: ExitPlanMode allowed, then the real file-creation tool call is approved too',
    async () => {
      const cwd = tmpCwd('ask-plan-approve')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })

        const dispose = ctx.userQuestions.registerProvider({
          ask: async (request) => {
            const question = request.questions.find(item => item.id === CC_PLAN_REVIEW_ID)
            if (question === undefined) throw new Error('expected a plan-review question')
            return await Promise.resolve({ answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] })
          },
        })
        scriptApproval(ctx, 'allowed-once')

        const snap = await service.open({
          cwd,
          permissionMode: 'plan',
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(PLAN_PROMPT)
        await session.waitForResult(LIVE_TIMEOUT_MS)

        const exitCalls = root.session.events.filter(
          event => event.type === 'tool/call' && event.data.name === 'ExitPlanMode')
        expect(exitCalls.length).toBeGreaterThanOrEqual(1)

        // The plan was approved and execution proceeded: some file landed in cwd.
        const entries = readdirSync(cwd)
        expect(entries.length).toBeGreaterThan(0)
        dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'declines the first review with feedback, then approves the SECOND (revised) ExitPlanMode call',
    async () => {
      const cwd = tmpCwd('ask-plan-revise')
      const mounted = await mountLiveWithAsk()
      const { ctx, service } = mounted
      try {
        const root = await registerLiveRootAgent(ctx)
        root.session.append('turn/start', { turn: 1 })

        const seenDetails: (string | undefined)[] = []
        let planCalls = 0
        const dispose = ctx.userQuestions.registerProvider({
          ask: async (request) => {
            const question = request.questions.find(item => item.id === CC_PLAN_REVIEW_ID)
            if (question === undefined) throw new Error('expected a plan-review question')
            seenDetails.push(question.detail)
            planCalls += 1
            if (planCalls === 1) {
              return await Promise.resolve({
                answers: [{
                  id: CC_PLAN_REVIEW_ID,
                  selected: [],
                  custom: 'Please use a different approach: name the file "revised-plan.txt" specifically.',
                }],
              })
            }
            return await Promise.resolve({ answers: [{ id: CC_PLAN_REVIEW_ID, selected: ['Approve'] }] })
          },
        })
        scriptApproval(ctx, 'allowed-once')

        const snap = await service.open({
          cwd,
          permissionMode: 'plan',
          ask: { agent: root.agent, delegated: false },
          mirror: { session: root.session },
        })
        const session = service.session(snap.id)
        if (session === undefined) throw new Error('missing session actor')

        session.send(PLAN_PROMPT)
        await session.waitForResult(LIVE_TIMEOUT_MS)

        expect(planCalls).toBeGreaterThanOrEqual(2)
        expect(seenDetails.length).toBeGreaterThanOrEqual(2)
        // The revised plan must be a DIFFERENT presentation than the first —
        // either its text changed outright, or it explicitly reflects the
        // filename the feedback asked for.
        const [first, second] = seenDetails
        const changed = first !== second
          || (second?.toLowerCase().includes('revised-plan') ?? false)
        expect(changed).toBe(true)

        const exitCalls = root.session.events.filter(
          event => event.type === 'tool/call' && event.data.name === 'ExitPlanMode')
        expect(exitCalls.length).toBeGreaterThanOrEqual(2)

        // The revised plan was eventually approved and executed.
        const entries = readdirSync(cwd)
        expect(entries.length).toBeGreaterThan(0)
        dispose()
      } finally {
        await disposeLiveWithAsk(mounted)
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
