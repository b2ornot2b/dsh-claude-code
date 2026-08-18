/**
 * Stage 2, spec 1: spawn a CC-backed agent the way the dsh UI would
 * (`ctx.claudeCodeAgents.spawn()`), drive it with an ordinary followup that
 * needs approval, and check every seam a human-facing consumer of `ctx.agents`
 * would rely on:
 *
 * - `ctx.agents.get(id)` returns the spawned agent, and it is a registry ROOT
 *   (`ctx.agents.roots()` contains it) — `register()` records no owner.
 * - The approval flow routes through the AGENT'S OWN identity: the scripted
 *   answerer sees `request.agent === handle.agent`.
 * - The audit pair (`approval/asked` → `approval/decided`) lands in the
 *   AGENT'S OWN session log — the same log the mirror writes the tool
 *   call/result into (§7's "agent's session doubles as the mirrored session"
 *   convention) — and the two interleave coherently, `hasOpenTurn` false once
 *   idle.
 * - The file the approved Bash call was asked to create actually exists.
 * - `whenIdle()` resolves.
 * - `status` transitions `idle` -> `running` -> `idle`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import {
  hasOpenTurn, LIVE, LIVE_TIMEOUT_MS, mountLiveAgent, recordStatusSequence, removeCwd, scriptApproval, tmpCwd,
  waitForAgentStatus,
} from './helpers.ts'

describe.skipIf(!LIVE)('ClaudeCodeAgent live: basic followup + approval (DSH_CC_LIVE=1)', () => {
  it(
    'agents.get/roots see it, approval routes through the agent, audit + mirror interleave, file lands, whenIdle resolves',
    async () => {
      const harness = await mountLiveAgent()
      const { ctx } = harness
      const cwd = tmpCwd('agent-basic')
      try {
        const scripted = scriptApproval(ctx, 'allowed-once')
        const handle = await harness.spawn({ cwd })
        const { agent } = handle

        expect(ctx.agents.get(agent.id)).toBe(agent)
        expect(ctx.agents.roots().map(root => root.id)).toContain(agent.id)
        expect(agent.status).toBe('idle')

        const status = recordStatusSequence(agent)

        const target = join(cwd, 'agent-basic.txt')
        agent.followup(createUserMessage({
          content: [{
            type: 'text',
            text: `Use the Bash tool to run exactly: touch ${target}\n`
              + 'Do it directly, do not ask me first. Then reply with one short sentence confirming it ran.',
          }],
          source: { kind: 'user' },
        }))

        await waitForAgentStatus(agent, 'running', LIVE_TIMEOUT_MS)
        await agent.whenIdle()
        status.stop()

        expect(existsSync(target)).toBe(true)
        expect(scripted.requests.length).toBeGreaterThanOrEqual(1)
        // The scripted answerer saw the request routed through the AGENT'S OWN
        // identity — the exact live instance `ctx.agents.get()` returns.
        expect(scripted.requests[0]?.agent).toBe(agent)

        // The audit pair lands in the agent's own session log, the same log
        // the mirror writes tool call/result into.
        const types = agent.session.events.map(event => event.type)
        expect(types).toContain('approval/asked')
        expect(types).toContain('approval/decided')
        expect(types).toContain('tool/call')
        expect(types).toContain('tool/result')

        const askedIndex = types.indexOf('approval/asked')
        const decidedIndex = types.indexOf('approval/decided')
        const callIndex = types.indexOf('tool/call')
        const resultIndex = types.indexOf('tool/result')
        // Coherent interleaving: asked before decided, call before result,
        // and the ask brackets the call it is deciding (approval precedes the
        // tool actually executing, whose result follows).
        expect(askedIndex).toBeLessThan(decidedIndex)
        expect(callIndex).toBeLessThan(resultIndex)
        expect(decidedIndex).toBeLessThanOrEqual(resultIndex)

        expect(hasOpenTurn(agent.session)).toBe(false)
        expect(agent.status).toBe('idle')

        // idle -> running -> idle, at minimum (extra idle/running blips from
        // polling granularity are fine; the key transitions must be present).
        expect(status.sequence[0]).toBe('idle')
        expect(status.sequence).toContain('running')
        expect(status.sequence[status.sequence.length - 1]).toBe('idle')
      } finally {
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
