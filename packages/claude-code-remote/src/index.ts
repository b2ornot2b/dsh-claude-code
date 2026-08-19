/**
 * Generic probe-runner discovery source for the Claude Code seam.
 *
 * This package contributes sessions from OTHER hosts: it runs a per-host
 * inventory probe over any argv — `ssh host …`, `container exec …`, or a
 * local run with a different `--home` — and parses the schema-1 envelope the
 * probe emits (`packages/claude-code/scripts/claude-inventory`). Host names,
 * SSH aliases and path-translation rules are all CONFIGURATION on this
 * plugin, never code, so the package carries no site-specific knowledge and
 * upstreams unchanged.
 *
 * NAMED EXPORTS ONLY. A `default` export here would make the cordis Loader
 * unwrap the module to that single value and silently discard the sibling
 * `name`/`inject`/`Config` exports, mounting the plugin with an empty inject
 * list (harness post-mortem 0001, "export default drops the plugin's
 * inject").
 *
 * @module @deepseek-ai/dsh-claude-code-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import type { CcPathMapping } from './paths.ts'
import { createProbeSource } from './source.ts'

export { parseProbeOutput, PROBE_SCHEMA_MAJOR } from './parse.ts'
export type { CcParseContext } from './parse.ts'
export { translatePath } from './paths.ts'
export type { CcPathMapping } from './paths.ts'
export { createProbeSource } from './source.ts'
export type { CcProbeRun, CcProbeSourceOptions } from './source.ts'

/** How long to wait for `ssh` to establish the connection, before the probe even runs. */
const DEFAULT_CONNECT_TIMEOUT_MS = 6_000
/** How long to wait for the whole probe run (connect + read + print) before giving up on a host. */
const DEFAULT_TIMEOUT_MS = 20_000

/** One host this plugin polls. */
export interface CcRemoteHostConfig {
  /** The label this host reports under — becomes `CcDiscoveredSession.host` and part of the source id. */
  readonly label: string
  /** SSH target, when different from `label` (e.g. a `.local` suffix or a bare alias). Ignored when `argv` is set. */
  readonly ssh?: string
  /**
   * The full probe command, overriding the default `ssh … <probe>` construction entirely.
   *
   * A mutable array, not `readonly`, so this interface stays exactly what
   * `schemastery` infers as `z.array(...)`'s output shape — `Config`'s
   * `z<CcClaudeCodeRemoteConfig>` annotation only type-checks under
   * `exactOptionalPropertyTypes` when every property matches that shape.
   */
  readonly argv?: string[]
  /** `--home` to pass the probe, when this host's Claude Code state lives somewhere non-default. */
  readonly home?: string
  /** Path rewrites specific to this host; falls back to the plugin-wide `pathMap` when absent. */
  readonly pathMap?: CcPathMapping[]
}

/** Configuration for the `claude-code-remote` plugin. */
export interface CcClaudeCodeRemoteConfig {
  /**
   * Absolute path to the `claude-inventory` probe on each target host.
   * Required for any host that does not supply its own `argv` — there is no
   * baked-in default path, because a fixed path would be exactly the kind of
   * site-specific knowledge this package is written to avoid.
   */
  readonly probe?: string
  /** SSH connect timeout, for hosts built from the default `ssh …` argv. */
  readonly connectTimeoutMs?: number
  /** How long to wait for a probe run before warning that the host is unreachable. */
  readonly timeoutMs?: number
  /** The hosts to poll. Empty (the default) registers no source at all. */
  readonly hosts?: CcRemoteHostConfig[]
  /** Path rewrites applied to every host that does not set its own. */
  readonly pathMap?: CcPathMapping[]
}

const PATH_MAPPING_SCHEMA = z.object({
  from: z.string().required(),
  to: z.string().required(),
})

/** Runtime validation schema for {@link CcClaudeCodeRemoteConfig}. */
export const Config: z<CcClaudeCodeRemoteConfig> = z.object({
  probe: z.string(),
  connectTimeoutMs: z.number().min(1),
  timeoutMs: z.number().min(1),
  hosts: z.array(z.object({
    label: z.string().required(),
    ssh: z.string(),
    argv: z.array(z.string()),
    home: z.string(),
    pathMap: z.array(PATH_MAPPING_SCHEMA),
  })).default([]),
  pathMap: z.array(PATH_MAPPING_SCHEMA).default([]),
})

/**
 * Prefer a host-level array over the plugin-wide fallback — but only when the
 * host actually supplied one.
 *
 * `schemastery` defaults every configured `z.array(...)` field to `[]`, even
 * without an explicit `.default([])`, so an unset `host.argv`/`host.pathMap`
 * never survives validation as `undefined`. A plain `host.field ?? fallback`
 * would therefore always pick the (empty) validated value and never reach
 * `fallback`. Treating an empty array the same as "not supplied" is the only
 * distinction schemastery leaves available here, and it is the right one: an
 * empty `argv` is not a usable command, and an empty `pathMap` is exactly
 * "apply no rewrites", which is what falling through to the wider default
 * would also produce whenever the wider default is itself empty.
 *
 * @param host - the host-level value, already validated (so `[]` when unset).
 * @param fallback - the plugin-wide value to use when the host supplied nothing.
 * @returns `host` when non-empty, `fallback` otherwise.
 */
function pickArray<T>(host: readonly T[], fallback: readonly T[]): readonly T[] {
  return host.length > 0 ? host : fallback
}

/**
 * Build the default `ssh … <probe>` argv for a host that did not supply its own.
 * @param host - the host's configuration.
 * @param config - the plugin's configuration, for `probe` and `connectTimeoutMs`.
 * @returns the argv to run.
 * @throws when neither the host nor the plugin config names a probe path.
 */
function buildSshArgv(host: CcRemoteHostConfig, config: CcClaudeCodeRemoteConfig): readonly string[] {
  if (config.probe === undefined) {
    throw new Error(
      `claude-code-remote: host '${host.label}' has no argv and config.probe is unset — `
      + `either name the probe path or give this host its own argv`,
    )
  }
  const connectTimeoutS = Math.ceil((config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) / 1000)
  return [
    'ssh', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutS}`,
    host.ssh ?? host.label, config.probe,
    ...(host.home === undefined ? [] : ['--home', host.home]),
  ]
}

/** Plugin name shown in Loader diagnostics and cordis fiber trees. */
export const name = 'claude-code-remote'

/** Requires the Claude Code seam — this plugin only ever registers into `ctx.claudeCode`. */
export const inject = ['claudeCode']

/**
 * Mount one probe-backed discovery source per configured host.
 *
 * Each registration goes through `ctx.effect`, so unmounting this plugin (a
 * failed reload, a composition teardown) removes every source it added and
 * none of another plugin's.
 *
 * @param ctx - the cordis context; `ctx.claudeCode` must already be mounted (declared via `inject`).
 * @param config - validated {@link CcClaudeCodeRemoteConfig}.
 */
export function apply(ctx: Context, config: CcClaudeCodeRemoteConfig = {}): void {
  for (const host of config.hosts ?? []) {
    const hostArgv = host.argv ?? []
    const argv = hostArgv.length > 0 ? hostArgv : buildSshArgv(host, config)
    const source = createProbeSource({
      id: `remote:${host.label}`,
      host: host.label,
      argv,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pathMap: pickArray(host.pathMap ?? [], config.pathMap ?? []),
    })
    ctx.effect(() => ctx.claudeCode.registerDiscoverySource(source), `claudeCodeRemote:${host.label}`)
  }
}
