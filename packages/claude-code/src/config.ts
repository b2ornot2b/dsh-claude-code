/**
 * Configuration schema for the Claude Code seam (spec §10, revised by the
 * Phase 0 spike results). The schemastery schema is the single source of
 * defaults; {@link resolveClaudeCodeConfig} runs it and normalizes the
 * spec's YAML `null` placeholders into absent optional fields so callers can
 * rely on `exactOptionalPropertyTypes`.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import z from '@deepseek-ai/schemastery'

import {
  ASK_FALLBACKS, CC_AUTH_MODES, CC_PERMISSION_MODES, CC_SETTING_SOURCES, ClaudeCodeError,
} from './types.ts'
import type { AskFallback, CcAuthMode, CcPermissionMode, CcSettingSource } from './types.ts'

/** Default credential REFERENCE name resolved through `ctx.credentials` under `auth: 'api-key'`. */
export const DEFAULT_API_KEY_REF = 'ANTHROPIC_API_KEY'

/** Default bounded wait for an ask that cannot reach a human (delegated agent, no answerer). */
export const DEFAULT_DELEGATED_ASK_TIMEOUT_MS = 120_000

/** Default ceiling on live Claude Code sessions per composition. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 4

/** Session defaults applied to every `open()` that does not override them. */
export interface CcDefaultsConfig {
  /** Model id; unset means the Claude Code CLI default. */
  readonly model?: string
  /** Permission mode for new sessions. Defaults to `'default'`. */
  readonly permissionMode?: CcPermissionMode
  /**
   * On-disk setting layers the session may load. Defaults to `[]` (full
   * isolation) and is ALWAYS sent explicitly: omitting it makes the SDK load
   * every source, including the user's real settings and `CLAUDE.md`.
   */
  readonly settingSources?: CcSettingSource[]
  /** Extra text appended to the `claude_code` system-prompt preset. */
  readonly appendSystemPrompt?: string
}

/** Ask-channel policy: how permission/question prompts are waited on and what happens when nobody can answer. */
export interface CcAskConfig {
  /** Wait before an ask falls back. Unset means pend indefinitely (the interactive posture). */
  readonly timeoutMs?: number
  /**
   * Bounded wait used when no human can be reached at all — a delegated
   * (owned) agent, an absent answerer, or a dismissed prompt. Defaults to
   * 120000ms.
   */
  readonly delegatedTimeoutMs?: number
  /** What to answer when the wait elapses or the ask cannot be routed. Defaults to `'deny'`. */
  readonly fallback?: AskFallback
  /**
   * Remember "always allow" decisions across sessions. This is an
   * INTEGRATION-OWNED rule cache consulted inside `canUseTool`, not SDK
   * persistence: Phase 0 spike 4 proved a headless `canUseTool` never writes
   * `.claude/settings.local.json`, with any `settingSources` value. Defaults to
   * true.
   */
  readonly persistAlwaysAllow?: boolean
  /**
   * Where that rule cache lives. Unset means the harness-default location
   * (resolved in Phase 4, when the cache is first written). Ignored when
   * `persistAlwaysAllow` is false.
   */
  readonly ruleCachePath?: string
}

/** Resource ceilings for the composition. */
export interface CcLimitsConfig {
  /** Maximum live sessions; `open()` beyond it fails with code `SESSION_LIMIT`. Defaults to 4. */
  readonly maxConcurrentSessions?: number
  /** Optional spend ceiling in USD across the composition's sessions. Unset means no ceiling. */
  readonly maxBudgetUsd?: number
}

/**
 * Plugin config. Every field is optional — the schema supplies defaults, and an
 * explicit YAML `null` is treated exactly like an omitted key.
 */
export interface ClaudeCodeConfig {
  /**
   * Escape hatch for `pathToClaudeCodeExecutable`: an already-installed
   * `claude` executable to use instead of the SDK's bundled platform binary
   * (see the README note on install size).
   */
  readonly executablePath?: string
  /**
   * Pre-warm one SDK subprocess at mount (`startup()`). Worth ~300ms of init
   * latency for interactive compositions and nothing for batch ones; a warm
   * handle is single-use. Defaults to true.
   */
  readonly prewarm?: boolean
  /** How Claude Code authenticates. Defaults to `'subscription'`. */
  readonly auth?: CcAuthMode
  /**
   * Credential REFERENCE name resolved through `ctx.credentials` per operation
   * (never a raw key, so rotation needs no restart). Defaults to
   * `'ANTHROPIC_API_KEY'`. Only consulted under `auth: 'api-key'`.
   */
  readonly apiKeyRef?: string
  /** Session defaults. */
  readonly defaults?: CcDefaultsConfig
  /** Ask-channel policy. */
  readonly ask?: CcAskConfig
  /** Resource ceilings. */
  readonly limits?: CcLimitsConfig
  /**
   * Extra environment variables overlaid onto the subprocess env (e.g.
   * `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES`). The overlay is applied on top
   * of a spread of `process.env`; `options.env` REPLACES the subprocess
   * environment, so this map never stands alone.
   */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The configuration after validation and default resolution: defaulted fields
 * are required, and fields whose "unset" state is meaningful stay optional but
 * are guaranteed ABSENT (never `null`, never `undefined`-valued) when unset.
 */
export interface ResolvedClaudeCodeConfig {
  readonly executablePath?: string
  readonly prewarm: boolean
  readonly auth: CcAuthMode
  readonly apiKeyRef: string
  readonly defaults: {
    readonly model?: string
    readonly permissionMode: CcPermissionMode
    readonly settingSources: readonly CcSettingSource[]
    readonly appendSystemPrompt?: string
  }
  readonly ask: {
    readonly timeoutMs?: number
    readonly delegatedTimeoutMs: number
    readonly fallback: AskFallback
    readonly persistAlwaysAllow: boolean
    readonly ruleCachePath?: string
  }
  readonly limits: {
    readonly maxConcurrentSessions: number
    readonly maxBudgetUsd?: number
  }
  readonly env: Readonly<Record<string, string>>
}

/**
 * Runtime validation schema for {@link ClaudeCodeConfig}. Cordis validates
 * mount config against this (`static Config`), and
 * {@link resolveClaudeCodeConfig} re-runs it so a hand-constructed service gets
 * the same defaults as a `cordis.yml` row.
 */
export const Config: z<ClaudeCodeConfig> = z.object({
  executablePath: z.string(),
  prewarm: z.boolean().default(true),
  auth: z.union(CC_AUTH_MODES).default('subscription'),
  apiKeyRef: z.string().default(DEFAULT_API_KEY_REF),
  defaults: z.object({
    model: z.string(),
    permissionMode: z.union(CC_PERMISSION_MODES).default('default'),
    settingSources: z.array(z.union(CC_SETTING_SOURCES)).default([]),
    appendSystemPrompt: z.string(),
  }),
  ask: z.object({
    timeoutMs: z.number().min(1),
    delegatedTimeoutMs: z.number().min(1).default(DEFAULT_DELEGATED_ASK_TIMEOUT_MS),
    fallback: z.union(ASK_FALLBACKS).default('deny'),
    persistAlwaysAllow: z.boolean().default(true),
    ruleCachePath: z.string(),
  }),
  limits: z.object({
    maxConcurrentSessions: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_SESSIONS),
    maxBudgetUsd: z.number().min(0),
  }),
  env: z.dict(z.string()).default({}),
})

/**
 * Drop a value that the schema left as `null` (the spec renders every unset
 * option as YAML `null`) or `undefined`, so the resolved config satisfies
 * `exactOptionalPropertyTypes`: unset fields are ABSENT, never present-and-null.
 * @param value - the raw schema output for one optional field.
 * @returns a single-key object to spread, or an empty object when unset.
 */
function optional<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

/**
 * Validate one configuration value and resolve every default.
 *
 * @param config - the surface config from a `cordis.yml` row, a `ctx.plugin()`
 *   call, or a test. Omitted entirely means "all defaults".
 * @returns the fully resolved configuration.
 * @throws {ValidationError} when a value has the wrong type or is outside its
 *   documented range (schemastery's own error, naming the exact path).
 * @throws {ClaudeCodeError} code `INVALID_CONFIG` when values are individually
 *   valid but inconsistent with each other.
 */
export function resolveClaudeCodeConfig(config: ClaudeCodeConfig = {}): ResolvedClaudeCodeConfig {
  const parsed = Config(config) as ClaudeCodeConfig
  const defaults = parsed.defaults ?? {}
  const ask = parsed.ask ?? {}
  const limits = parsed.limits ?? {}

  const resolved: ResolvedClaudeCodeConfig = {
    ...optional('executablePath', parsed.executablePath),
    prewarm: parsed.prewarm ?? true,
    auth: parsed.auth ?? 'subscription',
    apiKeyRef: parsed.apiKeyRef ?? DEFAULT_API_KEY_REF,
    defaults: {
      ...optional('model', defaults.model),
      permissionMode: defaults.permissionMode ?? 'default',
      settingSources: defaults.settingSources ?? [],
      ...optional('appendSystemPrompt', defaults.appendSystemPrompt),
    },
    ask: {
      ...optional('timeoutMs', ask.timeoutMs),
      delegatedTimeoutMs: ask.delegatedTimeoutMs ?? DEFAULT_DELEGATED_ASK_TIMEOUT_MS,
      fallback: ask.fallback ?? 'deny',
      persistAlwaysAllow: ask.persistAlwaysAllow ?? true,
      ...optional('ruleCachePath', ask.ruleCachePath),
    },
    limits: {
      maxConcurrentSessions: limits.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
      ...optional('maxBudgetUsd', limits.maxBudgetUsd),
    },
    env: parsed.env ?? {},
  }

  // Individually-valid values that contradict each other. An empty credential
  // reference under api-key auth would resolve to nothing at spawn time and
  // silently fall back to whatever the ambient environment holds — exactly the
  // silent-billing failure the auth switch exists to prevent.
  if (resolved.auth === 'api-key' && resolved.apiKeyRef.trim().length === 0) {
    throw new ClaudeCodeError(
      'claude-code: auth "api-key" requires a non-empty apiKeyRef (the credential reference name, not the key)',
      'INVALID_CONFIG')
  }

  return resolved
}
