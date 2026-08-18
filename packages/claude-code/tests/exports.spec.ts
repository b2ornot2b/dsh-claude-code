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
  'ASK_SESSION_CLOSED_MESSAGE',
  'ASK_WITHDRAWN_MESSAGE',
  'CC_ASK_ERROR_CODES',
  'CC_ASK_USER_QUESTION',
  'CC_AUTH_MODES',
  'CC_CLOSE_REASONS',
  'CC_CANCELLED_MESSAGE',
  'CC_COMPACT_EVENT',
  'CC_EXIT_PLAN_MODE',
  'CC_PENDING_ASK_KINDS',
  'CC_PERMISSION_MODES',
  'CC_PLAN_APPROVE_LABEL',
  'CC_PLAN_DECLINE_LABEL',
  'CC_PLAN_REVIEW_ID',
  'CC_REJECTED_MESSAGE',
  'CC_RULE_CACHE_DIR',
  'CC_RULE_CACHE_FILE',
  'CC_RULE_FILE_VERSION',
  'CC_SESSION_STATUSES',
  'CC_SETTING_SOURCES',
  'INVENTORY_ASK_DETAIL_LIMIT',
  'MAX_IDLE_SWEEP_MS',
  'MIN_IDLE_SWEEP_MS',
  'buildSessionInventory',
  'buildSessionLimitInfo',
  'formatDuration',
  'isReapable',
  'renderSessionLimit',
  'selectReapable',
  'sessionLimitError',
  'sweepIntervalMs',
  'CcAskRouter',
  'CcAskRules',
  'CcAskTable',
  'CcMirror',
  'CcSession',
  'ClaudeCodeError',
  'CLOSED_SESSION_HISTORY',
  'ClaudeCodeService',
  'Config',
  'DEFAULT_API_KEY_REF',
  'DEFAULT_DELEGATED_ASK_TIMEOUT_MS',
  'DEFAULT_MAX_CONCURRENT_SESSIONS',
  'WarmPool',
  'apply',
  'applyAskFallback',
  'askErrorCode',
  'attachMirror',
  'buildSessionEnv',
  'createInputStream',
  'describeCall',
  'describeReason',
  'inject',
  'isCcSessionId',
  'mapAnswers',
  'mapQuestions',
  'markEventIgnorable',
  'name',
  'newCcSessionId',
  'presentCcToolCall',
  'presentCcToolResult',
  'realBackend',
  'resolveClaudeCodeConfig',
  'resolveQueryOptions',
  'resolveRuleCachePath',
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
