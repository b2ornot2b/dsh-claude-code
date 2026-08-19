/**
 * The adapter's type vocabulary: what a caller passes to spawn one CC-backed
 * agent, what the plugin is configured with, the narrow view of the seam the
 * adapter actually drives, and the list of dsh mechanisms that are inert for
 * an agent this package registers.
 *
 * The seam is named STRUCTURALLY here ({@link CcAgentSession}), never by its
 * class, for the same two reasons the seam names dsh's services structurally:
 * cordis 4 hands out a fresh traceable Proxy per service access (so nothing may
 * be identity-compared or `instanceof`-checked across the boundary), and a
 * narrow interface is what makes the adapter testable offline against a
 * two-hundred-line fake instead of a subprocess.
 *
 * @module @deepseek-ai/dsh-claude-code-agent
 */

import type {
  CcInterruptOutcome, CcMessageEnvelope, CcOpenOptions, CcOutboxEntry, CcPermissionMode,
  CcSendOptions, CcSessionId, CcSessionSnapshot, CcSessionStatus, CcUuid,
} from '@deepseek-ai/dsh-claude-code'

/** The provider route this adapter reports on `Agent.options.provider`. */
export const CC_AGENT_PROVIDER = 'claude-code'

/**
 * Options accepted by `createClaudeCodeAgent()`: a {@link CcOpenOptions} (the
 * seam's `open()` shape — one Claude Code session) plus the label dsh reports
 * for the agent's provider route.
 *
 * `mirror` and `ask` are deliberately ABSENT from this shape even though
 * `CcOpenOptions` carries them: this adapter owns both. The mirror target is
 * the agent's own dsh session (it cannot exist before `open()` mints the id),
 * and the ask target is the agent itself.
 */
export interface CcAgentOptions extends Omit<CcOpenOptions, 'mirror' | 'ask'> {
  /**
   * Reported as `Agent['options'].provider`. Defaults to
   * {@link CC_AGENT_PROVIDER}. `AgentOptions` has no `setModel()` (D7), so a
   * model change goes through `ClaudeCodeAgent.setModel()` — a package-level
   * method, not part of dsh's `Agent` interface.
   */
  readonly provider?: string
}

/** Session defaults a `cordis.yml` row may set for every agent this plugin spawns. */
export interface CcAgentDefaultsConfig {
  /** Absolute working directory used when a `spawn()` call names none. */
  readonly cwd?: string
  /** Model id used when a `spawn()` call names none. */
  readonly model?: string
  /** Permission mode used when a `spawn()` call names none. */
  readonly permissionMode?: CcPermissionMode
}

/**
 * Adapter plugin configuration.
 *
 * Deliberately thin: every SESSION policy (auth, ask behavior, setting
 * sources, limits, env) lives on `ctx.claudeCode.config`, resolved once by the
 * seam. What is left here is what a composition wants to fix for the agents
 * this plugin spawns — the provider label it reports, and the open options a
 * caller may omit.
 */
export interface CcAgentConfig {
  /** Provider route reported on every agent this plugin spawns. Defaults to `'claude-code'`. */
  readonly provider?: string
  /** Open-option defaults filled in when a spawn call omits them. */
  readonly defaults?: CcAgentDefaultsConfig
}

/** {@link CcAgentConfig} after validation, with every default resolved. */
export interface ResolvedCcAgentConfig {
  readonly provider: string
  readonly defaults: {
    readonly cwd?: string
    readonly model?: string
    readonly permissionMode?: CcPermissionMode
  }
}

/**
 * The seam's live session actor, narrowed to what the adapter drives.
 * `CcSession` (from `@deepseek-ai/dsh-claude-code`) satisfies it structurally.
 *
 * Everything the adapter needs is here and nothing else is: it never opens,
 * never closes (the spawn effect owns that), never attaches a mirror or an ask
 * target (the spawn effect owns those too), and never reads the ask table.
 */
export interface CcAgentSession {
  /** The shared dsh/CC identity. Must equal the dsh session's id (D6). */
  readonly id: CcSessionId
  /** The seam's four-state lifecycle; the adapter projects it onto dsh's two. */
  readonly status: CcSessionStatus
  /**
   * Send one message.
   * @param input - the text, or an envelope with a caller-supplied uuid.
   * @param options - which inbox verb this is.
   * @returns the uuid the message was stamped with (the outbox/receipt key).
   */
  send(input: string | { readonly content: string, readonly uuid?: CcUuid }, options?: CcSendOptions): CcUuid
  /**
   * Interrupt the running turn and reconcile the receipt.
   * @param options - whether queued messages survive.
   * @returns what survived, what was cancelled, and whether a receipt existed.
   */
  interrupt(options?: { readonly keepQueued?: boolean }): Promise<CcInterruptOutcome>
  /**
   * What this session sent and what became of each message.
   * @returns a snapshot array in send order.
   */
  outbox(): readonly CcOutboxEntry[]
  /**
   * The session's public value projection.
   * @returns the snapshot (status, model, pending asks, context usage).
   */
  snapshot(): CcSessionSnapshot
  /**
   * Switch the model mid-session.
   * @param model - the model id, or omitted for the CLI default.
   * @returns nothing.
   */
  setModel(model?: string): Promise<void>
  /**
   * Subscribe to every message the session produces.
   * @param listener - called for each message, in arrival order.
   * @returns an unsubscribe function.
   */
  onMessage(listener: (envelope: CcMessageEnvelope) => void): () => void
  /**
   * Run `listener` once, when the session finishes closing.
   * @param listener - called after the session reaches `closed`.
   * @returns an unsubscribe function.
   */
  onClose(listener: () => void): () => void
}

/**
 * dsh mechanisms that are **inert** for a CC-backed agent (spec §7.1,
 * confirmed by review finding D8): every plugin that hooks one of these sees
 * nothing happen when an entry from this package owns the turn, because they
 * are dispatched only from `ReactLoopAgent`'s loop around `ctx.llm.stream()`,
 * which a CC-backed agent never runs. See the README's substitutes table for
 * what each one maps to instead.
 *
 * This adapter registers NO listener for any of them — faking one would make
 * the documentation above a lie in the one direction that matters (a plugin
 * author concluding the hook works). `tests/inert.spec.ts` asserts the absence.
 */
export const INERT_DSH_MECHANISMS = [
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'tools/pre-execute',
] as const

/** One of {@link INERT_DSH_MECHANISMS}. */
export type InertDshMechanism = typeof INERT_DSH_MECHANISMS[number]
