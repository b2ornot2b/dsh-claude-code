/**
 * Agent-adapter consumer for the DeepSeek Harness: plans to publish a
 * `ctx.agents` entry backed by a live Claude Code session, so a CC session is
 * a first-class citizen a human can talk to in the dsh UI (spec §7). Ships
 * LAST — Phase 6 implements it.
 *
 * This Phase 1 scaffold: validates its (currently empty) configuration, logs
 * a mount marker with clean teardown, and exports the fully-typed
 * {@link createClaudeCodeAgent} contract Phase 6 fills in. It registers
 * NOTHING with `ctx.agents` yet — see the README's "Known Limitations"
 * section.
 *
 * NAMED EXPORTS ONLY. A `default` export here would make the cordis Loader
 * unwrap the module to that single value and silently discard the sibling
 * `name`/`inject`/`Config` exports, mounting the plugin with an empty inject
 * list (harness post-mortem 0001, "export default drops the plugin's
 * inject"). `tests/exports.spec.ts` asserts the absence of a default export.
 *
 * @module @deepseek-ai/dsh-claude-code-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

import { ClaudeCodeError, newCcSessionId } from '@deepseek-ai/dsh-claude-code'

import type { CcAgentConfig, CcAgentOptions } from './types.ts'

export { INERT_DSH_MECHANISMS } from './types.ts'
export type { CcAgentConfig, CcAgentOptions, InertDshMechanism } from './types.ts'

/** Plugin name shown in Loader diagnostics and cordis fiber trees. */
export const name = 'claude-code-agent'

/**
 * Services this plugin requires before it activates: the dsh agent registry
 * (what it will eventually publish into) and the Claude Code seam (what it
 * adapts). Declaring both in `inject` means cordis refuses to mount this
 * plugin in a composition missing either — a clean startup failure rather
 * than a `createClaudeCodeAgent()` call failing for a surprising reason.
 */
export const inject: string[] = ['agents', 'claudeCode']

/**
 * Runtime validation schema for {@link CcAgentConfig}. Empty in Phase 1: every
 * session policy this adapter needs already lives on `ctx.claudeCode.config`.
 */
export const Config: z<CcAgentConfig> = z.object({})

/** Logged via `ctx.logger.info` when the plugin mounts; asserted by tests, not meant for parsing. */
export const MOUNT_MARKER = 'claude-code-agent: mounted (Phase 1 scaffold; registers nothing with ctx.agents yet)'

/** Logged via `ctx.logger.info` when the plugin's fiber disposes. */
export const UNMOUNT_MARKER = 'claude-code-agent: unmounted'

/**
 * Mount the adapter scaffold. Named export, never a default — see the module
 * doc comment.
 * @param ctx - the context this plugin mounts into; `inject` guarantees
 *   `ctx.agents` and `ctx.claudeCode` are already present.
 * @param config - surface configuration from the `cordis.yml` row; Phase 1
 *   has nothing to resolve, but the value still runs through {@link Config}
 *   (schemastery validates *declared* fields; it does not reject unrecognized
 *   ones — same non-strict-by-default behavior as the seam's own `Config`).
 */
export function apply(ctx: Context, config: CcAgentConfig = {}): void {
  // Run the (currently field-less) schema now rather than only in Phase 6, so
  // a hand-mounted plugin and a `cordis.yml` row are validated identically
  // from day one, matching the seam's `resolveClaudeCodeConfig` convention.
  Config(config)

  // A visible, disposable marker rather than a side effect that outlives the
  // fiber — HMR (unload/reload this plugin) must leave no trace behind.
  // `ctx.logger` is a cordis built-in (always present, no `inject` entry
  // needed), so this works even in a bare test Context. `.info` (not
  // `.debug`): the built-in buffering exporter's default level threshold
  // drops `debug` messages, and a mount marker should be visible by default.
  ctx.effect(() => {
    ctx.logger.info(MOUNT_MARKER)
    return () => {
      ctx.logger.info(UNMOUNT_MARKER)
    }
  }, 'claude-code-agent:mount-marker')
}

/** Message used by the Phase 1 stub, so the phase that lands the behavior is always named. */
const NOT_IMPLEMENTED_SUFFIX = 'lands in Phase 6 (the Agent adapter); the Phase 1 scaffold only types and documents the contract'

/**
 * Build and publish a dsh `Agent` backed by one Claude Code session.
 *
 * Phase 6 contract (typed now, implemented later — review findings D6/D7):
 * mint the shared identity with `newCcSessionId()` (a bare
 * `SessionId(randomUUID())`, exactly like the seam mints for `open()`), hand
 * that same id to both the dsh `Session` and `ctx.claudeCode.open()`'s
 * underlying SDK `sessionId`, then publish through
 * `ctx.agents.register(agent)` (or `enter()` + `announce()` if async setup
 * needs the agent visible-but-unpublished first) — `enter()` throws unless
 * `agent.id === agent.session.id`, so the shared mint is load-bearing, not
 * cosmetic. The returned disposer's identity is load-bearing too: Phase 6
 * must yield `register()`'s exact return value into the composite teardown,
 * never a wrapper closure around it.
 *
 * @param ctx - the context to publish the agent into; `inject` guarantees
 *   `ctx.agents` and `ctx.claudeCode` are present.
 * @param options - the session to open and the provider label to report.
 * @throws {ClaudeCodeError} code `NOT_IMPLEMENTED`, always, in Phase 1.
 */
export async function createClaudeCodeAgent(ctx: Context, options: CcAgentOptions): Promise<Agent> {
  void ctx
  // Mint the identity now, in the shape Phase 6 will actually use, so the
  // stub's failure message — and its type signature — already reflect the
  // real contract rather than a placeholder.
  const id = newCcSessionId()
  throw new ClaudeCodeError(
    `createClaudeCodeAgent(${JSON.stringify(options.cwd)}) `
    + `[would share identity ${id} between the Agent and its dsh Session] `
    + NOT_IMPLEMENTED_SUFFIX,
    'NOT_IMPLEMENTED',
  )
}
