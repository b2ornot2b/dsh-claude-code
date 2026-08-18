/**
 * Stage 2, spec 6: HMR — dispose the PLUGIN fiber directly (never the
 * per-agent handle) while an agent is mid-turn. This is the registry-level
 * teardown path: `ClaudeCodeAgentService`'s constructor captures the MOUNT
 * context precisely so this path tears the agent down too (the defect Stage 1
 * found and fixed: a cordis `Service`'s traced `this.ctx` has a fiber that is
 * NOT the mounting plugin's, so an agent registered through it would survive
 * the plugin unload that was supposed to kill it).
 *
 * Same guarantees as `agent-dispose.live.spec.ts`, but driven from the OTHER
 * end of the teardown chain: `ctx.claudeCodeAgents` itself disappears with
 * the plugin fiber, and the agent it owned goes with it — subprocess gone,
 * registry entry gone, turn closed as aborted/disposed.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import {
  countSessionProcesses, LIVE, LIVE_TIMEOUT_MS, mountLiveAgent, removeCwd, tmpCwd, waitForAgentStatus,
  waitForSessionProcessCount,
} from './helpers.ts'

describe.skipIf(!LIVE)('ClaudeCodeAgent live: HMR — plugin fiber unload with a live agent running (DSH_CC_LIVE=1)', () => {
  it(
    'disposing the plugin fiber (not the agent handle) tears the live agent down too',
    async () => {
      const harness = await mountLiveAgent()
      const { ctx } = harness
      const cwd = tmpCwd('agent-hmr')
      try {
        const handle = await harness.spawn({ cwd })
        const { agent } = handle
        const id = agent.id

        agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'Count from 1 to 500, one number per line, then say DONE.' }],
          source: { kind: 'user' },
        }))
        await waitForAgentStatus(agent, 'running', LIVE_TIMEOUT_MS)
        expect(await countSessionProcesses(id)).toBe(1)
        expect(ctx.get('claudeCodeAgents')).toBeDefined()

        // The registry-level teardown path: dispose ONLY the adapter plugin's
        // OWN fiber — never the agent's handle, never the whole composition.
        // `ctx.agents`, `ctx.sessions` and `ctx.claudeCode` all stay mounted,
        // exactly as a real plugin unload/reload would leave them; this is
        // what proves `ClaudeCodeAgentService` captures the MOUNT context
        // (not cordis's traced `this.ctx`) for the agents it spawns.
        await harness.pluginFiber.dispose()

        // `ctx.claudeCodeAgents` is gone with its fiber…
        expect(ctx.get('claudeCodeAgents')).toBeUndefined()
        // …but the registry itself, and every other seam, is still mounted.
        expect(ctx.get('agents')).toBeDefined()
        expect(ctx.get('sessions')).toBeDefined()
        expect(ctx.get('claudeCode')).toBeDefined()
        // The agent the plugin owned went with IT, not with the registry.
        expect(ctx.agents.get(id)).toBeUndefined()

        // Same real-vs-fake nuance `agent-dispose.live.spec.ts` documents:
        // `interrupt()` carries no cause passthrough, so a running turn the
        // agent-driven interrupt actually stopped in time is mirrored as
        // `{ kind: 'user' }`; only a turn `finalize()` had to close as truly
        // dangling (the subprocess never got to answer) reads `{ kind:
        // 'disposed' }`. Either way, no turn is left open.
        const end = agent.session.events.findLast(event => event.type === 'turn/end')
        expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('aborted')
        const abortedReason = end?.type === 'turn/end' && end.data.reason.kind === 'aborted'
          ? end.data.reason.reason.kind
          : undefined
        expect(['user', 'disposed']).toContain(abortedReason)

        expect(await waitForSessionProcessCount(id, 0, 15_000)).toBe(0)
      } finally {
        // The rest of the composition (`ctx.agents`, `ctx.sessions`,
        // `ctx.claudeCode`) is still live after the plugin-only teardown
        // above; tear it down too. Re-disposing the already-disposed adapter
        // fiber along the way is a documented single-shot no-op.
        await harness.dispose()
        removeCwd(cwd)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
