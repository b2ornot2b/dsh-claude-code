/**
 * Stage 2, spec 4: `agent.cancel()`, driven through the spawned
 * `ClaudeCodeAgent`, for both `keepInbox` defaults — a long-running followup
 * plus two queued followups, cancelled mid-turn.
 *
 * Case (a) `keepInbox: true` (the agent's own default): the interrupt
 * receipt's survivors are exactly the two queued messages; Claude Code then
 * runs them as ONE coalesced next turn (spike 3) and the inbox reconciles
 * them as CLAIMED once that turn commits; `whenIdle()` resolves once it does.
 *
 * Case (b) `keepInbox: false`: the seam's emulated drain marks the two queued
 * messages cancelled; the inbox reconciles them as DISCARDED, they never
 * produce a success turn (checked after a settling grace period, exactly as
 * the seam-level `interrupt-drop-queued.live.spec.ts` does), and `whenIdle()`
 * still resolves once the interrupted turn itself settles.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveAgent, removeCwd, SEND_SETTLE_MS, sleep, tmpCwd, waitForAgentStatus,
} from './helpers.ts'

/** Build one identified followup message. */
function followupMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe.skipIf(!LIVE)('ClaudeCodeAgent live: cancel() and inbox reconciliation (DSH_CC_LIVE=1)', () => {
  it(
    'keepInbox:true — receipt survivors coalesce into one turn, inbox claims them, whenIdle resolves',
    async () => {
      const harness = await mountLiveAgent()
      const { ctx } = harness
      const cwd = tmpCwd('agent-cancel-keep')
      try {
        const claimed: string[] = []
        const discarded: string[] = []
        const offClaimed = ctx.on('agent/inbox/claimed', ({ message }) => {
          const first = message.content[0]
          claimed.push(first?.type === 'text' ? first.text : '')
        })
        const offDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
          const first = message.content[0]
          discarded.push(first?.type === 'text' ? first.text : '')
        })

        const handle = await harness.spawn({ cwd })
        const { agent } = handle
        const cc = harness.service.session(agent.id)
        if (cc === undefined) throw new Error('missing seam session actor')

        agent.followup(followupMessage('Count from 1 to 200, one number per line, then say DONE.'))
        await waitForAgentStatus(agent, 'running', LIVE_TIMEOUT_MS)
        await sleep(1_500)

        agent.followup(followupMessage('Say APPLE.'))
        agent.followup(followupMessage('Say PEAR.'))
        await sleep(SEND_SETTLE_MS)

        // Visible at the seam: two more queued entries beyond whatever the
        // long turn itself queued.
        const beforeCancel = cc.outbox().filter(entry => entry.state === 'queued')
        expect(beforeCancel.length).toBeGreaterThanOrEqual(2)

        agent.cancel({ kind: 'user' }, { keepInbox: true })

        await agent.whenIdle()

        offClaimed()
        offDiscarded()

        // Both queued followups were claimed (the coalesced turn ran them),
        // never discarded.
        expect(claimed).toContain('Say APPLE.')
        expect(claimed).toContain('Say PEAR.')
        expect(discarded).not.toContain('Say APPLE.')
        expect(discarded).not.toContain('Say PEAR.')
        expect(agent.inbox.hasPending).toBe(false)

        const finalStates = cc.outbox().map(entry => entry.state)
        expect(finalStates.every(state => state === 'committed')).toBe(true)
        expect(agent.status).toBe('idle')
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )

  it(
    'keepInbox:false — drain emulation cancels the queued followups; they never produce a success turn',
    async () => {
      const harness = await mountLiveAgent()
      const { ctx } = harness
      const cwd = tmpCwd('agent-cancel-drop')
      try {
        const discarded: string[] = []
        const claimed: string[] = []
        const offDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
          const first = message.content[0]
          discarded.push(first?.type === 'text' ? first.text : '')
        })
        const offClaimed = ctx.on('agent/inbox/claimed', ({ message }) => {
          const first = message.content[0]
          claimed.push(first?.type === 'text' ? first.text : '')
        })

        const handle = await harness.spawn({ cwd })
        const { agent } = handle
        const cc = harness.service.session(agent.id)
        if (cc === undefined) throw new Error('missing seam session actor')

        agent.followup(followupMessage('Count from 1 to 200, one number per line, then say DONE.'))
        await waitForAgentStatus(agent, 'running', LIVE_TIMEOUT_MS)
        await sleep(1_500)

        agent.followup(followupMessage('Say APPLE.'))
        agent.followup(followupMessage('Say PEAR.'))
        await sleep(SEND_SETTLE_MS)

        agent.cancel({ kind: 'user' }, { keepInbox: false })

        await agent.whenIdle()

        offDiscarded()
        offClaimed()

        expect(discarded).toContain('Say APPLE.')
        expect(discarded).toContain('Say PEAR.')
        expect(claimed).not.toContain('Say APPLE.')
        expect(claimed).not.toContain('Say PEAR.')
        expect(agent.inbox.hasPending).toBe(false)

        // The two dropped messages must never later flip to committed — a
        // queued turn "completing as success" after the drain would mean the
        // emulation lied about what it cancelled.
        await sleep(2_000)
        const states = cc.outbox().map(entry => entry.state)
        expect(states.filter(state => state === 'committed').length).toBeLessThanOrEqual(1)
        expect(states.some(state => state === 'cancelled')).toBe(true)
        expect(agent.status).toBe('idle')
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
