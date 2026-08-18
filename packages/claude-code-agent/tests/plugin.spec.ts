import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import {
  apply, Config, inject, MOUNT_MARKER, name, resolveCcAgentConfig, UNMOUNT_MARKER,
} from '@deepseek-ai/dsh-claude-code-agent'

/**
 * Provide bare stubs for the three services this plugin injects, without
 * pulling in the real `dsh-agent` / `dsh-session` / `dsh-claude-code`
 * packages — mounting only needs their names present.
 */
function stubServices(ctx: Context): void {
  ctx.reflect.provide('agents', {} as never)
  ctx.reflect.provide('claudeCode', {} as never)
  ctx.reflect.provide('sessions', {} as never)
}

describe('claude-code-agent plugin shape', () => {
  it('declares the documented name, inject list, and config schema', () => {
    expect(name).toBe('claude-code-agent')
    // `sessions` is not optional: an Agent needs a real, STORE-ATTACHED dsh
    // Session, or the mirror's appends are published to nobody.
    expect(inject).toEqual(['agents', 'claudeCode', 'sessions'])
    expect(Config).toBeTypeOf('function')
  })

  it('resolves its defaults, and treats an unset value as ABSENT', () => {
    expect(resolveCcAgentConfig()).toEqual({ provider: 'claude-code', defaults: {} })
    expect(resolveCcAgentConfig({ defaults: { cwd: '/workspace/repo' } }))
      .toEqual({ provider: 'claude-code', defaults: { cwd: '/workspace/repo' } })
    expect(resolveCcAgentConfig({ provider: 'cc', defaults: { model: 'm', permissionMode: 'plan' } }))
      .toEqual({ provider: 'cc', defaults: { model: 'm', permissionMode: 'plan' } })
    // `exactOptionalPropertyTypes`: an unset key is missing, never present-and-undefined.
    expect('cwd' in resolveCcAgentConfig().defaults).toBe(false)
  })

  it('rejects a permission mode the seam does not know', () => {
    expect(() => resolveCcAgentConfig({ defaults: { permissionMode: 'yolo' as never } })).toThrow()
  })

  it('mounts and disposes cleanly, providing ctx.claudeCodeAgents', async () => {
    const ctx = new Context()
    await ctx.plugin(stubServices)

    // Mounted with a named function declaration per workspace convention
    // (`Object.assign(fn, { name })` throws — `name` is not writable).
    function mountForTest(inner: Context): void {
      apply(inner)
    }
    const fiber = await ctx.plugin(mountForTest)

    expect(ctx.get('claudeCodeAgents') !== undefined, 'ctx.claudeCodeAgents should resolve').toBe(true)
    expect(ctx.claudeCodeAgents.list()).toEqual([])
    expect(ctx.claudeCodeAgents.config).toEqual({ provider: 'claude-code', defaults: {} })

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
    // HMR-safety: the service is gone with its fiber.
    expect(ctx.get('claudeCodeAgents') === undefined, 'ctx.claudeCodeAgents should be gone').toBe(true)

    await ctx.fiber.dispose()
  })
})
