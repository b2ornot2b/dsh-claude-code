import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

/**
 * Plugin-shape guards. Post-mortem 0001 ("`export default` drops the plugin's
 * `inject`") crashed production with 100% line coverage, because no test
 * exercised the module the way the cordis Loader loads it. These tests do.
 */

/** Verbatim copy of `Loader.unwrapExports` (cordis-plugin-loader lib/index.js). */
function unwrapExports(exports: unknown): unknown {
  if (exports === null || exports === undefined) return exports
  const first = (exports as { default?: unknown }).default ?? exports
  if (!(first as { __esModule?: boolean }).__esModule) return first
  return (first as { default?: unknown }).default ?? first
}

/** Every runtime (value) export of the package entry, pinned by docs/phase1-api-contract.md. */
const RUNTIME_EXPORTS = [
  'ASK_FALLBACKS',
  'CC_AUTH_MODES',
  'CC_PERMISSION_MODES',
  'CC_SESSION_STATUSES',
  'CC_SETTING_SOURCES',
  'CcSession',
  'ClaudeCodeError',
  'ClaudeCodeService',
  'Config',
  'DEFAULT_API_KEY_REF',
  'DEFAULT_DELEGATED_ASK_TIMEOUT_MS',
  'DEFAULT_MAX_CONCURRENT_SESSIONS',
  'WarmPool',
  'apply',
  'buildSessionEnv',
  'createInputStream',
  'inject',
  'isCcSessionId',
  'name',
  'newCcSessionId',
  'realBackend',
  'resolveClaudeCodeConfig',
  'resolveQueryOptions',
  'warmFingerprint',
].sort()

describe('package entry shape', () => {
  it('has no default export', async () => {
    const mod = await import('@deepseek-ai/dsh-claude-code')
    expect('default' in mod).toBe(false)
  })

  it('survives the Loader unwrap with its namespace intact', async () => {
    const mod = await import('@deepseek-ai/dsh-claude-code')
    const unwrapped = unwrapExports(mod) as Record<string, unknown>
    // With a default export present this would be that single value, and the
    // sibling name/inject/Config exports would be gone.
    expect(unwrapped.name).toBe('claude-code')
    expect(unwrapped.inject).toEqual([])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeTypeOf('function')
  })

  it('exports exactly the pinned runtime surface', async () => {
    const mod = await import('@deepseek-ai/dsh-claude-code')
    expect(Object.keys(mod).sort()).toEqual(RUNTIME_EXPORTS)
  })

  it('mounts through the unwrapped namespace and provides ctx.claudeCode', async () => {
    const ctx = new Context()
    const mod = await import('@deepseek-ai/dsh-claude-code')
    const plugin = unwrapExports(mod) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(plugin, { prewarm: false })
    try {
      const service = ctx.get('claudeCode')
      expect(service).toBeDefined()
      expect(service?.config.prewarm).toBe(false)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})
