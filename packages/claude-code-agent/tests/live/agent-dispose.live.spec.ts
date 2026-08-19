/**
 * Stage 2, spec 5: dispose a spawned agent MID-TURN through the composite
 * disposer `ctx.claudeCodeAgents.spawn()` hands back, and check every
 * teardown guarantee `createClaudeCodeAgent`'s doc promises:
 *
 * - any pending ask settles (nothing here has one open, so this is implicit
 *   in disposal simply resolving rather than hanging).
 * - the mirror's `finalize()` closes the dangling turn as aborted/disposed.
 * - the subprocess is actually gone (a session-scoped `pgrep` check).
 * - `ctx.agents.get(id)` is undefined afterwards.
 * - the session log accepts a fresh append afterwards (Phase 3's finalize
 *   guarantee: a properly closed turn leaves no dangling nesting state).
 * - a SECOND spawn+dispose in the SAME composition works too — no singleton
 *   residue from the first agent's teardown.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import {
  countSessionProcesses, LIVE, LIVE_TIMEOUT_MS, mountLiveAgent, removeCwd, tmpCwd, waitForAgentStatus,
  waitForSessionProcessCount,
} from './helpers.ts'

/**
 * Spawn one agent, start a long-running turn, and dispose it mid-turn, then
 * check every teardown guarantee.
 * @param harness - the live agent harness (composition shared across both spawns in the test).
 * @param label - a distinct tmp-cwd label so the two spawns in one test never collide.
 */
async function spawnRunDisposeAndCheck(
  harness: Awaited<ReturnType<typeof mountLiveAgent>>,
  label: string,
): Promise<void> {
  const { ctx } = harness
  const cwd = tmpCwd(label)
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

    await handle.dispose()

    // The dangling turn was closed as aborted — either by the mirror's own
    // `turnEndReason` for the interrupt `drain()` actually delivered (mirrored
    // as `{ kind: 'user' }`: `CcAgentSession.interrupt()` carries no cause
    // passthrough, so every agent-driven interrupt reads this way regardless
    // of `cancel()`'s own `AgentCancelCause`), or — only if the subprocess
    // never got to answer that interrupt at all — by `finalize()`'s own
    // dangling-turn fallback, mirrored as `{ kind: 'disposed' }` (what the
    // offline fake-seam suite exercises, since its fake interrupt never
    // settles a turn on its own). Both are the same guarantee: no turn is
    // left open across disposal.
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data.reason.kind : undefined).toBe('aborted')
    const abortedReason = end?.type === 'turn/end' && end.data.reason.kind === 'aborted'
      ? end.data.reason.reason.kind
      : undefined
    expect(['user', 'disposed']).toContain(abortedReason)

    // The subprocess is actually gone (session-scoped, parallel-safe check).
    expect(await waitForSessionProcessCount(id, 0, 15_000)).toBe(0)

    // No longer a live registered agent.
    expect(ctx.agents.get(id)).toBeUndefined()

    // The session log accepts a fresh append afterwards — the properly closed
    // turn left no dangling nesting state for the surface manager to refuse.
    const lastStart = agent.session.events.findLast(event => event.type === 'turn/start')
    const nextTurn = (lastStart?.type === 'turn/start' ? lastStart.data.turn : 0) + 1
    expect(() => { agent.session.append('turn/start', { turn: nextTurn }) }).not.toThrow()
  } finally {
    removeCwd(cwd)
  }
}

describe.skipIf(!LIVE)('ClaudeCodeAgent live: dispose mid-turn (DSH_CC_LIVE=1)', () => {
  it(
    'closes the dangling turn, kills the subprocess, drops the registry entry, and the log still accepts appends; a second spawn+dispose in the same composition works too',
    async () => {
      const harness = await mountLiveAgent()
      try {
        await spawnRunDisposeAndCheck(harness, 'agent-dispose-1')
        // No singleton residue: a second agent, in the SAME composition, goes
        // through the exact same spawn -> run -> dispose lifecycle cleanly.
        await spawnRunDisposeAndCheck(harness, 'agent-dispose-2')
      } finally {
        await harness.dispose()
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
