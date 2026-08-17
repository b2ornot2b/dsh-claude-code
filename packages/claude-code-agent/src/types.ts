/**
 * Planned adapter types for `@deepseek-ai/dsh-claude-code-agent`. Phase 6 ships
 * the `Agent` implementation these types describe; this Phase 1 scaffold
 * writes the contract down ahead of the implementation so it is typed,
 * reviewable, and stable before the loop it stubs is built.
 *
 * @module @deepseek-ai/dsh-claude-code-agent
 */

import type { CcOpenOptions } from '@deepseek-ai/dsh-claude-code'

/**
 * Options accepted by {@link createClaudeCodeAgent} (see `src/index.ts`): a
 * {@link CcOpenOptions} (the seam's `open()` shape — one Claude Code session)
 * plus the label dsh reports for the agent's provider route.
 */
export interface CcAgentOptions extends CcOpenOptions {
  /**
   * Reported as `Agent['options'].provider`. Defaults to `'claude-code'` in
   * Phase 6 — `AgentOptions` has no `setModel()` (D7); model changes ride
   * `query.setModel()` on the live SDK query and are reflected back into
   * `options.model` only as a startup snapshot.
   */
  readonly provider?: string
}

/**
 * Adapter plugin configuration. Phase 1 has nothing to configure — every
 * session policy this adapter will need (defaults, ask behavior, limits)
 * already lives on `ctx.claudeCode.config`, resolved by the seam. This type
 * exists so `apply()`'s signature and the `Config` schema are stable across
 * phases; Phase 6 extends it only if adapter-specific knobs turn out to be
 * necessary (e.g. default `InboxTarget`, turn-framing toggles).
 */
export interface CcAgentConfig {}

/**
 * dsh mechanisms that are **inert** for a CC-backed agent (spec §7.1,
 * confirmed by review finding D8): every plugin that hooks one of these sees
 * nothing happen when an entry from this package owns the turn, because they
 * are dispatched only from `ReactLoopAgent`'s loop around `ctx.llm.stream()`,
 * which a CC-backed agent never runs. See the README's substitutes table for
 * what each one maps to instead.
 */
export const INERT_DSH_MECHANISMS = [
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'tools/pre-execute',
] as const

/** One of {@link INERT_DSH_MECHANISMS}. */
export type InertDshMechanism = typeof INERT_DSH_MECHANISMS[number]
