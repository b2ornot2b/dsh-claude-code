import { tmpdir } from 'node:os'

import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { apply, INERT_DSH_MECHANISMS } from '@deepseek-ai/dsh-claude-code-agent'

import { mountSeam } from './fake-seam.ts'
import type { MountedSeam } from './fake-seam.ts'

/**
 * §7.1 is a documentation contract, and this file is what keeps it true.
 *
 * `agent/pre-step`, `agent/request` and `agent/request-error` are dispatched
 * ONLY from `ReactLoopAgent`'s loop around `ctx.llm.stream()`, and `tools/*`
 * only through `ctx.tools` — a CC-backed agent runs neither (review finding
 * D8). The README says so, and the honest consequence is that this package
 * must not register a listener for any of them: a listener here would let a
 * plugin author conclude the hook works, when the thing it hooks never happens.
 *
 * So the assertion is deliberately about ABSENCE, and it is measured as a
 * DELTA around mounting and spawning — a baseline count means an unrelated
 * future listener in the mounted composition cannot mask a regression here.
 */

let mounted: MountedSeam | undefined

afterEach(async () => {
  await mounted?.dispose()
  mounted = undefined
})

/**
 * Count the registered listeners for each inert mechanism.
 * @param ctx - the context whose event bus to read.
 * @returns one count per mechanism name.
 */
function inertListenerCounts(ctx: Context): Record<string, number> {
  const hooks = ctx.events._hooks
  return Object.fromEntries(INERT_DSH_MECHANISMS.map(name => [name, hooks[name]?.length ?? 0]))
}

describe('§7.1: the adapter registers no listener for an inert mechanism', () => {
  it('adds none when the plugin mounts, and none when it spawns an agent', async () => {
    mounted = await mountSeam()
    const ctx = mounted.ctx
    const before = inertListenerCounts(ctx)
    expect(before).toEqual({
      'agent/pre-step': 0,
      'agent/request': 0,
      'agent/request-error': 0,
      'tools/pre-execute': 0,
    })

    function mountAdapter(inner: Context): void {
      apply(inner)
    }
    const fiber = await ctx.plugin(mountAdapter)
    expect(inertListenerCounts(ctx)).toEqual(before)

    const handle = await ctx.claudeCodeAgents.spawn({ cwd: tmpdir() }, { disposeDrainMs: 20 })
    expect(inertListenerCounts(ctx)).toEqual(before)

    // Not even on the agent's own scoped context, which is where a listener
    // would be most tempting to hide (and would still be dead).
    expect(inertListenerCounts(handle.agent.ctx)).toEqual(before)

    await handle.dispose()
    await fiber.dispose()
  })

  it('names exactly the four mechanisms the README documents substitutes for', () => {
    expect([...INERT_DSH_MECHANISMS]).toEqual([
      'agent/pre-step',
      'agent/request',
      'agent/request-error',
      'tools/pre-execute',
    ])
  })
})

describe('ctx.claudeCodeAgents', () => {
  it('tracks the agents it spawned and forgets them on dispose', async () => {
    mounted = await mountSeam()
    const ctx = mounted.ctx
    function mountAdapter(inner: Context): void {
      apply(inner, { defaults: { cwd: tmpdir() } })
    }
    const fiber = await ctx.plugin(mountAdapter)

    // `cwd` comes from the configured default.
    const handle = await ctx.claudeCodeAgents.spawn({}, { disposeDrainMs: 20 })
    expect(ctx.claudeCodeAgents.list()).toHaveLength(1)
    expect(ctx.claudeCodeAgents.get(handle.agent.id)).toBe(handle.agent)

    await handle.dispose()
    expect(ctx.claudeCodeAgents.list()).toEqual([])
    expect(ctx.claudeCodeAgents.get(handle.agent.id)).toBeUndefined()
    await fiber.dispose()
  })

  it('fails with INVALID_CWD when neither the call nor the config names one', async () => {
    mounted = await mountSeam()
    const ctx = mounted.ctx
    function mountAdapter(inner: Context): void {
      apply(inner)
    }
    const fiber = await ctx.plugin(mountAdapter)

    await expect(ctx.claudeCodeAgents.spawn({}))
      .rejects.toMatchObject({ name: 'ClaudeCodeError', code: 'INVALID_CWD' })

    await fiber.dispose()
  })

  it('unmounting the plugin removes the service and tears its agents down', async () => {
    mounted = await mountSeam()
    const ctx = mounted.ctx
    function mountAdapter(inner: Context): void {
      apply(inner, { defaults: { cwd: tmpdir() } })
    }
    const fiber = await ctx.plugin(mountAdapter)
    const handle = await ctx.claudeCodeAgents.spawn({}, { disposeDrainMs: 20 })
    const id = handle.agent.id

    await fiber.dispose()

    // Compared as a BOOLEAN, never handed to the matcher: cordis 4 returns a
    // traceable proxy per service access and an assert formatter that touches
    // one throws `cannot get property "$$typeof" without inject`.
    expect(ctx.get('claudeCodeAgents') === undefined, 'ctx.claudeCodeAgents should be gone').toBe(true)
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(ctx.claudeCode.list()).toEqual([])
  })
})
