import { describe, expect, it } from 'vitest'

/**
 * Plugin-shape guards. Post-mortem 0001 ("`export default` drops the plugin's
 * `inject`") crashed production with 100% line coverage, because no test
 * exercised the module the way the cordis Loader loads it. These tests do.
 * Copied verbatim (per docs/phase1-api-contract.md's testing conventions)
 * from `packages/claude-code/tests/exports.spec.ts`.
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
  'CC_AGENT_PROVIDER',
  'ClaudeCodeAgent',
  'ClaudeCodeAgentService',
  'Config',
  'DEFAULT_DISPOSE_DRAIN_MS',
  'INERT_DSH_MECHANISMS',
  'MOUNT_MARKER',
  'UNMOUNT_MARKER',
  'apply',
  'createClaudeCodeAgent',
  'extractMessageText',
  'inject',
  'name',
  'resolveCcAgentConfig',
].sort()

describe('package entry shape', () => {
  it('has no default export', async () => {
    const mod = await import('@deepseek-ai/dsh-claude-code-agent')
    expect('default' in mod).toBe(false)
  })

  it('survives the Loader unwrap with its namespace intact', async () => {
    const mod = await import('@deepseek-ai/dsh-claude-code-agent')
    const unwrapped = unwrapExports(mod) as Record<string, unknown>
    // With a default export present this would be that single value, and the
    // sibling name/inject/Config exports would be gone.
    expect(unwrapped.name).toBe('claude-code-agent')
    expect(unwrapped.inject).toEqual(['agents', 'claudeCode', 'sessions'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeTypeOf('function')
  })

  it('exports exactly the pinned runtime surface', async () => {
    const mod = await import('@deepseek-ai/dsh-claude-code-agent')
    expect(Object.keys(mod).sort()).toEqual(RUNTIME_EXPORTS)
  })
})
