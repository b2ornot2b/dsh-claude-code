/**
 * Stage 2, §12 failure injection, agent-adapter half: SIGKILL a spawned
 * agent's real Claude Code subprocess mid-turn — as opposed to
 * `agent-dispose.live.spec.ts` (a cooperative `dispose()`) — and check the
 * adapter's own carry-forward guarantee (api-contract correction 44): a dead
 * subprocess now closes its OWN seam session, so `ClaudeCodeAgent.status`
 * must reach `'idle'` and `whenIdle()` must resolve without anyone calling
 * `cancel()`/`dispose()` at all.
 *
 * Companion to `packages/claude-code/tests/live/failures.live.spec.ts`
 * (the seam-level half of the same failure) and
 * `packages/tool-claude-code/tests/live/tools-background-kill.live.spec.ts`
 * (the background-job half).
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { describe, expect, it } from 'vitest'

import {
  captureUnhandledRejections, killSessionProcess,
} from '../../../claude-code/tests/live/helpers.ts'
import {
  LIVE, LIVE_TIMEOUT_MS, mountLiveAgent, waitForAgentStatus, waitForSessionProcessCount,
  waitUntil,
} from './helpers.ts'

describe.skipIf(!LIVE)('ClaudeCodeAgent live: subprocess killed mid-turn (§12, DSH_CC_LIVE=1)', () => {
  it(
    'reaches status idle and whenIdle() resolves on its own, with no dispose() or cancel() call',
    async () => {
      const guard = captureUnhandledRejections()
      const harness = await mountLiveAgent()
      try {
        const handle = await harness.spawn()
        const { agent } = handle
        const id = agent.id

        agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'Count from 1 to 500, one number per line, then say DONE.' }],
          source: { kind: 'user' },
        }))
        await waitForAgentStatus(agent, 'running', LIVE_TIMEOUT_MS)
        expect(await waitForSessionProcessCount(id, 1, 15_000)).toBe(1)

        const idlePromise = agent.whenIdle()

        const killed = await killSessionProcess(id)
        expect(killed).toBeGreaterThan(0)

        // No cancel(), no dispose() — the ONLY thing that happened is the
        // subprocess dying. If the Phase 6 carry-forward were still open, this
        // would hang here forever (status stuck at `running`).
        await idlePromise
        expect(agent.status).toBe('idle')
        expect(await waitForAgentStatus(agent, 'idle', 5_000)).toBe('idle')

        // The dangling turn closed as aborted; the log is still appendable
        // (the same guarantee `agent-dispose.live.spec.ts` checks after a
        // cooperative dispose, now checked after an uncooperative death).
        const end = agent.session.events.findLast(event => event.type === 'turn/end')
        expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('aborted')
        const lastStart = agent.session.events.findLast(event => event.type === 'turn/start')
        const nextTurn = (lastStart?.type === 'turn/start' ? lastStart.data.turn : 0) + 1
        expect(() => { agent.session.append('turn/start', { turn: nextTurn }) }).not.toThrow()

        expect(await waitForSessionProcessCount(id, 0, 15_000)).toBe(0)

        // The registry still resolves the agent (it is not disposed, only
        // idle) — `whenIdle()` a second time resolves immediately.
        await waitUntil(() => harness.ctx.agents.get(id) !== undefined, ok => ok, 2_000, 50)
        expect(harness.ctx.agents.get(id)).toBeDefined()
        await agent.whenIdle()

        await handle.dispose()
      } finally {
        await harness.dispose()
        guard.stop()
      }
      expect(guard.reasons).toEqual([])
    },
    LIVE_TIMEOUT_MS,
  )
})
