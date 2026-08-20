/**
 * Configuration schema for the Claude Code seam (spec §10, revised by the
 * Phase 0 spike results). The schemastery schema is the single source of
 * defaults; {@link resolveClaudeCodeConfig} runs it and normalizes the
 * spec's YAML `null` placeholders into absent optional fields so callers can
 * rely on `exactOptionalPropertyTypes`.
 *
 * @module @deepseek-ai/dsh-claude-code
 */

import { hostname } from 'node:os'

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

/** Defaults for the discovery block. */
export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 15_000
export const DEFAULT_DISCOVERY_WINDOW_MS = 604_800_000
export const DEFAULT_MAX_RESUMABLE = 50
/**
 * Default per-source deadline for `discover()` (spec §6.3: "a source that
 * rejects or exceeds its deadline contributes a warning"). Set deliberately
 * ABOVE the remote probe source's own ~20s SSH transport timeout, so a
 * well-behaved remote source reports its own richer error first
 * (`"b2hx: unreachable (ssh connect timeout 6000ms)"`) and this coordinator
 * deadline is only the backstop for a source that never settles at all — a
 * wedged child process, a hung transport with no timeout of its own.
 */
export const DEFAULT_DISCOVERY_SOURCE_TIMEOUT_MS = 30_000

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

/**
 * One preseeded "always allow" rule for the integration-owned rule cache
 * (`src/ask/rules.ts`). The shape is the SDK's own `PermissionRuleValue`, so a
 * configured entry can be compared field for field against the suggestion the
 * CLI attaches to a permission prompt.
 */
export interface CcAskRuleConfig {
  /** The tool the rule is about (`'Bash'`, `'Read'`, …). */
  readonly toolName: string
  /** The rule body (`'npm test:*'`). Absent means the whole tool. */
  readonly ruleContent?: string
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
   * Where that rule cache lives. An absolute path is used as given; a relative
   * one resolves against the session's `cwd`. Unset means
   * `<cwd>/.dsh-claude-code/always-allow.json`. Ignored when
   * `persistAlwaysAllow` is false.
   */
  readonly ruleCachePath?: string
  /**
   * Rules preseeded into that cache: consulted exactly like stored ones, never
   * written back to the file. The way to grant a repeatable command
   * (`Bash(npm test:*)`) in a composition that has no interactive answerer at
   * all. Defaults to none.
   */
  readonly rules?: CcAskRuleConfig[]
}

/** Resource ceilings for the composition. */
export interface CcLimitsConfig {
  /** Maximum live sessions; `open()` beyond it fails with code `SESSION_LIMIT`. Defaults to 4. */
  readonly maxConcurrentSessions?: number
  /** Optional spend ceiling in USD across the composition's sessions. Unset means no ceiling. */
  readonly maxBudgetUsd?: number
  /**
   * Close a session that has been idle, with NOTHING pending on a human, for
   * this many milliseconds. **UNSET BY DEFAULT, and unset means off** — no
   * timer is installed at all, and no session is ever reclaimed. An operator who
   * did not ask for reaping gets exactly the behaviour they had before this
   * option existed.
   *
   * Set it when a long-lived host service is handing `maxConcurrentSessions`
   * slots to short-lived dsh sessions that do not always close their own work:
   * the slots are service-wide, so one abandoned session denies every later one.
   *
   * A session with a PENDING ASK is never reaped, no matter how long it has sat:
   * that is a human still deciding, and it is exactly the state that produced
   * the 1h32m session this option exists to clean up after.
   */
  readonly idleTimeoutMs?: number
}

/** Session-discovery surface configuration. */
export interface CcDiscoveryConfig {
  /** Discover sessions on this host (SDK store + live registry). */
  readonly local: boolean
  /** How long a source's result may be reused. */
  readonly cacheTtlMs: number
  /** How far back `resumable` reaches. */
  readonly recentWindowMs: number
  /** Per-source cap, so a rendered list stays scannable. */
  readonly maxResumable: number
  /** Include titles and first-prompt excerpts (spec §12). */
  readonly includeTitles: boolean
  /**
   * How long the coordinator waits for ONE source before giving up on it and
   * contributing a warning instead. A rejection is already handled without
   * this — this is the backstop for a source that never settles, rejects nor
   * resolves (a hung SSH connect, a wedged child process). Defaults to
   * {@link DEFAULT_DISCOVERY_SOURCE_TIMEOUT_MS}.
   */
  readonly sourceTimeoutMs: number
}

/**
 * This host's label in discovery output.
 * @returns the short hostname, or `local` when the platform gives nothing.
 */
export function defaultHostLabel(): string {
  const name = hostname().split('.')[0]
  return name === undefined || name === '' ? 'local' : name
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
  /** This host's label in discovery output. Defaults to the short hostname. */
  readonly hostLabel?: string
  /** Session-discovery surface configuration. */
  readonly discovery?: Partial<CcDiscoveryConfig>
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
    readonly rules: readonly CcAskRuleConfig[]
  }
  readonly limits: {
    readonly maxConcurrentSessions: number
    readonly maxBudgetUsd?: number
    /** ABSENT when idle reaping is off, which is the default. */
    readonly idleTimeoutMs?: number
  }
  readonly env: Readonly<Record<string, string>>
  readonly hostLabel: string
  readonly discovery: CcDiscoveryConfig
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
    rules: z.array(z.object({
      toolName: z.string().required(),
      ruleContent: z.string(),
    })).default([]),
  }),
  limits: z.object({
    maxConcurrentSessions: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_SESSIONS),
    maxBudgetUsd: z.number().min(0),
    // NO `.default(...)`: the absence of this key is the "off" signal the
    // service branches on, and a default here would silently start reaping
    // sessions in every composition that already exists.
    idleTimeoutMs: z.number().min(1),
  }),
  env: z.dict(z.string()).default({}),
  hostLabel: z.string().default(defaultHostLabel()),
  discovery: z.object({
    local: z.boolean().default(true),
    cacheTtlMs: z.number().min(1).default(DEFAULT_DISCOVERY_CACHE_TTL_MS),
    recentWindowMs: z.number().min(1).default(DEFAULT_DISCOVERY_WINDOW_MS),
    maxResumable: z.number().step(1).min(0).default(DEFAULT_MAX_RESUMABLE),
    includeTitles: z.boolean().default(true),
    sourceTimeoutMs: z.number().min(1).default(DEFAULT_DISCOVERY_SOURCE_TIMEOUT_MS),
  }),
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
  const discovery = parsed.discovery ?? {}

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
      rules: ask.rules ?? [],
    },
    limits: {
      maxConcurrentSessions: limits.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
      ...optional('maxBudgetUsd', limits.maxBudgetUsd),
      ...optional('idleTimeoutMs', limits.idleTimeoutMs),
    },
    env: parsed.env ?? {},
    hostLabel: parsed.hostLabel ?? defaultHostLabel(),
    discovery: {
      local: discovery.local ?? true,
      cacheTtlMs: discovery.cacheTtlMs ?? DEFAULT_DISCOVERY_CACHE_TTL_MS,
      recentWindowMs: discovery.recentWindowMs ?? DEFAULT_DISCOVERY_WINDOW_MS,
      maxResumable: discovery.maxResumable ?? DEFAULT_MAX_RESUMABLE,
      includeTitles: discovery.includeTitles ?? true,
      sourceTimeoutMs: discovery.sourceTimeoutMs ?? DEFAULT_DISCOVERY_SOURCE_TIMEOUT_MS,
    },
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
