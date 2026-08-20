/**
 * Parse the per-host probe's schema-1 envelope into discovered sessions.
 *
 * A mismatch between the probe and this parser is EXPECTED at times —
 * Syncthing (or whatever file-sync mesh a deployment uses) propagates the
 * probe script to every host in seconds, while the dsh profile's copy of
 * this plugin only changes when the installer runs. That drift must surface
 * as a named warning, never a throw: `discover()` on the source built from
 * this parser must be safe to call unconditionally, even against a probe
 * from tomorrow or last year.
 *
 * @module @deepseek-ai/dsh-claude-code-remote
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { CcDiscoveredSession, CcDiscoveryResult } from '@deepseek-ai/dsh-claude-code'

import { translatePath } from './paths.ts'
import type { CcPathMapping } from './paths.ts'

/** The probe envelope major this parser understands (`claude-inventory`'s `SCHEMA`). */
export const PROBE_SCHEMA_MAJOR = 1

/** How much raw output a parse-failure warning may quote — enough to identify the problem, never the whole stream. */
const EXCERPT_MAX = 200

/** What the parser needs to know about the source it is parsing output for. */
export interface CcParseContext {
  /** The discovery source id this output came from, carried onto every session for debugging a wrong answer. */
  readonly sourceId: string
  /** The host label, used to prefix every warning so a mixed-host log stays attributable. */
  readonly host: string
  /** Rewrites applied to every reported `cwd` before it reaches a session. */
  readonly pathMap: readonly CcPathMapping[]
}

/**
 * Build a `sessions: [], warnings: [prefixed]` result — the shape every
 * failure branch below returns, so a caller never has to special-case "the
 * probe said nothing useful" from "the probe said nothing at all".
 * @param host - the host to prefix the warning with.
 * @param warning - the unprefixed warning text.
 * @returns an empty discovery result carrying exactly one warning.
 */
function empty(host: string, warning: string): CcDiscoveryResult {
  return { sessions: [], warnings: [`${host}: ${warning}`], generatedAt: Date.now(), cached: false }
}

/**
 * Parse probe output into a discovery result.
 *
 * Never throws: a non-JSON stream, an unknown schema major, or a
 * malformed row all become a warning instead of an exception, because the
 * caller (`createProbeSource`) promises the same of `discover()` and this is
 * where that promise is actually kept.
 *
 * @param raw - the probe's stdout, verbatim.
 * @param context - source identity, host label and path map.
 * @returns sessions plus warnings; `warnings` is empty only when the probe
 *   itself reported none.
 */
export function parseProbeOutput(raw: string, context: CcParseContext): CcDiscoveryResult {
  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return empty(context.host, `probe output was not JSON: ${raw.trim().slice(0, EXCERPT_MAX)}`)
  }

  const schema = envelope['schema']
  if (schema !== PROBE_SCHEMA_MAJOR) {
    return empty(context.host, `probe reported schema ${String(schema)}; this plugin understands `
      + `schema ${PROBE_SCHEMA_MAJOR}. One side of the mesh is stale — update the probe or this plugin.`)
  }

  const generatedAt = typeof envelope['generatedAt'] === 'number' ? envelope['generatedAt'] : Date.now()
  const probeWarnings = Array.isArray(envelope['warnings']) ? envelope['warnings'] : []
  const warnings = probeWarnings.map(warning => `${context.host}: ${String(warning)}`)
  const sessions: CcDiscoveredSession[] = []

  /**
   * Translate a remote cwd, recording the original when translation changed it.
   * @param remote - the path as the probe reported it (typed `unknown`; the
   *   envelope is untrusted external input).
   * @returns the `cwd`/`remoteCwd` fields for a discovered session.
   */
  const cwdFields = (remote: unknown): { cwd: string, remoteCwd?: string } => {
    const path = typeof remote === 'string' ? remote : ''
    const local = translatePath(context.pathMap, path)
    return local === path ? { cwd: local } : { cwd: local, remoteCwd: path }
  }

  const liveRows = Array.isArray(envelope['live']) ? envelope['live'] : []
  for (const raw of liveRows) {
    const entry = raw as Record<string, unknown>
    const sessionId = entry['sessionId']
    if (typeof sessionId !== 'string') {
      // Silently dropping this row would look identical to "nothing live" —
      // exactly the "nothing exists" vs "I could not look" ambiguity this
      // branch exists to eliminate.
      warnings.push(`${context.host}: live row missing sessionId, skipped`)
      continue
    }
    const startedAt = typeof entry['startedAt'] === 'number' ? entry['startedAt'] : generatedAt
    const name = entry['name']
    const pid = entry['pid']
    const kind = entry['kind']
    const entrypoint = entry['entrypoint']
    const version = entry['version']
    sessions.push({
      sessionId: SessionId(sessionId),
      origin: 'live-external',
      host: context.host,
      sourceId: context.sourceId,
      ...cwdFields(entry['cwd']),
      lastActivityAt: startedAt,
      createdAt: startedAt,
      sendable: false,
      resumable: true,
      fidelity: 'probe',
      live: {
        liveness: entry['liveness'] === 'confirmed' ? 'confirmed' : 'assumed',
        ...(typeof pid === 'number' ? { pid } : {}),
        ...(typeof kind === 'string' ? { kind } : {}),
        ...(typeof entrypoint === 'string' ? { entrypoint } : {}),
        ...(typeof version === 'string' ? { claudeVersion: version } : {}),
      },
      ...(typeof name === 'string' ? { title: name } : {}),
    })
  }

  const resumableRows = Array.isArray(envelope['resumable']) ? envelope['resumable'] : []
  for (const raw of resumableRows) {
    const entry = raw as Record<string, unknown>
    const sessionId = entry['sessionId']
    if (typeof sessionId !== 'string') {
      warnings.push(`${context.host}: resumable row missing sessionId, skipped`)
      continue
    }
    const lastModified = entry['lastModified']
    const title = entry['title']
    const gitBranch = entry['gitBranch']
    const createdAt = entry['createdAt']
    const sizeBytes = entry['sizeBytes']
    sessions.push({
      sessionId: SessionId(sessionId),
      origin: 'resumable',
      host: context.host,
      sourceId: context.sourceId,
      ...cwdFields(entry['cwd']),
      lastActivityAt: typeof lastModified === 'number' ? lastModified : generatedAt,
      sendable: false,
      resumable: true,
      fidelity: 'probe',
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof gitBranch === 'string' ? { gitBranch } : {}),
      ...(typeof createdAt === 'number' ? { createdAt } : {}),
      ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
    })
  }

  return { sessions, warnings, generatedAt, cached: false }
}
