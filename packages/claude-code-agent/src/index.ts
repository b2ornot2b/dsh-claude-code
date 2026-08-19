/**
 * Agent-adapter consumer for the DeepSeek Harness: publishes `ctx.agents`
 * entries backed by live Claude Code sessions, so a CC session is a first-class
 * citizen a human can talk to in the dsh UI (spec §7).
 *
 * Two surfaces, one implementation:
 *
 * - {@link createClaudeCodeAgent} — the function. Give it a context and open
 *   options, get back a published agent and its exact disposer. Nothing about
 *   it needs this plugin to be mounted.
 * - {@link ClaudeCodeAgentService} (`ctx.claudeCodeAgents`) — the same thing
 *   with the composition's configured defaults folded in and every live agent
 *   tracked, so a `cordis.yml` row is all a deployment needs.
 *
 * NAMED EXPORTS ONLY. A `default` export here would make the cordis Loader
 * unwrap the module to that single value and silently discard the sibling
 * `name`/`inject`/`Config` exports, mounting the plugin with an empty inject
 * list (harness post-mortem 0001, "export default drops the plugin's inject").
 * `tests/exports.spec.ts` asserts the absence of a default export.
 *
 * **This plugin registers no listener for any dsh mechanism.** In particular
 * none for `agent/pre-step`, `agent/request`, `agent/request-error` or
 * `tools/pre-execute` — those never fire for a CC-backed agent (D8), and a
 * listener here would only make the README's §7.1 table look survivable.
 * `tests/inert.spec.ts` asserts that emptiness directly.
 *
 * @module @deepseek-ai/dsh-claude-code-agent
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { CC_PERMISSION_MODES } from '@deepseek-ai/dsh-claude-code'
import type { CcSessionId } from '@deepseek-ai/dsh-claude-code'
import z from '@deepseek-ai/schemastery'

import { ClaudeCodeAgent } from './agent.ts'
import { createClaudeCodeAgent } from './spawn.ts'
import type { CcAgentHandle, CcAgentSpawnDeps } from './spawn.ts'
import { CC_AGENT_PROVIDER } from './types.ts'
import type { CcAgentConfig, CcAgentOptions, ResolvedCcAgentConfig } from './types.ts'

export { ClaudeCodeAgent, DEFAULT_DISPOSE_DRAIN_MS, extractMessageText } from './agent.ts'
export type { CcAgentMessageText, ClaudeCodeAgentDeps } from './agent.ts'
export { createClaudeCodeAgent } from './spawn.ts'
export type { CcAgentHandle, CcAgentSpawnDeps } from './spawn.ts'
export { CC_AGENT_PROVIDER, INERT_DSH_MECHANISMS } from './types.ts'
export type {
  CcAgentConfig, CcAgentDefaultsConfig, CcAgentOptions, CcAgentSession, InertDshMechanism,
  ResolvedCcAgentConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Claude Code agent factory. Provided by `@deepseek-ai/dsh-claude-code-agent`. */
    claudeCodeAgents: ClaudeCodeAgentService
  }
}

/** Plugin name shown in Loader diagnostics and cordis fiber trees. */
export const name = 'claude-code-agent'

/**
 * Services this plugin requires before it activates: the dsh agent registry
 * (what it publishes into), the Claude Code seam (what it adapts), and the
 * session store (an `Agent` needs a real, store-attached dsh `Session` —
 * without one the mirror's appends are published to nobody). Declaring all
 * three means cordis refuses to mount this plugin in a composition missing any
 * of them, which is a clean startup failure rather than a `spawn()` call
 * failing later for a surprising reason.
 */
export const inject: string[] = ['agents', 'claudeCode', 'sessions']

/**
 * Runtime validation schema for {@link CcAgentConfig}.
 *
 * Deliberately thin: every SESSION policy (auth, ask behavior, setting
 * sources, limits, env) already lives on `ctx.claudeCode.config`. What is here
 * is what a composition wants to fix for the agents this plugin spawns.
 */
export const Config: z<CcAgentConfig> = z.object({
  provider: z.string().default(CC_AGENT_PROVIDER),
  defaults: z.object({
    cwd: z.string(),
    model: z.string(),
    permissionMode: z.union(CC_PERMISSION_MODES),
  }),
})

/** Logged via `ctx.logger.info` when the plugin mounts; asserted by tests, not meant for parsing. */
export const MOUNT_MARKER = 'claude-code-agent: mounted (ctx.claudeCodeAgents ready; no agent is spawned until asked)'

/** Logged via `ctx.logger.info` when the plugin's fiber disposes. */
export const UNMOUNT_MARKER = 'claude-code-agent: unmounted'

/**
 * Validate one configuration value and resolve its defaults.
 *
 * @param config - the surface config from a `cordis.yml` row, a `ctx.plugin()`
 *   call, or a test. Omitted entirely means "all defaults".
 * @returns the fully resolved configuration; genuinely-unset fields are ABSENT,
 *   never present-and-`undefined` (`exactOptionalPropertyTypes` is on).
 * @throws {ValidationError} schemastery's own error, naming the exact path.
 */
export function resolveCcAgentConfig(config: CcAgentConfig = {}): ResolvedCcAgentConfig {
  const parsed = Config(config) as CcAgentConfig
  const defaults = parsed.defaults ?? {}
  return {
    provider: parsed.provider ?? CC_AGENT_PROVIDER,
    defaults: {
      ...(defaults.cwd === undefined || defaults.cwd === null ? {} : { cwd: defaults.cwd }),
      ...(defaults.model === undefined || defaults.model === null ? {} : { model: defaults.model }),
      ...(defaults.permissionMode === undefined || defaults.permissionMode === null
        ? {}
        : { permissionMode: defaults.permissionMode }),
    },
  }
}

/**
 * `ctx.claudeCodeAgents` — spawn and track CC-backed dsh agents.
 *
 * A thin composition-facing wrapper around {@link createClaudeCodeAgent}: it
 * folds in the configured defaults and keeps a registry of the handles it
 * created, so a UI can enumerate the CC-backed agents this plugin owns without
 * re-deriving that from `ctx.agents.list()` (which mixes them with every other
 * kind of agent).
 */
export class ClaudeCodeAgentService extends Service {
  /** Runtime validation schema for the plugin's configuration. */
  static readonly Config: z<CcAgentConfig> = Config

  /** The validated configuration with every default resolved. */
  readonly config: ResolvedCcAgentConfig

  /** Handles this service created, by shared dsh/CC id, in spawn order. */
  private readonly handles = new Map<CcSessionId, CcAgentHandle>()

  /**
   * The MOUNT context, captured from the constructor.
   *
   * Not `this.ctx`: cordis's `Service` stores a traced derivative whose fiber
   * is NOT the mounting plugin's, so an agent lifetime registered through it
   * survives the plugin unload that was supposed to tear it down (proved by
   * `tests/inert.spec.ts`'s unmount case — it fails without this field). The
   * seam's own service captures the constructor context for the same reason.
   */
  private readonly owner: Context

  /**
   * @param ctx - the context that owns the service AND every agent it spawns:
   *   unloading this plugin tears them down, in order, through each agent's own
   *   composite effect.
   * @param config - surface configuration; defaults are resolved here so a
   *   hand-mounted service behaves exactly like a `cordis.yml` row.
   */
  constructor(ctx: Context, config: CcAgentConfig = {}) {
    super(ctx, 'claudeCodeAgents')
    this.config = resolveCcAgentConfig(config)
    this.owner = ctx
    ctx.effect(() => () => { this.handles.clear() }, 'claudeCodeAgents:handles')
  }

  /**
   * Open a Claude Code session and publish it as a dsh agent.
   *
   * @param options - open options; `cwd`, `model`, `permissionMode` and
   *   `provider` fall back to this plugin's configured defaults.
   * @param deps - test seams; production passes none.
   * @returns the published agent and its exact disposer.
   * @throws {ClaudeCodeError} whatever the seam's `open()` throws, untouched —
   *   `INVALID_CWD` (including when neither the call nor the config named one),
   *   `SESSION_LIMIT`, `SESSION_EXISTS`, `BACKEND_ERROR`.
   */
  async spawn(options: Partial<CcAgentOptions> = {}, deps: CcAgentSpawnDeps = {}): Promise<CcAgentHandle> {
    const defaults = this.config.defaults
    const resolved: CcAgentOptions = {
      ...options,
      // An absent cwd stays absent-shaped as the empty string, which the seam
      // refuses with INVALID_CWD before anything spawns — one error path, not two.
      cwd: options.cwd ?? defaults.cwd ?? '',
      ...pick('model', options.model ?? defaults.model),
      ...pick('permissionMode', options.permissionMode ?? defaults.permissionMode),
      provider: options.provider ?? this.config.provider,
    }
    const handle = await createClaudeCodeAgent(this.owner, resolved, deps)
    const id = handle.agent.id
    const tracked: CcAgentHandle = {
      agent: handle.agent,
      dispose: async () => {
        this.handles.delete(id)
        await handle.dispose()
      },
    }
    this.handles.set(id, tracked)
    return tracked
  }

  /**
   * Look up one agent this service spawned.
   * @param id - the shared dsh/CC session id.
   * @returns the agent, or undefined when this service did not spawn it.
   */
  get(id: CcSessionId): ClaudeCodeAgent | undefined {
    return this.handles.get(id)?.agent
  }

  /**
   * Every agent this service spawned, in spawn order.
   * @returns a fresh array; mutating it does not affect the service.
   */
  list(): readonly ClaudeCodeAgent[] {
    return [...this.handles.values()].map(handle => handle.agent)
  }
}

/**
 * Mount the adapter. Named export, never a default — see the module doc.
 * @param ctx - the context this plugin mounts into; `inject` guarantees
 *   `ctx.agents`, `ctx.claudeCode` and `ctx.sessions` are already present.
 * @param config - surface configuration from the `cordis.yml` row.
 */
export function apply(ctx: Context, config: CcAgentConfig = {}): void {
  void new ClaudeCodeAgentService(ctx, config)

  // A visible, disposable marker rather than a side effect that outlives the
  // fiber — HMR (unload/reload this plugin) must leave no trace behind.
  ctx.effect(() => {
    ctx.logger.info(MOUNT_MARKER)
    return () => {
      ctx.logger.info(UNMOUNT_MARKER)
    }
  }, 'claude-code-agent:mount-marker')
}

/**
 * Build a single-key object to spread, or nothing when the value is unset.
 * `exactOptionalPropertyTypes` rejects assigning a possibly-`undefined` value
 * to an optional property.
 * @param key - the property name.
 * @param value - the value, when there is one.
 * @returns a spreadable object.
 */
function pick<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
