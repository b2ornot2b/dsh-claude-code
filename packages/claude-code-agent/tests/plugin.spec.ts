import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { apply, Config, inject, MOUNT_MARKER, name, UNMOUNT_MARKER } from '@deepseek-ai/dsh-claude-code-agent'

/**
 * Provide bare stubs for the two services this plugin injects, without
 * pulling in the real `dsh-agent` / `dsh-claude-code` packages — Phase 1
 * only needs their names present at mount, never their behavior.
 */
function stubServices(ctx: Context): void {
  ctx.reflect.provide('agents', {} as never)
  ctx.reflect.provide('claudeCode', {} as never)
}

describe('claude-code-agent plugin shape', () => {
  it('declares the documented name, inject list, and config schema', () => {
    expect(name).toBe('claude-code-agent')
    expect(inject).toEqual(['agents', 'claudeCode'])
    expect(Config).toBeTypeOf('function')
    // Phase 1's schema accepts only an empty config.
    expect(Config({})).toEqual({})
  })

  it('mounts and disposes cleanly in a bare Context with stub agents/claudeCode present', async () => {
    const ctx = new Context()
    await ctx.plugin(stubServices)

    // Mounted with a named function declaration per workspace convention
    // (`Object.assign(fn, { name })` throws — `name` is not writable).
    function mountForTest(inner: Context): void {
      apply(inner)
    }
    const fiber = await ctx.plugin(mountForTest)

    // Read the built-in logger's buffering exporter rather than spying on
    // `ctx.logger` directly: cordis 4 hands out a fresh traceable proxy per
    // access, so a spy attached to one access would never see a call made
    // through a later, different access (never identity-compare cordis
    // services/contexts). Reading `.buffer` off a single access is fine —
    // it is a plain data read, not an identity comparison.
    const mountMessages = ctx.logger.buffer.filter((m) => m.args.includes(MOUNT_MARKER))
    expect(mountMessages.length).toBeGreaterThan(0)

    await fiber.dispose()

    const unmountMessages = ctx.logger.buffer.filter((m) => m.args.includes(UNMOUNT_MARKER))
    expect(unmountMessages.length).toBeGreaterThan(0)

    // HMR-safety: the plugin provided no service of its own, so there is
    // nothing else to assert absent — the marker effect is the only trace,
    // and it is proven torn down above.
    await ctx.fiber.dispose()
  })
})
